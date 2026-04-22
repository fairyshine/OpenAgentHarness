import type { ChatMessage, Message } from "@oah/api-contracts";

type MessageContent = Message["content"];
type MessageParts = Extract<Message["content"], unknown[]>;
type MessagePart = MessageParts[number];
type SystemMessageContent = Extract<Message, { role: "system" }>["content"];
type UserMessageContent = Extract<Message, { role: "user" }>["content"];
type AssistantMessageContent = Extract<Message, { role: "assistant" }>["content"];
type ToolMessageContent = Extract<Message, { role: "tool" }>["content"];
type AssistantMessagePart = Extract<AssistantMessageContent, unknown[]>[number];
type ToolCallMessagePart = Extract<MessagePart, { type: "tool-call" }>;
type ToolResultMessagePart = Extract<MessagePart, { type: "tool-result" }>;
type ToolResultOutput = ToolResultMessagePart["output"];

function isTextMessagePart(part: MessagePart): part is Extract<MessagePart, { type: "text" }> {
  return part.type === "text";
}

function isImageMessagePart(value: unknown): boolean {
  return isJsonObject(value) && value.type === "image" && typeof value.image === "string";
}

function isFileMessagePart(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    value.type === "file" &&
    typeof value.data === "string" &&
    typeof value.mediaType === "string"
  );
}

function isReasoningMessagePart(value: unknown): boolean {
  return isJsonObject(value) && value.type === "reasoning" && typeof value.text === "string";
}

function isToolCallMessagePart(value: unknown): value is ToolCallMessagePart {
  return (
    isJsonObject(value) &&
    value.type === "tool-call" &&
    typeof value.toolCallId === "string" &&
    typeof value.toolName === "string"
  );
}

function isToolResultMessagePart(value: unknown): value is ToolResultMessagePart {
  return (
    isJsonObject(value) &&
    value.type === "tool-result" &&
    typeof value.toolCallId === "string" &&
    typeof value.toolName === "string" &&
    isStructuredToolResultOutput(value.output)
  );
}

function isToolApprovalRequestMessagePart(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    value.type === "tool-approval-request" &&
    typeof value.approvalId === "string" &&
    typeof value.toolCallId === "string"
  );
}

function isToolApprovalResponseMessagePart(value: unknown): boolean {
  return isJsonObject(value) && value.type === "tool-approval-response" && typeof value.approvalId === "string" && typeof value.approved === "boolean";
}

function normalizeAssistantMessagePart(value: unknown): AssistantMessagePart | null {
  if (isJsonObject(value) && value.type === "text" && typeof value.text === "string") {
    return value as Extract<MessagePart, { type: "text" }>;
  }

  if (isFileMessagePart(value)) {
    return value as Extract<MessagePart, { type: "file" }>;
  }

  if (isReasoningMessagePart(value)) {
    return value as Extract<MessagePart, { type: "reasoning" }>;
  }

  if (isToolCallMessagePart(value)) {
    return value;
  }

  if (isToolResultMessagePart(value)) {
    return value;
  }

  if (isToolApprovalRequestMessagePart(value)) {
    return value as Extract<MessagePart, { type: "tool-approval-request" }>;
  }

  return null;
}

function normalizeNarrativeAssistantMessagePart(value: unknown): AssistantMessagePart | null {
  if (isJsonObject(value) && value.type === "text" && typeof value.text === "string") {
    return value as Extract<MessagePart, { type: "text" }>;
  }

  if (isFileMessagePart(value)) {
    return value as Extract<MessagePart, { type: "file" }>;
  }

  if (isReasoningMessagePart(value)) {
    return value as Extract<MessagePart, { type: "reasoning" }>;
  }

  return null;
}

export function isMessageRole(value: unknown): value is Message["role"] {
  return value === "system" || value === "user" || value === "assistant" || value === "tool";
}

export function isMessagePartList(value: unknown): value is MessagePart[] {
  if (!Array.isArray(value)) {
    return false;
  }

  return value.every((part) => {
    if (typeof part !== "object" || part === null || typeof (part as { type?: unknown }).type !== "string") {
      return false;
    }

    switch ((part as { type: string }).type) {
      case "text":
        return isTextMessagePart(part as MessagePart);
      case "image":
        return isImageMessagePart(part);
      case "file":
        return isFileMessagePart(part);
      case "reasoning":
        return isReasoningMessagePart(part);
      case "tool-call":
        return isToolCallMessagePart(part);
      case "tool-result":
        return isToolResultMessagePart(part);
      case "tool-approval-request":
        return isToolApprovalRequestMessagePart(part);
      case "tool-approval-response":
        return isToolApprovalResponseMessagePart(part);
      default:
        return false;
    }
  });
}

