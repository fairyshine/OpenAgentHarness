import type { ChatMessage, Message, ModelGenerateResponse, Run, Session } from "@oah/api-contracts";

import { assistantContentFromModelOutput } from "../execution-message-content.js";
import type { ModelStepResult, SessionRepository, WorkspaceRecord } from "../types.js";

type AssistantMessage = Extract<Message, { role: "assistant" }>;

export interface RunFinalizationServiceDependencies {
  sessionRepository: SessionRepository;
  getRun: (runId: string) => Promise<Run>;
  ensureAssistantMessage: (
    session: Session,
    run: Run,
    currentMessage: AssistantMessage | undefined,
    allMessages?: Message[],
    content?: string,
    metadata?: Record<string, unknown> | undefined
  ) => Promise<AssistantMessage>;
  updateAssistantMessage: (
    message: AssistantMessage,
    content: AssistantMessage["content"]
  ) => Promise<AssistantMessage>;
  appendEvent: (input: {
    sessionId: string;
    runId: string;
    event: "message.completed" | "run.completed" | "run.failed";
    data: Record<string, unknown>;
  }) => Promise<unknown>;
  setRunStatus: (run: Run, nextStatus: Run["status"], patch: Partial<Run>) => Promise<Run>;
  markRunTimedOut: (run: Run, runTimeoutMs: number | undefined) => Promise<Run>;
  markRunCancelled: (sessionId: string, run: Run) => Promise<void>;
  recordSystemStep: (run: Run, name: string, output?: Record<string, unknown>) => Promise<unknown>;
  runLifecycleHooks: (
    workspace: WorkspaceRecord,
    session: Session | undefined,
    run: Run,
    eventName: "run_completed" | "run_failed"
  ) => Promise<void>;
  dispatchNextQueuedRun: (sessionId: string) => Promise<string | undefined>;
  buildGeneratedMessageMetadata: (
    workspace: WorkspaceRecord,
    agentName: string,
    modelInput: { messages: ChatMessage[] },
    modelCallStep?: { id: string; seq: number } | undefined
  ) => Record<string, unknown>;
  nowIso: () => string;
}

export class RunFinalizationService {
  readonly #sessionRepository: SessionRepository;
  readonly #getRun: RunFinalizationServiceDependencies["getRun"];
  readonly #ensureAssistantMessage: RunFinalizationServiceDependencies["ensureAssistantMessage"];
  readonly #updateAssistantMessage: RunFinalizationServiceDependencies["updateAssistantMessage"];
  readonly #appendEvent: RunFinalizationServiceDependencies["appendEvent"];
  readonly #setRunStatus: RunFinalizationServiceDependencies["setRunStatus"];
  readonly #markRunTimedOut: RunFinalizationServiceDependencies["markRunTimedOut"];
  readonly #markRunCancelled: RunFinalizationServiceDependencies["markRunCancelled"];
  readonly #recordSystemStep: RunFinalizationServiceDependencies["recordSystemStep"];
  readonly #runLifecycleHooks: RunFinalizationServiceDependencies["runLifecycleHooks"];
  readonly #dispatchNextQueuedRun: RunFinalizationServiceDependencies["dispatchNextQueuedRun"];
  readonly #buildGeneratedMessageMetadata: RunFinalizationServiceDependencies["buildGeneratedMessageMetadata"];
  readonly #nowIso: RunFinalizationServiceDependencies["nowIso"];

  constructor(dependencies: RunFinalizationServiceDependencies) {
    this.#sessionRepository = dependencies.sessionRepository;
    this.#getRun = dependencies.getRun;
    this.#ensureAssistantMessage = dependencies.ensureAssistantMessage;
    this.#updateAssistantMessage = dependencies.updateAssistantMessage;
    this.#appendEvent = dependencies.appendEvent;
    this.#setRunStatus = dependencies.setRunStatus;
    this.#markRunTimedOut = dependencies.markRunTimedOut;
    this.#markRunCancelled = dependencies.markRunCancelled;
    this.#recordSystemStep = dependencies.recordSystemStep;
    this.#runLifecycleHooks = dependencies.runLifecycleHooks;
    this.#dispatchNextQueuedRun = dependencies.dispatchNextQueuedRun;
    this.#buildGeneratedMessageMetadata = dependencies.buildGeneratedMessageMetadata;
    this.#nowIso = dependencies.nowIso;
  }

  async finalizeSuccessfulRun(input: {
    workspace: WorkspaceRecord;
    session: Session;
    run: Run;
    assistantMessage: AssistantMessage | undefined;
    completed: ModelGenerateResponse;
    finalAssistantStep: ModelStepResult | undefined;
    messageMetadata?: Record<string, unknown> | undefined;
  }): Promise<void> {
    const finalizedAssistantContent = assistantContentFromModelOutput({
      text: input.completed.text,
      content: Array.isArray(input.completed.content) ? input.completed.content : input.finalAssistantStep?.content,
      reasoning: Array.isArray(input.completed.reasoning) ? input.completed.reasoning : input.finalAssistantStep?.reasoning
    });
    const latestRun = await this.#getRun(input.run.id);
    const persistedAssistantMessage = await this.#ensureAssistantMessage(
      input.session,
      latestRun,
      input.assistantMessage,
      undefined,
      typeof finalizedAssistantContent === "string" ? finalizedAssistantContent : input.completed.text,
      input.messageMetadata ?? this.#buildGeneratedMessageMetadata(input.workspace, latestRun.effectiveAgentName, { messages: [] })
    );
    const updatedMessage =
      JSON.stringify(persistedAssistantMessage.content) === JSON.stringify(finalizedAssistantContent)
        ? persistedAssistantMessage
        : await this.#updateAssistantMessage(persistedAssistantMessage, finalizedAssistantContent);

