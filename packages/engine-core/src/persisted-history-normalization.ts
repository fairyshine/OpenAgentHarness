import type { ChatMessage, Message, RunStep } from "@oah/api-contracts";

import { isMessageContentForRole, isStructuredToolResultOutput, normalizeToolResultOutput } from "./execution-message-content.js";
import { compactModelCallRequestSnapshot } from "./engine/model-call-serialization.js";

type MessagePart = Extract<Message["content"], unknown[]>[number];
type ToolCallMessagePart = Extract<MessagePart, { type: "tool-call" }>;
type ToolResultMessagePart = Extract<MessagePart, { type: "tool-result" }>;

const MISSING_TOOL_RESULT_TEXT =
  "Tool result unavailable because the original run ended before this tool call result was recorded.";

const MODEL_CALL_RUNTIME_INPUT_KEYS = new Set([
  "messageCount",
  "engineToolNames",
  "engineTools",
  "activeToolNames",
  "toolServers"
]);

const MODEL_CALL_RUNTIME_OUTPUT_KEYS = new Set(["toolCallsCount", "toolResultsCount", "toolErrorsCount"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolCallMessagePart(value: unknown): value is ToolCallMessagePart {
  return (
    isRecord(value) &&
    value.type === "tool-call" &&
    typeof value.toolCallId === "string" &&
    typeof value.toolName === "string"
  );
}

function isToolResultMessagePart(value: unknown): value is ToolResultMessagePart {
  return (
    isRecord(value) &&
    value.type === "tool-result" &&
    typeof value.toolCallId === "string" &&
    typeof value.toolName === "string" &&
    "output" in value
  );
}

function normalizeMessageContentParts(content: unknown): { content: unknown; changed: boolean } {
  if (!Array.isArray(content)) {
    return { content, changed: false };
  }

  let changed = false;
  const normalized = content.map((part) => {
    if (!isToolResultMessagePart(part) || isStructuredToolResultOutput(part.output)) {
      return part;
    }

    changed = true;
    return {
      ...part,
      output: normalizeToolResultOutput(part.output)
    };
  });

  return {
    content: changed ? normalized : content,
    changed
  };
}

function normalizeChatMessages(messages: unknown): { messages: unknown; changed: boolean } {
  if (!Array.isArray(messages)) {
    return { messages, changed: false };
  }

  let changed = false;
  const normalized = messages.map((message) => {
    if (!isRecord(message) || typeof message.role !== "string") {
      return message;
    }

    const normalizedContent = normalizeMessageContentParts(message.content);
    if (!normalizedContent.changed) {
      return message;
    }

    changed = true;
    return {
      ...message,
      content: normalizedContent.content
    };
  });

  return {
    messages: changed ? normalized : messages,
    changed
  };
}

export function normalizePersistedMessageRecord(message: Message): { message: Message; changed: boolean } {
  const normalizedContent = normalizeMessageContentParts(message.content);
  if (!normalizedContent.changed) {
    return { message, changed: false };
  }

  switch (message.role) {
    case "system":
      if (isMessageContentForRole("system", normalizedContent.content)) {
        return {
          message: {
            ...message,
            content: normalizedContent.content
          },
          changed: true
        };
      }
      break;
    case "user":
      if (isMessageContentForRole("user", normalizedContent.content)) {
        return {
          message: {
            ...message,
            content: normalizedContent.content
          },
          changed: true
        };
      }
      break;
    case "assistant":
      if (isMessageContentForRole("assistant", normalizedContent.content)) {
        return {
          message: {
            ...message,
            content: normalizedContent.content
          },
          changed: true
        };
      }
      break;
    case "tool":
      if (isMessageContentForRole("tool", normalizedContent.content)) {
        return {
          message: {
            ...message,
            content: normalizedContent.content
          },
          changed: true
        };
      }
      break;
  }

  return { message, changed: false };
}

function buildSyntheticToolMessage(anchor: Message, toolCalls: ToolCallMessagePart[], nextMessage?: Message): Message {
  const afterTime = Date.parse(anchor.createdAt);
  const beforeTime = nextMessage ? Date.parse(nextMessage.createdAt) : Number.NaN;
  const createdAt =
    Number.isFinite(afterTime) && Number.isFinite(beforeTime) && beforeTime > afterTime + 1
      ? new Date(afterTime + 1).toISOString()
      : anchor.createdAt;

  return {
    id: `${anchor.id}~missing-tool-result`,
    sessionId: anchor.sessionId,
    ...(anchor.runId ? { runId: anchor.runId } : {}),
    role: "tool",
    content: toolCalls.map((toolCall) => ({
      type: "tool-result" as const,
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      output: {
        type: "text" as const,
        value: MISSING_TOOL_RESULT_TEXT
      }
    })),
    createdAt
  };
}

export function normalizePersistedMessages(messages: Message[]): { messages: Message[]; changed: boolean } {
  const result: Message[] = [];
  let changed = false;
  let pendingToolCalls = new Map<string, ToolCallMessagePart>();
  let pendingAnchor: Message | null = null;
  const persistedToolResultIds = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      continue;
    }

    for (const part of message.content) {
      if (isToolResultMessagePart(part)) {
        persistedToolResultIds.add(part.toolCallId);
      }
    }
  }

  const flushPendingToolCalls = (nextMessage?: Message) => {
    if (pendingToolCalls.size === 0 || pendingAnchor === null) {
      return;
    }

    const missingToolCalls = [...pendingToolCalls.values()].filter(
      (toolCall) => !persistedToolResultIds.has(toolCall.toolCallId)
    );
    if (missingToolCalls.length > 0) {
      result.push(buildSyntheticToolMessage(pendingAnchor, missingToolCalls, nextMessage));
    }
    pendingToolCalls = new Map<string, ToolCallMessagePart>();
    pendingAnchor = null;
    changed ||= missingToolCalls.length > 0;
  };

  for (const message of messages) {
    const normalized = normalizePersistedMessageRecord(message);
    const normalizedMessage = normalized.message;
    changed ||= normalized.changed;

    if (normalizedMessage.role === "tool" && Array.isArray(normalizedMessage.content)) {
      result.push(normalizedMessage);
      for (const part of normalizedMessage.content) {
        if (part.type === "tool-result") {
          pendingToolCalls.delete(part.toolCallId);
        }
      }
      if (pendingToolCalls.size === 0) {
        pendingAnchor = null;
      }
      continue;
    }

    const toolCalls =
      normalizedMessage.role === "assistant" && Array.isArray(normalizedMessage.content)
        ? normalizedMessage.content.filter(isToolCallMessagePart)
        : [];
    if (toolCalls.length === 0) {
      flushPendingToolCalls(normalizedMessage);
      result.push(normalizedMessage);
      continue;
    }

    result.push(normalizedMessage);
    for (const toolCall of toolCalls) {
      pendingToolCalls.set(toolCall.toolCallId, toolCall);
    }
    pendingAnchor ??= normalizedMessage;
  }

  flushPendingToolCalls();

  return {
    messages: changed ? result : messages,
    changed
  };
}

