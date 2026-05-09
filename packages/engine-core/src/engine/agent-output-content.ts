import type { Message } from "@oah/api-contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFailedToolResultMessage(message: Message): boolean {
  if (message.role !== "tool") {
    return false;
  }

  if (message.metadata?.toolStatus === "failed") {
    return true;
  }

  if (!Array.isArray(message.content)) {
    return false;
  }

  return message.content.some((part) => {
    if (part.type !== "tool-result") {
      return false;
    }
    const output = part.output;
    return isRecord(output) && (output.type === "error-text" || output.type === "error-json");
  });
}

function isAssistantMessageStillUsingTools(message: Message | undefined): boolean {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
    return false;
  }

  return message.content.some((part) => part.type === "tool-call");
}

function isAssistantMessagePureToolUse(message: Message | undefined): boolean {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content) || message.content.length === 0) {
    return false;
  }

  return message.content.every((part) => {
    if (part.type === "tool-call") {
      return true;
    }
    if (part.type === "text" && typeof part.text === "string") {
      return part.text.trim().length === 0;
    }
    return false;
  });
}

function looksLikeIntermediateSubagentProgress(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) {
    return true;
  }

  const normalized = trimmed.toLowerCase();
  const progressPrefixes = [
    "let me ",
    "now let me ",
    "i need to ",
    "i will ",
    "i'll ",
    "i should ",
    "让我",
    "我需要",
    "我将",
    "现在让我",
    "继续搜索",
    "尝试搜索"
  ];
  const progressFragments = [
    "let me try",
    "let me search",
    "let me continue",
    "try to find",
    "search for",
    "获取成功了",
    "重新搜索",
    "继续搜索",
    "尝试搜索"
  ];
  return (
    progressPrefixes.some((marker) => normalized.startsWith(marker)) ||
    progressFragments.some((marker) => normalized.includes(marker))
  );
}

export function extractRunOutputContent(input: {
  messages: Message[];
  runId: string;
  extractMessageDisplayText(message: Message): string | undefined;
  hasMeaningfulText(content: string | undefined): boolean;
}): string | undefined {
  const runMessages = input.messages.filter((message) => message.runId === input.runId);
  const assistantMessages = [...runMessages].reverse().filter((message) => message.role === "assistant");
  let sawAssistantText = false;

  for (const assistantMessage of assistantMessages) {
    const assistantContent = input.extractMessageDisplayText(assistantMessage);
    if (!input.hasMeaningfulText(assistantContent)) {
      continue;
    }

    sawAssistantText = true;
    if (isAssistantMessageStillUsingTools(assistantMessage)) {
      if (isAssistantMessagePureToolUse(assistantMessage)) {
        continue;
      }
      return undefined;
    }

    if (typeof assistantContent === "string" && !looksLikeIntermediateSubagentProgress(assistantContent)) {
      return assistantContent;
    }
  }

  if (sawAssistantText) {
    return undefined;
  }

  const failedToolMessage = [...runMessages].reverse().find((message) => isFailedToolResultMessage(message));
  const failedToolContent = failedToolMessage ? input.extractMessageDisplayText(failedToolMessage) : undefined;
  return input.hasMeaningfulText(failedToolContent) ? failedToolContent : undefined;
}