export function isMessageContentForRole<R extends Message["role"]>(
  role: R,
  content: unknown
): content is Extract<Message, { role: R }>["content"] {
  if (role === "system") {
    return typeof content === "string";
  }

  if (role === "user") {
    if (typeof content === "string") {
      return true;
    }

    return (
      Array.isArray(content) &&
      content.every((part) => isTextMessagePart(part as MessagePart) || isImageMessagePart(part) || isFileMessagePart(part))
    );
  }

  if (role === "assistant") {
    if (typeof content === "string") {
      return true;
    }

    return (
      Array.isArray(content) &&
      content.every(
        (part) =>
          isTextMessagePart(part as MessagePart) ||
          isFileMessagePart(part) ||
          isReasoningMessagePart(part) ||
          isToolCallMessagePart(part) ||
          isToolResultMessagePart(part) ||
          isToolApprovalRequestMessagePart(part)
      )
    );
  }

  return (
    Array.isArray(content) && content.every((part) => isToolResultMessagePart(part) || isToolApprovalResponseMessagePart(part))
  );
}

export function textContent(text: string): string {
  return text;
}

export function assistantContentFromModelOutput(output: {
  text?: string | undefined;
  content?: unknown[] | undefined;
  reasoning?: unknown[] | undefined;
}): AssistantMessageContent {
  const parts: Extract<AssistantMessageContent, unknown[]> = [];
  const seenSerializedParts = new Set<string>();
  const pushPart = (part: AssistantMessagePart) => {
    const serialized = JSON.stringify(part);
    if (seenSerializedParts.has(serialized)) {
      return;
    }

    seenSerializedParts.add(serialized);
    parts.push(part);
  };

  for (const part of output.content ?? []) {
    const normalized = normalizeAssistantMessagePart(part);
    if (normalized) {
      pushPart(normalized);
    }
  }

  for (const part of output.reasoning ?? []) {
    if (isReasoningMessagePart(part)) {
      pushPart(part as AssistantMessagePart);
    }
  }

  const hasTextPart = parts.some((part) => part.type === "text" && part.text.length > 0);
  if (!hasTextPart && typeof output.text === "string" && output.text.length > 0) {
    pushPart({
      type: "text",
      text: output.text
    });
  }

  return parts.length > 0 ? parts : textContent(typeof output.text === "string" ? output.text : "");
}

