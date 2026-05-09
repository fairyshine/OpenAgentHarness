import type { Message, Run, SessionEventContract } from "@oah/api-contracts";

import type { ChatLine } from "./types.js";
import {
  formatAskUserQuestionPrompt,
  readAskUserQuestionPrompt
} from "./ask-user-question.js";
import {
  formatDuration,
  isRecord,
  readString,
  readToolMetadata,
  stringifyMessageContent,
  summarizeToolInput,
  toolOutputToText
} from "./tool-output.js";

function makeLineId(messageId: string, index: number) {
  return index === 0 ? messageId : `${messageId}:part:${index}`;
}

export function messageToChatLines(message: Message): ChatLine[] {
  const metadata = "metadata" in message ? message.metadata : undefined;
  const toolMetadata = readToolMetadata(metadata);
  if (typeof message.content === "string") {
    return [
      {
        id: message.id,
        role: message.role,
        text: message.content,
        createdAt: message.createdAt,
        kind: message.role === "system" ? "system" : "message",
        tone: message.role === "system" ? "muted" : undefined
      }
    ];
  }

  if (!Array.isArray(message.content)) {
    return [
      {
        id: message.id,
        role: message.role,
        text: stringifyMessageContent(message.content),
        createdAt: message.createdAt,
        kind: message.role === "system" ? "system" : "message",
        tone: message.role === "system" ? "muted" : undefined
      }
    ];
  }

  const lines: ChatLine[] = [];
  for (const [partIndex, part] of message.content.entries()) {
    if (part.type === "text" && part.text.trim().length > 0) {
      lines.push({
        id: makeLineId(message.id, lines.length),
        role: message.role,
        text: part.text,
        createdAt: message.createdAt,
        kind: "message"
      });
      continue;
    }
    if (part.type === "reasoning" && part.text.trim().length > 0) {
      lines.push({
        id: makeLineId(message.id, lines.length),
        role: message.role,
        text: part.text,
        title: "Thinking",
        createdAt: message.createdAt,
        kind: "reasoning",
        tone: "muted"
      });
      continue;
    }
    if (part.type === "tool-call") {
      const detail = summarizeToolInput(part.input);
      const status = toolMetadata.toolStatus ?? "running";
      lines.push({
        id: makeLineId(message.id, lines.length),
        role: "tool",
        text: detail ? `${part.toolName} (${detail})` : part.toolName,
        title: part.toolName,
        detail,
        toolName: part.toolName,
        toolCallId: part.toolCallId,
        toolStatus: status,
        toolInput: part.input,
        durationMs: toolMetadata.durationMs,
        sourceType: toolMetadata.sourceType,
        createdAt: message.createdAt,
        kind: "tool",
        tone: status === "failed" ? "error" : "muted"
      });
      continue;
    }
    if (part.type === "tool-result") {
      const output = toolOutputToText(part.output);
      const status = output.denied ? "denied" : output.failed ? "failed" : (toolMetadata.toolStatus ?? "completed");
      const duration = formatDuration(toolMetadata.durationMs);
      const askUserQuestion = readAskUserQuestionPrompt(part.toolName, part.output);
      lines.push({
        id: makeLineId(message.id, lines.length),
        role: "tool",
        text: askUserQuestion ? formatAskUserQuestionPrompt(askUserQuestion) : output.text,
        title: part.toolName,
        detail: duration,
        toolName: part.toolName,
        toolCallId: part.toolCallId,
        toolStatus: status,
        toolOutput: part.output,
        toolOutputText: askUserQuestion ? formatAskUserQuestionPrompt(askUserQuestion) : output.text,
        ...(askUserQuestion ? { askUserQuestion } : {}),
        durationMs: toolMetadata.durationMs,
        sourceType: toolMetadata.sourceType,
        createdAt: message.createdAt,
        kind: "tool",
        tone: status === "failed" || status === "denied" ? "error" : "muted"
      });
      continue;
    }
    if (part.type === "file") {
      const filename = part.filename ?? "file";
      lines.push({
        id: makeLineId(message.id, lines.length),
        role: message.role,
        text: filename,
        title: `Read ${filename}`,
        detail: part.mediaType,
        createdAt: message.createdAt,
        kind: "attachment",
        tone: "muted"
      });
      continue;
    }
    if (part.type === "image") {
      lines.push({
        id: makeLineId(message.id, lines.length),
        role: message.role,
        text: part.mediaType ?? "image",
        title: "Attached image",
        detail: part.mediaType,
        createdAt: message.createdAt,
        kind: "attachment",
        tone: "muted"
      });
      continue;
    }
    if (part.type === "tool-approval-request") {
      lines.push({
        id: makeLineId(message.id, lines.length),
        role: "tool",
        text: `Approval requested for ${part.toolCallId}`,
        title: "Approval requested",
        detail: part.toolCallId,
        toolCallId: part.toolCallId,
        toolStatus: "waiting",
        createdAt: message.createdAt,
        kind: "approval",
        tone: "muted"
      });
      continue;
    }
    if (part.type === "tool-approval-response") {
      lines.push({
        id: makeLineId(message.id, lines.length),
        role: "tool",
        text: part.reason ?? (part.approved ? "Approved" : "Denied"),
        title: part.approved ? "Approved" : "Denied",
        detail: part.reason,
        toolStatus: part.approved ? "completed" : "denied",
        createdAt: message.createdAt,
        kind: "approval",
        tone: part.approved ? "muted" : "error"
      });
    }
    if (partIndex === message.content.length - 1 && lines.length === 0) {
      lines.push({
        id: message.id,
        role: message.role,
        text: stringifyMessageContent(message.content),
        createdAt: message.createdAt,
        kind: "message"
      });
    }
  }

  return lines.length > 0
    ? lines
    : [
        {
          id: message.id,
          role: message.role,
          text: stringifyMessageContent(message.content),
          createdAt: message.createdAt,
          kind: "message"
        }
      ];
}