function normalizeModelCallInput(input: unknown): { input: unknown; changed: boolean } {
  if (!isRecord(input)) {
    return { input, changed: false };
  }

  let changed = false;
  let request = isRecord(input.request) ? { ...input.request } : undefined;
  let runtime = isRecord(input.runtime) ? { ...input.runtime } : undefined;

  if (!request || !runtime) {
    request = {};
    runtime = {};
    for (const [key, value] of Object.entries(input)) {
      if (MODEL_CALL_RUNTIME_INPUT_KEYS.has(key)) {
        runtime[key] = value;
      } else {
        request[key] = value;
      }
    }
    changed = true;
  }

  const normalizedMessages = normalizeChatMessages(request.messages);
  if (normalizedMessages.changed) {
    request.messages = normalizedMessages.messages as ChatMessage[];
    changed = true;
  }
  if (Array.isArray(request.messages)) {
    const compactedRequest = compactModelCallRequestSnapshot(request, request.messages as ChatMessage[]);
    if (compactedRequest !== request) {
      request = compactedRequest;
      changed = true;
    }
  }

  return {
    input: {
      request,
      runtime
    },
    changed
  };
}

function normalizeModelCallOutput(output: unknown): { output: unknown; changed: boolean } {
  if (!isRecord(output)) {
    return { output, changed: false };
  }

  let changed = false;
  let response = isRecord(output.response) ? { ...output.response } : undefined;
  let runtime = isRecord(output.runtime) ? { ...output.runtime } : undefined;

  if (!response || !runtime) {
    response = {};
    runtime = {};
    for (const [key, value] of Object.entries(output)) {
      if (MODEL_CALL_RUNTIME_OUTPUT_KEYS.has(key)) {
        runtime[key] = value;
      } else {
        response[key] = value;
      }
    }
    changed = true;
  }

  if (Array.isArray(response.toolResults)) {
    let toolResultsChanged = false;
    const toolResults = response.toolResults.map((entry) => {
      if (!isRecord(entry) || !("output" in entry) || isStructuredToolResultOutput(entry.output)) {
        return entry;
      }

      toolResultsChanged = true;
      return {
        ...entry,
        output: normalizeToolResultOutput(entry.output)
      };
    });

    if (toolResultsChanged) {
      response.toolResults = toolResults;
      changed = true;
    }
  }

  return {
    output: {
      response,
      runtime
    },
    changed
  };
}

export function normalizePersistedRunStep(step: RunStep): { step: RunStep; changed: boolean } {
  if (step.stepType !== "model_call") {
    return { step, changed: false };
  }

  const normalizedInput = normalizeModelCallInput(step.input);
  const normalizedOutput = normalizeModelCallOutput(step.output);

  if (!normalizedInput.changed && !normalizedOutput.changed) {
    return { step, changed: false };
  }

  return {
    step: {
      ...step,
      ...(normalizedInput.input !== undefined ? { input: normalizedInput.input } : {}),
      ...(normalizedOutput.output !== undefined ? { output: normalizedOutput.output } : {})
    },
    changed: true
  };
}