export function assistantNarrativeContentFromModelOutput(output: {
  text?: string | undefined;
  content?: unknown[] | undefined;
  reasoning?: unknown[] | undefined;
}): AssistantMessageContent | undefined {
  const parts: Extract<AssistantMessageContent, unknown[]> = [];
  const seenSerializedParts = new Set<string>();
  const pushPart = (part: AssistantMessagePart) => {
    const serialized = JSON.stringify(part);
    if (seenSerializedParts.has(serialized)) {
      return;
    }

    seenSerializedParts.add(serialized);
    parts.push(part);
  };

  for (const part of output.content ?? []) {
    const normalized = normalizeNarrativeAssistantMessagePart(part);
    if (normalized) {
      pushPart(normalized);
    }
  }

  for (const part of output.reasoning ?? []) {
    if (isReasoningMessagePart(part)) {
      pushPart(part as AssistantMessagePart);
    }
  }

  const hasTextPart = parts.some((part) => part.type === "text" && part.text.length > 0);
  if (!hasTextPart && typeof output.text === "string" && output.text.length > 0) {
    pushPart({
      type: "text",
      text: output.text
    });
  }

  if (parts.length > 0) {
    return parts;
  }

  if (typeof output.text === "string" && output.text.length > 0) {
    return textContent(output.text);
  }

  return undefined;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTextToolResultOutput(value: unknown): value is Extract<ToolResultOutput, { type: "text" }> {
  return isJsonObject(value) && value.type === "text" && typeof value.value === "string";
}

function isJsonToolResultOutput(value: unknown): value is Extract<ToolResultOutput, { type: "json" }> {
  return isJsonObject(value) && value.type === "json" && "value" in value;
}

function isExecutionDeniedToolResultOutput(value: unknown): value is Extract<ToolResultOutput, { type: "execution-denied" }> {
  return (
    isJsonObject(value) &&
    value.type === "execution-denied" &&
    (value.reason === undefined || typeof value.reason === "string")
  );
}

function isErrorTextToolResultOutput(value: unknown): value is Extract<ToolResultOutput, { type: "error-text" }> {
  return isJsonObject(value) && value.type === "error-text" && typeof value.value === "string";
}

function isErrorJsonToolResultOutput(value: unknown): value is Extract<ToolResultOutput, { type: "error-json" }> {
  return isJsonObject(value) && value.type === "error-json" && "value" in value;
}

function isContentToolResultOutput(value: unknown): value is Extract<ToolResultOutput, { type: "content" }> {
  return isJsonObject(value) && value.type === "content" && Array.isArray(value.value);
}

export function isStructuredToolResultOutput(value: unknown): value is ToolResultOutput {
  return (
    isTextToolResultOutput(value) ||
    isJsonToolResultOutput(value) ||
    isExecutionDeniedToolResultOutput(value) ||
    isErrorTextToolResultOutput(value) ||
    isErrorJsonToolResultOutput(value) ||
    isContentToolResultOutput(value)
  );
}

export function normalizeToolResultOutput(output: unknown): ToolResultOutput {
  if (isStructuredToolResultOutput(output)) {
    return output;
  }

  if (typeof output === "string") {
    return {
      type: "text",
      value: output
    };
  }

  return {
    type: "json",
    value:
      isJsonObject(output) || Array.isArray(output) || typeof output === "number" || typeof output === "boolean" || output === null
        ? output
        : output ?? null
  };
}

export function normalizeToolErrorOutput(error: unknown): ToolResultOutput {
  if (isStructuredToolResultOutput(error)) {
    return error;
  }

  if (error instanceof Error) {
    return {
      type: "error-text",
      value: error.message
    };
  }

  if (typeof error === "string") {
    return {
      type: "error-text",
      value: error
    };
  }

  return {
    type: "error-json",
    value:
      isJsonObject(error) || Array.isArray(error) || typeof error === "number" || typeof error === "boolean" || error === null
        ? error
        : error ?? null
  };
}

export function toolCallContent(
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>
): Extract<AssistantMessageContent, unknown[]> {
  return toolCalls.map((toolCall) => ({
    type: "tool-call" as const,
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    input: toolCall.input ?? null
  }));
}

export function toolResultContent(toolResult: {
  toolCallId: string;
  toolName: string;
  output: unknown;
}): ToolResultMessagePart[] {
  return [
    {
      type: "tool-result" as const,
      toolCallId: toolResult.toolCallId,
      toolName: toolResult.toolName,
      output: normalizeToolResultOutput(toolResult.output)
    }
  ];
}

export function toolErrorResultContent(toolResult: {
  toolCallId: string;
  toolName: string;
  error: unknown;
}): ToolResultMessagePart[] {
  return [
    {
      type: "tool-result" as const,
      toolCallId: toolResult.toolCallId,
      toolName: toolResult.toolName,
      output: normalizeToolErrorOutput(toolResult.error)
    }
  ];
}

export function extractTextFromContent(content: MessageContent): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .filter(isTextMessagePart)
    .map((part) => part.text)
    .join("\n\n");
}

export function summarizeContentForDisplay(content: MessageContent): string {
  if (typeof content === "string") {
    return content;
  }

  const text = content
    .filter(isTextMessagePart)
    .map((part) => part.text.trim())
    .filter((part) => part.length > 0)
    .join("\n\n");
  const imageCount = content.filter((part) => part.type === "image").length;
  const fileCount = content.filter((part) => part.type === "file").length;
  const attachmentSummary = [
    ...(imageCount > 0 ? [`${imageCount} image${imageCount === 1 ? "" : "s"}`] : []),
    ...(fileCount > 0 ? [`${fileCount} file${fileCount === 1 ? "" : "s"}`] : [])
  ].join(", ");

  if (text && attachmentSummary) {
    return `${text}\n\n${attachmentSummary}`;
  }

  return text || attachmentSummary;
}

export function contentToPromptMessage(role: Message["role"], content: MessageContent): ChatMessage {
  switch (role) {
    case "system":
      if (typeof content !== "string") {
        throw new Error("Invalid system content.");
      }
      return {
        role,
        content
      };
    case "user":
      if (!isMessageContentForRole(role, content)) {
        throw new Error("Invalid user content.");
      }
      return {
        role,
        content
      };
    case "assistant":
      if (!isMessageContentForRole(role, content)) {
        throw new Error("Invalid assistant content.");
      }
      return {
        role,
        content
      };
    case "tool":
      if (!isMessageContentForRole(role, content)) {
        throw new Error("Invalid tool content.");
      }
      return {
        role,
        content
      };
  }
}