export function messageToChatLine(message: Message): ChatLine {
  return messageToChatLines(message)[0] ?? {
    id: message.id,
    role: message.role,
    text: stringifyMessageContent(message.content),
    createdAt: message.createdAt,
    kind: "message"
  };
}

export function runFailureToChatLine(run: Run): ChatLine | null {
  if (run.status !== "failed" && run.status !== "timed_out") {
    return null;
  }
  return {
    id: `run-error:${run.id}`,
    role: "system",
    text: run.errorMessage ?? (run.status === "timed_out" ? "Run timed out" : "Run failed"),
    createdAt: run.endedAt ?? run.createdAt,
    tone: "error"
  };
}

function eventChatLine(event: SessionEventContract): ChatLine | null {
  const toolName = typeof event.data.toolName === "string" ? event.data.toolName : undefined;
  const toolCallId = typeof event.data.toolCallId === "string" ? event.data.toolCallId : undefined;
  const errorMessage = typeof event.data.errorMessage === "string" ? event.data.errorMessage : undefined;
  const durationMs = typeof event.data.durationMs === "number" ? event.data.durationMs : undefined;
  const sourceType = typeof event.data.sourceType === "string" ? event.data.sourceType : undefined;
  switch (event.event) {
    case "tool.started":
      return {
        id: toolCallId ? `tool:${toolCallId}` : `event:${event.id}`,
        role: "tool",
        text: toolName ? `${toolName}${event.data.input !== undefined ? ` (${summarizeToolInput(event.data.input)})` : ""}` : "Using tool",
        title: toolName ?? "Tool",
        detail: event.data.input !== undefined ? summarizeToolInput(event.data.input) : "",
        toolName,
        toolCallId,
        toolStatus: "running",
        toolInput: event.data.input,
        sourceType,
        createdAt: event.createdAt,
        tone: "muted",
        kind: "tool"
      };
    case "tool.completed":
      {
        const output = toolOutputToText(event.data.output);
        const detail = formatDuration(durationMs);
        return {
          id: toolCallId ? `tool:${toolCallId}` : `event:${event.id}`,
          role: "tool",
          text: output.text || (toolName ? `Done ${toolName}` : "Tool completed"),
          title: toolName ?? "Tool",
          detail,
          toolName,
          toolCallId,
          toolStatus: output.failed ? "failed" : "completed",
          toolOutput: event.data.output,
          toolOutputText: output.text,
          durationMs,
          sourceType,
          createdAt: event.createdAt,
          tone: output.failed ? "error" : "muted",
          kind: "tool"
        };
      }
    case "tool.failed":
      return {
        id: toolCallId ? `tool:${toolCallId}` : `event:${event.id}`,
        role: "tool",
        text: errorMessage ?? (toolName ? `Failed ${toolName}` : "Tool failed"),
        title: toolName ?? "Tool failed",
        detail: formatDuration(durationMs),
        toolName,
        toolCallId,
        toolStatus: "failed",
        toolOutput: event.data.output,
        toolOutputText: errorMessage,
        durationMs,
        sourceType,
        createdAt: event.createdAt,
        tone: "error",
        kind: "tool"
      };
    case "agent.switched":
      return {
        id: `event:${event.id}`,
        role: "system",
        text: typeof event.data.toAgent === "string" ? `Switched to ${event.data.toAgent}` : "Agent switched",
        createdAt: event.createdAt,
        tone: "muted"
      };
    case "run.failed":
      return {
        id: `run-error:${event.runId ?? event.id}`,
        role: "system",
        text: errorMessage ?? "Run failed",
        createdAt: event.createdAt,
        tone: "error"
      };
    case "run.cancelled":
      return {
        id: `event:${event.id}`,
        role: "system",
        text: "Run cancelled",
        createdAt: event.createdAt,
        tone: "muted"
      };
    default:
      return null;
  }
}

