import type { Message, Run, Session } from "@oah/api-contracts";

import { textContent, toolCallContent, toolErrorResultContent, toolResultContent } from "../runtime-message-content.js";
import type { MessageRepository, RuntimeLogger, SessionEvent } from "../types.js";
import type { ModelStepResult } from "../types.js";
import type { ToolErrorContentPart } from "./model-call-serialization.js";

export interface ToolMessageServiceDependencies {
  messageRepository: MessageRepository;
  logger?: RuntimeLogger | undefined;
  appendEvent: (input: Omit<SessionEvent, "id" | "cursor" | "createdAt">) => Promise<SessionEvent>;
  createId: (prefix: string) => string;
  nowIso: () => string;
  previewValue: (value: unknown, maxLength?: number) => string;
}

export class ToolMessageService {
  readonly #messageRepository: MessageRepository;
  readonly #logger?: RuntimeLogger | undefined;
  readonly #appendEvent: ToolMessageServiceDependencies["appendEvent"];
  readonly #createId: ToolMessageServiceDependencies["createId"];
  readonly #nowIso: ToolMessageServiceDependencies["nowIso"];
  readonly #previewValue: ToolMessageServiceDependencies["previewValue"];

  constructor(dependencies: ToolMessageServiceDependencies) {
    this.#messageRepository = dependencies.messageRepository;
    this.#logger = dependencies.logger;
    this.#appendEvent = dependencies.appendEvent;
    this.#createId = dependencies.createId;
    this.#nowIso = dependencies.nowIso;
    this.#previewValue = dependencies.previewValue;
  }

  async ensureAssistantMessage(
    session: Session,
    run: Run,
    currentMessage: Extract<Message, { role: "assistant" }> | undefined,
    allMessages?: Message[],
    content = "",
    metadata?: Record<string, unknown> | undefined
  ): Promise<Extract<Message, { role: "assistant" }>> {
    if (currentMessage) {
      return currentMessage;
    }

    const message = (await this.#messageRepository.create({
      id: this.#createId("msg"),
      sessionId: session.id,
      runId: run.id,
      role: "assistant",
      content: textContent(content),
      ...(metadata ? { metadata } : {}),
      createdAt: this.#nowIso()
    })) as Extract<Message, { role: "assistant" }>;

    allMessages?.push(message);
    return message;
  }

  async persistAssistantToolCalls(
    session: Session,
    run: Run,
    step: ModelStepResult,
    allMessages: Message[],
    metadata?: Record<string, unknown> | undefined
  ): Promise<void> {
    if (step.toolCalls.length === 0) {
      return;
    }

    this.#logger?.debug?.("Persisting assistant tool-call message.", {
      sessionId: session.id,
      runId: run.id,
      toolCallIds: step.toolCalls.map((toolCall) => toolCall.toolCallId),
      toolNames: step.toolCalls.map((toolCall) => toolCall.toolName)
    });

    const assistantToolCallMessage = await this.#messageRepository.create({
      id: this.#createId("msg"),
      sessionId: session.id,
      runId: run.id,
      role: "assistant",
      content: toolCallContent(step.toolCalls),
      ...(metadata ? { metadata } : {}),
      createdAt: this.#nowIso()
    });

    allMessages.push(assistantToolCallMessage);
    await this.#appendEvent({
      sessionId: session.id,
      runId: run.id,
      event: "message.completed",
      data: {
        runId: run.id,
        messageId: assistantToolCallMessage.id,
        content: assistantToolCallMessage.content
      }
    });
  }

  async persistToolResults(
    session: Session,
    run: Run,
    step: ModelStepResult,
    failedToolResults: ToolErrorContentPart[],
    persistedToolCalls: Set<string>,
    allMessages: Message[],
    metadata?: Record<string, unknown> | undefined
  ): Promise<void> {
    for (const toolResult of step.toolResults) {
      if (persistedToolCalls.has(toolResult.toolCallId)) {
        continue;
      }

      persistedToolCalls.add(toolResult.toolCallId);
      this.#logger?.debug?.("Persisting tool result message.", {
        sessionId: session.id,
        runId: run.id,
        toolCallId: toolResult.toolCallId,
        toolName: toolResult.toolName,
        resultType: "success",
        outputPreview: this.#previewValue(toolResult.output)
      });
      const toolMessage = await this.#messageRepository.create({
        id: this.#createId("msg"),
        sessionId: session.id,
        runId: run.id,
        role: "tool",
        content: toolResultContent(toolResult),
        ...(metadata ? { metadata } : {}),
        createdAt: this.#nowIso()
      });
      allMessages.push(toolMessage);

      await this.#appendEvent({
        sessionId: session.id,
        runId: run.id,
        event: "message.completed",
        data: {
          runId: run.id,
          messageId: toolMessage.id,
          content: toolMessage.content,
          toolName: toolResult.toolName,
          toolCallId: toolResult.toolCallId
        }
      });
    }

    for (const toolError of failedToolResults) {
      if (persistedToolCalls.has(toolError.toolCallId)) {
        continue;
      }

      persistedToolCalls.add(toolError.toolCallId);
      this.#logger?.debug?.("Persisting failed tool result message.", {
        sessionId: session.id,
        runId: run.id,
        toolCallId: toolError.toolCallId,
        toolName: toolError.toolName,
        resultType: "error",
        errorPreview: this.#previewValue(toolError.error)
      });
      const toolMessage = await this.#messageRepository.create({
        id: this.#createId("msg"),
        sessionId: session.id,
        runId: run.id,
        role: "tool",
        content: toolErrorResultContent(toolError),
        ...(metadata ? { metadata } : {}),
        createdAt: this.#nowIso()
      });
      allMessages.push(toolMessage);

      await this.#appendEvent({
        sessionId: session.id,
        runId: run.id,
        event: "message.completed",
        data: {
          runId: run.id,
          messageId: toolMessage.id,
          content: toolMessage.content,
          toolName: toolError.toolName,
          toolCallId: toolError.toolCallId,
          resultType: "error"
        }
      });
    }
  }

  async persistStandaloneToolResultMessage(input: {
    session: Session;
    run: Run;
    toolCallId: string;
    toolName: string;
    output: unknown;
    actionName?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
  }): Promise<Message> {
    const toolMessage = await this.#messageRepository.create({
      id: this.#createId("msg"),
      sessionId: input.session.id,
      runId: input.run.id,
      role: "tool",
      content: toolResultContent({
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        output: input.output
      }),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      createdAt: this.#nowIso()
    });

    await this.#appendEvent({
      sessionId: input.session.id,
      runId: input.run.id,
      event: "message.completed",
      data: {
        runId: input.run.id,
        messageId: toolMessage.id,
        content: toolMessage.content,
        ...(input.actionName ? { actionName: input.actionName } : {}),
        toolCallId: input.toolCallId,
        toolName: input.toolName
      }
    });

    return toolMessage;
  }
}