    await this.#appendEvent({
      sessionId: input.session.id,
      runId: input.run.id,
      event: "message.completed",
      data: {
        runId: input.run.id,
        messageId: updatedMessage.id,
        content: updatedMessage.content,
        finishReason: input.completed.finishReason ?? "stop",
        ...(updatedMessage.metadata ? { metadata: updatedMessage.metadata } : {})
      }
    });

    const endedAt = this.#nowIso();
    const updatedRun = await this.#setRunStatus(latestRun, "completed", {
      endedAt
    });
    await this.#recordSystemStep(updatedRun, "run.completed", {
      status: updatedRun.status
    });

    await this.#sessionRepository.update({
      ...input.session,
      activeAgentName: updatedRun.effectiveAgentName,
      lastRunAt: endedAt,
      updatedAt: endedAt
    });

    await this.#appendEvent({
      sessionId: input.session.id,
      runId: updatedRun.id,
      event: "run.completed",
      data: {
        runId: updatedRun.id,
        sessionId: input.session.id,
        status: updatedRun.status
      }
    });

    await this.#runLifecycleHooks(input.workspace, input.session, updatedRun, "run_completed");
    await this.#dispatchNextQueuedRun(input.session.id);
  }

  async finalizeTimedOutRun(input: {
    workspace: WorkspaceRecord;
    session: Session | undefined;
    runId: string;
    runTimeoutMs: number | undefined;
  }): Promise<void> {
    const timedOutRun = await this.#markRunTimedOut(await this.#getRun(input.runId), input.runTimeoutMs);
    if (input.session) {
      await this.#appendEvent({
        sessionId: input.session.id,
        runId: timedOutRun.id,
        event: "run.failed",
        data: {
          runId: timedOutRun.id,
          sessionId: input.session.id,
          status: timedOutRun.status,
          errorCode: timedOutRun.errorCode ?? "run_timed_out",
          errorMessage: timedOutRun.errorMessage ?? "Run exceeded the configured timeout."
        }
      });
    }
    await this.#recordSystemStep(timedOutRun, "run.timed_out", {
      status: timedOutRun.status,
      ...(timedOutRun.errorCode ? { errorCode: timedOutRun.errorCode } : {}),
      ...(timedOutRun.errorMessage ? { errorMessage: timedOutRun.errorMessage } : {})
    });
    await this.#runLifecycleHooks(input.workspace, input.session, timedOutRun, "run_failed");
    if (timedOutRun.sessionId) {
      await this.#dispatchNextQueuedRun(timedOutRun.sessionId);
    }
  }

  async finalizeCancelledRun(input: {
    session: Session | undefined;
    runId: string;
  }): Promise<void> {
    if (input.session) {
      await this.#markRunCancelled(input.session.id, await this.#getRun(input.runId));
      await this.#dispatchNextQueuedRun(input.session.id);
      return;
    }

    const cancelledRun = await this.#setRunStatus(await this.#getRun(input.runId), "cancelled", {
      endedAt: this.#nowIso(),
      cancelRequestedAt: this.#nowIso()
    });
    await this.#recordSystemStep(cancelledRun, "run.cancelled", {
      status: cancelledRun.status
    });
    if (cancelledRun.sessionId) {
      await this.#dispatchNextQueuedRun(cancelledRun.sessionId);
    }
  }

  async finalizeFailedRun(input: {
    workspace: WorkspaceRecord;
    session: Session | undefined;
    runId: string;
    errorCode: string;
    errorMessage: string;
  }): Promise<Run> {
    const currentRun = await this.#getRun(input.runId);
    const failedRun =
      currentRun.status === "failed" || currentRun.status === "timed_out"
        ? currentRun
        : await this.#setRunStatus(currentRun, "failed", {
            endedAt: this.#nowIso(),
            errorCode: input.errorCode,
            errorMessage: input.errorMessage
          });

    if (input.session) {
      await this.#appendEvent({
        sessionId: input.session.id,
        runId: failedRun.id,
        event: "run.failed",
        data: {
          runId: failedRun.id,
          sessionId: input.session.id,
          status: failedRun.status,
          errorCode: failedRun.errorCode ?? input.errorCode,
          errorMessage: failedRun.errorMessage ?? input.errorMessage
        }
      });
    }

    await this.#recordSystemStep(failedRun, failedRun.status === "timed_out" ? "run.timed_out" : "run.failed", {
      status: failedRun.status,
      ...(failedRun.errorCode ? { errorCode: failedRun.errorCode } : {}),
      ...(failedRun.errorMessage ? { errorMessage: failedRun.errorMessage } : {})
    });

    await this.#runLifecycleHooks(input.workspace, input.session, failedRun, "run_failed");
    if (failedRun.sessionId) {
      await this.#dispatchNextQueuedRun(failedRun.sessionId);
    }
    return failedRun;
  }
}