export function updateChatLinesFromEvent(lines: ChatLine[], event: SessionEventContract): ChatLine[] {
  const messageId = typeof event.data.messageId === "string" ? event.data.messageId : undefined;
  if (!messageId) {
    const line = eventChatLine(event);
    if (!line) {
      return lines;
    }
    if (lines.some((item) => item.id === line.id)) {
      return lines.map((item) =>
        item.id === line.id
          ? {
              ...item,
              ...line,
              detail: line.detail || item.detail,
              text: line.text || item.text,
              title: line.title || item.title,
              toolInput: line.toolInput ?? item.toolInput,
              toolOutput: line.toolOutput ?? item.toolOutput,
              toolOutputText: line.toolOutputText ?? item.toolOutputText,
              createdAt: item.createdAt ?? line.createdAt
            }
          : item
      );
    }
    return [...lines, line];
  }

  if (event.event === "message.delta") {
    const nextText =
      event.data.content !== undefined
        ? stringifyMessageContent(event.data.content)
        : typeof event.data.delta === "string"
          ? event.data.delta
          : "";
    if (!nextText) {
      return lines;
    }
    const existing = lines.find((line) => line.id === messageId);
    if (!existing) {
      return [
        ...lines,
        {
          id: messageId,
          role: "assistant",
          text: nextText,
          createdAt: event.createdAt
        }
      ];
    }
    return lines.map((line) =>
      line.id === messageId
        ? {
            ...line,
            text: event.data.content !== undefined ? nextText : `${line.text}${nextText}`
          }
        : line
    );
  }

  if (event.event === "message.completed" && event.data.content !== undefined) {
    const role = typeof event.data.role === "string" ? event.data.role : "assistant";
    const completed = messageToChatLines({
      id: messageId,
      sessionId: event.sessionId,
      ...(event.runId ? { runId: event.runId } : {}),
      role,
      content: event.data.content as Message["content"],
      ...(isRecord(event.data.metadata) ? { metadata: event.data.metadata } : {}),
      createdAt: event.createdAt
    } as Message);
    const cleaned = lines.filter((line) => line.id !== messageId && !line.id.startsWith(`${messageId}:part:`));
    return [...cleaned, ...completed].sort(compareChatLines);
  }

  return lines;
}

export function mergeRefreshedChatLines(current: ChatLine[], refreshed: ChatLine[]): ChatLine[] {
  if (current.length === 0) {
    return refreshed;
  }

  const refreshedById = new Map(refreshed.map((line) => [line.id, line] as const));
  const refreshedToolCallIds = new Set(refreshed.map((line) => line.toolCallId).filter((value): value is string => Boolean(value)));
  const refreshedUserTexts = new Set(
    refreshed.filter((line) => line.role === "user").map((line) => line.text.trim()).filter(Boolean)
  );
  const merged = refreshed.map((line) => {
    const existing = current.find((item) => item.id === line.id);
    if (!existing || existing.role !== "assistant" || line.role !== "assistant") {
      return line;
    }
    return existing.text.length > line.text.length ? { ...line, text: existing.text } : line;
  });

  for (const line of current) {
    if (refreshedById.has(line.id)) {
      continue;
    }
    if (line.toolCallId && refreshedToolCallIds.has(line.toolCallId)) {
      continue;
    }
    if (line.id.startsWith("pending:") && refreshedUserTexts.has(line.text.trim())) {
      continue;
    }
    if (line.id.startsWith("event:") || line.id.startsWith("pending:")) {
      merged.push(line);
      continue;
    }
    if (line.role === "assistant" && line.text.trim().length > 0) {
      merged.push(line);
    }
  }

  return merged.sort(compareChatLines);
}

function compareChatLines(left: ChatLine, right: ChatLine) {
  const leftTime = Date.parse(left.createdAt ?? "");
  const rightTime = Date.parse(right.createdAt ?? "");
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) {
    return Number.isFinite(leftTime) ? -1 : 1;
  }
  return left.id.localeCompare(right.id);
}
