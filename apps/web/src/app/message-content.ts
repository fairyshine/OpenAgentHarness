import type { Message, MessageContent } from "@oah/api-contracts";

import { isRecord, prettyJson } from "./support-core";
import type {
  AgentMode,
  AssistantMessageContent,
  MessageAgentSnapshot,
  MessagePart,
  SystemMessageContent,
  ToolMessageContent,
  UserMessageContent
} from "./support-types";
import type { ModelCallTraceMessage } from "./model-call-trace-types";

function isAgentMode(value: unknown): value is AgentMode {
  return value === "primary" || value === "subagent" || value === "all";
}

function readMessageAgentSnapshot(message: Pick<Message, "metadata">): MessageAgentSnapshot | null {
  if (!message.metadata || !isRecord(message.metadata)) {
    return null;
  }

  const metadata = message.metadata;
  const name =
    typeof metadata.agentName === "string" && metadata.agentName.trim()
      ? metadata.agentName
      : typeof metadata.effectiveAgentName === "string" && metadata.effectiveAgentName.trim()
        ? metadata.effectiveAgentName
        : undefined;
  const mode = isAgentMode(metadata.agentMode) ? metadata.agentMode : undefined;

  if (!name && !mode) {
    return null;
  }

  return {
    ...(name ? { name } : {}),
    ...(mode ? { mode } : {})
  };
}

function readMessageSystemPromptSnapshot(message: Pick<Message, "metadata">): ModelCallTraceMessage[] {
  if (!message.metadata || !isRecord(message.metadata) || !Array.isArray(message.metadata.systemMessages)) {
    return [];
  }

  return message.metadata.systemMessages.flatMap((entry) => {
    if (isRecord(entry) && entry.role === "system" && typeof entry.content === "string") {
      return [
        {
          role: "system" as const,
          content: entry.content
        }
      ];
    }

    return [];
  });
}

function readMessageModelCallStepRef(message: Pick<Message, "metadata">): { stepId?: string; stepSeq?: number } | null {
  if (!message.metadata || !isRecord(message.metadata)) {
    return null;
  }

  const stepId =
    typeof message.metadata.modelCallStepId === "string" && message.metadata.modelCallStepId.trim()
      ? message.metadata.modelCallStepId
      : undefined;
  const stepSeq =
    typeof message.metadata.modelCallStepSeq === "number" && Number.isInteger(message.metadata.modelCallStepSeq)
      ? message.metadata.modelCallStepSeq
      : undefined;

  if (!stepId && stepSeq === undefined) {
    return null;
  }

  return {
    ...(stepId ? { stepId } : {}),
    ...(stepSeq !== undefined ? { stepSeq } : {})
  };
}

function isMessagePart(value: unknown): value is MessagePart {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "text":
      return typeof value.text === "string";
    case "image":
      return typeof value.image === "string";
    case "file":
      return typeof value.data === "string" && typeof value.mediaType === "string";
    case "reasoning":
      return typeof value.text === "string";
    case "tool-call":
      return typeof value.toolCallId === "string" && typeof value.toolName === "string";
    case "tool-result":
      return (
        typeof value.toolCallId === "string" &&
        typeof value.toolName === "string" &&
        isRecord(value.output) &&
        typeof value.output.type === "string"
      );
    case "tool-approval-request":
      return typeof value.approvalId === "string" && typeof value.toolCallId === "string";
    case "tool-approval-response":
      return typeof value.approvalId === "string" && typeof value.approved === "boolean";
    default:
      return false;
  }
}

function normalizeMessageContent(value: unknown): MessageContent | null {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value) && value.every((entry) => isMessagePart(entry))) {
    return value as MessageContent;
  }

  return null;
}

function contentMatchesRole(role: Message["role"], content: MessageContent): boolean {
  if (role === "system") {
    return typeof content === "string";
  }

  if (role === "user") {
    return (
      typeof content === "string" ||
      (Array.isArray(content) && content.every((part) => part.type === "text" || part.type === "image" || part.type === "file"))
    );
  }

  if (role === "assistant") {
    return (
      typeof content === "string" ||
      (Array.isArray(content) &&
        content.every(
          (part) =>
            part.type === "text" ||
            part.type === "file" ||
            part.type === "reasoning" ||
            part.type === "tool-call" ||
            part.type === "tool-result" ||
            part.type === "tool-approval-request"
        ))
    );
  }

  return (
    Array.isArray(content) &&
    content.every((part) => part.type === "tool-result" || part.type === "tool-approval-response")
  );
}

function buildMessageRecord(input: {
  id: string;
  sessionId: string;
  role: Message["role"];
  content: MessageContent;
  runId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}): Message | null {
  if (!contentMatchesRole(input.role, input.content)) {
    return null;
  }

  const base = {
    id: input.id,
    sessionId: input.sessionId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    createdAt: input.createdAt
  };

  switch (input.role) {
    case "system":
      return {
        ...base,
        role: "system",
        content: input.content as SystemMessageContent
      };
    case "user":
      return {
        ...base,
        role: "user",
        content: input.content as UserMessageContent
      };
    case "assistant":
      return {
        ...base,
        role: "assistant",
        content: input.content as AssistantMessageContent
      };
    case "tool":
      return {
        ...base,
        role: "tool",
        content: input.content as ToolMessageContent
      };
  }
}

function contentParts(content: Message["content"]): MessagePart[] {
  return Array.isArray(content) ? content : [];
}

function contentText(content: Message["content"]) {
  if (typeof content === "string") {
    return content;
  }

  return content
    .flatMap((part) => {
      if (part.type === "text" || part.type === "reasoning") {
        return [part.text];
      }

      if (
        part.type === "tool-result" &&
        isRecord(part.output) &&
        (part.output.type === "text" || part.output.type === "error-text") &&
        typeof part.output.value === "string"
      ) {
        return [part.output.value];
      }

      return [];
    })
    .join("\n\n");
}

function contentToolRefs(content: Message["content"]) {
  return contentParts(content).flatMap((part) => {
    if (part.type === "tool-call" || part.type === "tool-result") {
      return [
        {
          type: part.type,
          toolName: part.toolName,
          toolCallId: part.toolCallId
        }
      ];
    }

    return [];
  });
}

function contentPreview(content: Message["content"], limit = 120) {
  const text = contentText(content).trim();
  if (text.length > 0) {
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  }

  const refs = contentToolRefs(content);
  if (refs.length > 0) {
    return refs.map((ref) => `${ref.type}:${ref.toolName}`).join(" · ");
  }

  return prettyJson(content);
}

function hasDisplayableRunMessages(messages: Message[], runId: string) {
  return messages.some((message) => {
    if (message.runId !== runId) {
      return false;
    }

    return contentText(message.content).trim().length > 0 || contentToolRefs(message.content).length > 0;
  });
}

export {
  buildMessageRecord,
  contentPreview,
  contentText,
  contentToolRefs,
  hasDisplayableRunMessages,
  normalizeMessageContent,
  readMessageAgentSnapshot,
  readMessageModelCallStepRef,
  readMessageSystemPromptSnapshot
};
