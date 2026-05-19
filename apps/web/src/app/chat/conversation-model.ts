import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from "react";

import type {
  Message,
  MessagePart,
  Run,
  Session,
  SessionEventContract,
  SessionQueuedRun,
  SessionTerminalInputAccepted,
  SessionTerminalSnapshot,
  Workspace,
  WorkspaceCatalog
} from "@oah/api-contracts";

import type { RuntimeViewModel } from "../engine-view-model";
import type { MainViewMode, SurfaceMode } from "../support";
import type { WorkspaceFileManagerParams } from "../use-workspace-file-manager";
import type { WorkspaceMemoryController } from "../use-workspace-memory";
import type { DraftImageAttachment } from "./composer-content";
import { createClientId } from "../client-id";
import { toneBadgeClass } from "../support";

export type RuntimeProps = RuntimeViewModel & {
  mainViewMode: MainViewMode;
  setMainViewMode: Dispatch<SetStateAction<MainViewMode>>;
  setSurfaceMode: Dispatch<SetStateAction<SurfaceMode>>;
  hasActiveSession: boolean;
  currentSessionName: string;
  currentWorkspaceName: string;
  inspectorSubtitle: string;
  latestEvent: SessionEventContract | null;
  session: Session | null;
  workspace: Workspace | null;
  workspaceId: string;
  sessionRuns: Run[];
  refreshSessionRuns: () => void;
  sessionEvents: SessionEventContract[];
  deferredEvents: SessionEventContract[];
  refreshRunById: (runId: string) => void;
  refreshRunStepsById: (runId: string) => void;
  openSessionById: (sessionId: string, quiet?: boolean) => Promise<unknown> | void;
  conversationThreadRef: RefObject<HTMLDivElement | null>;
  conversationTailRef: RefObject<HTMLDivElement | null>;
  shouldAutoFollowConversationRef: MutableRefObject<boolean>;
  hasMoreMessages: boolean;
  messagesTotalCount: number | undefined;
  messagesLoading: boolean;
  loadingOlderMessages: boolean;
  queuedSessionRuns: SessionQueuedRun[];
  loadOlderMessages: () => void;
  refreshMessages: () => void;
  sendMessage: (draftOverride?: { message: string; attachments: DraftImageAttachment[] }) => void;
  answerAskUserQuestion: (answer: string) => void;
  guideMessage: (draftOverride?: { text?: string; mode?: "append" | "replace" | "prefix" }) => void;
  guideQueuedSessionInput: (runId: string) => void;
  guideMessageSupported: boolean;
  refreshRun: () => void;
  refreshRunSteps: () => void;
  cancelCurrentRun: () => void;
  refreshSessionTerminal: (sessionId: string, terminalId: string) => Promise<SessionTerminalSnapshot | null>;
  sendSessionTerminalInput: (params: {
    sessionId: string;
    terminalId: string;
    input: string;
    appendNewline?: boolean | undefined;
  }) => Promise<SessionTerminalInputAccepted | null>;
  catalog: WorkspaceCatalog | null;
  isSwitchingSessionAgent: boolean;
  switchSessionAgent: (sessionId: string, activeAgentName: string) => void;
  isSwitchingSessionModel: boolean;
  updateSessionModel: (sessionId: string, modelRef: string | null) => void;
  triggerWorkspaceAction: (input: { workspaceId: string; actionName: string; input?: unknown }) => Promise<boolean>;
  refreshWorkspace: (workspaceId: string) => void;
  isRunning: boolean;
  fileManager: WorkspaceFileManagerParams;
  workspaceMemory: WorkspaceMemoryController;
};
export type ToolResultOutput = { type: string; value?: unknown; reason?: string };

const MAX_RESOLVED_TOOL_RESULT_CONTENT_CHARS = 64000;
const MAX_JSON_PREVIEW_DEPTH = 8;

function capTextPreview(value: string, limit = MAX_RESOLVED_TOOL_RESULT_CONTENT_CHARS) {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit)}\n... ${Math.max(0, value.length - limit).toLocaleString()} chars truncated`;
}

function stringifyJsonPreview(value: unknown, limit = MAX_RESOLVED_TOOL_RESULT_CONTENT_CHARS) {
  const chunks: string[] = [];
  const seen = new WeakSet<object>();
  let remaining = limit;
  let truncated = false;

  const write = (text: string) => {
    if (remaining <= 0) {
      truncated = true;
      return;
    }

    if (text.length > remaining) {
      chunks.push(text.slice(0, remaining));
      remaining = 0;
      truncated = true;
      return;
    }

    chunks.push(text);
    remaining -= text.length;
  };

  const walk = (entry: unknown, depth: number, indent: string) => {
    if (remaining <= 0) {
      truncated = true;
      return;
    }

    if (entry === null || typeof entry !== "object") {
      write(JSON.stringify(entry) ?? String(entry));
      return;
    }

    if (seen.has(entry)) {
      write("\"[Circular]\"");
      return;
    }

    if (depth >= MAX_JSON_PREVIEW_DEPTH) {
      write("\"[Max depth]\"");
      return;
    }

    seen.add(entry);
    const childIndent = `${indent}  `;
    if (Array.isArray(entry)) {
      write("[");
      for (let index = 0; index < entry.length; index += 1) {
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        write(`${index === 0 ? "\n" : ",\n"}${childIndent}`);
        walk(entry[index], depth + 1, childIndent);
      }
      if (entry.length > 0 && remaining > 0) {
        write(`\n${indent}`);
      }
      write("]");
      seen.delete(entry);
      return;
    }

    write("{");
    let index = 0;
    for (const key in entry as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(entry, key)) {
        continue;
      }
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      write(`${index === 0 ? "\n" : ",\n"}${childIndent}${JSON.stringify(key)}: `);
      walk((entry as Record<string, unknown>)[key], depth + 1, childIndent);
      index += 1;
    }
    if (index > 0 && remaining > 0) {
      write(`\n${indent}`);
    }
    write("}");
    seen.delete(entry);
  };

  try {
    walk(value, 0, "");
  } catch {
    return capTextPreview(String(value), limit);
  }

  return `${chunks.join("")}${truncated ? "\n... truncated" : ""}`;
}

export function resolveToolResultContent(output: ToolResultOutput | undefined): { content: string; isError: boolean } {
  if (!output) return { content: "", isError: false };
  switch (output.type) {
    case "text":
      return { content: typeof output.value === "string" ? capTextPreview(output.value) : "", isError: false };
    case "json":
      return { content: stringifyJsonPreview(output.value), isError: false };
    case "error-text":
      return { content: typeof output.value === "string" ? capTextPreview(output.value) : "", isError: true };
    case "error-json":
      return { content: stringifyJsonPreview(output.value), isError: true };
    case "execution-denied":
      return { content: output.reason ?? "execution denied", isError: true };
    case "content":
      return { content: stringifyJsonPreview(output.value), isError: false };
    default:
      return { content: stringifyJsonPreview(output), isError: false };
  }
}

export type ToolStatus = "running" | "started" | "completed" | "failed";
export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoProgressItem = {
  content: string;
  activeForm?: string | undefined;
  status: TodoStatus;
};
export type ConversationTodoProgress = {
  items: TodoProgressItem[];
  updatedAt?: string | undefined;
  completedCount: number;
  activeCount: number;
  pendingCount: number;
};
export type ConversationTerminalState = {
  terminalId: string;
  status?: string | undefined;
  output?: string | undefined;
  outputPath?: string | undefined;
  inputWritable?: boolean | undefined;
  terminalKind?: string | undefined;
  updatedAt?: string | undefined;
};
export type AskUserQuestionOption = {
  label: string;
  description?: string | undefined;
  preview?: string | undefined;
};
export type AskUserQuestionItem = {
  question: string;
  header?: string | undefined;
  options?: AskUserQuestionOption[] | undefined;
  multiSelect?: boolean | undefined;
  freeText?: boolean | undefined;
};
export type AskUserQuestionPayload = {
  status: "awaiting_user";
  context?: string | undefined;
  questions: AskUserQuestionItem[];
};
export type ParsedAgentTaskReference = {
  kind: "notification" | "task_output";
  taskId: string;
  childRunId?: string | undefined;
  status?: string | undefined;
  retrievalStatus?: string | undefined;
  taskType?: string | undefined;
  toolUseId?: string | undefined;
  description?: string | undefined;
  summary?: string | undefined;
  result?: string | undefined;
  output?: string | undefined;
  error?: string | undefined;
  outputRef?: string | undefined;
  outputFile?: string | undefined;
  retrieved?: boolean | undefined;
  notified?: boolean | undefined;
  backgrounded?: boolean | undefined;
  pendingMessageCount?: number | undefined;
  reportedToolCount?: number | undefined;
  reportedTokenCount?: number | undefined;
};
export const AUTO_SESSION_MODEL_VALUE = "__session_model_auto__";
export const CONVERSATION_BOTTOM_THRESHOLD_PX = 96;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isImageFile(file: File) {
  return file.type.startsWith("image/");
}

export function readOptionalString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function readAskUserQuestionPayload(output: ToolResultOutput | undefined): AskUserQuestionPayload | null {
  if (!output || output.type !== "json" || !isRecord(output.value) || output.value.status !== "awaiting_user") {
    return null;
  }

  const rawQuestions = Array.isArray(output.value.questions) ? output.value.questions : [];
  const questions = rawQuestions.flatMap((rawQuestion): AskUserQuestionItem[] => {
    if (!isRecord(rawQuestion)) {
      return [];
    }
    const question = readOptionalString(rawQuestion.question);
    if (!question) {
      return [];
    }
    const options = Array.isArray(rawQuestion.options)
      ? rawQuestion.options.flatMap((rawOption): AskUserQuestionOption[] => {
          if (!isRecord(rawOption)) {
            return [];
          }
          const label = readOptionalString(rawOption.label);
          if (!label) {
            return [];
          }
          return [
            {
              label,
              description: readOptionalString(rawOption.description),
              preview: readOptionalString(rawOption.preview)
            }
          ];
        })
      : undefined;

    return [
      {
        question,
        header: readOptionalString(rawQuestion.header),
        ...(options && options.length > 0 ? { options } : {}),
        ...(typeof rawQuestion.multiSelect === "boolean" ? { multiSelect: rawQuestion.multiSelect } : {}),
        ...(typeof rawQuestion.freeText === "boolean" ? { freeText: rawQuestion.freeText } : {})
      }
    ];
  });

  if (questions.length === 0) {
    return null;
  }

  return {
    status: "awaiting_user",
    context: readOptionalString(output.value.context),
    questions
  };
}

export function formatAskUserQuestionAnswer(payload: AskUserQuestionPayload, answers: string[]) {
  const lines = ["Answers to your questions:"];
  payload.questions.forEach((question, index) => {
    const answer = answers[index]?.trim() || "(no answer)";
    lines.push(`${index + 1}. ${question.question} ${answer}`);
  });
  return lines.join("\n");
}

export function sessionAgentLabel(agent: { name: string; mode: "primary" | "subagent" | "all" }) {
  return `${agent.name} · ${agent.mode}`;
}

export function parseDataUrl(dataUrl: string): { mediaType: string; base64Data: string } | null {
  const match = dataUrl.match(/^data:([^;,]+)?;base64,(.+)$/u);
  if (!match) {
    return null;
  }

  return {
    mediaType: match[1] ?? "image/png",
    base64Data: match[2] ?? ""
  };
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }

      reject(new Error(`Unexpected reader result for ${file.name}.`));
    };
    reader.onerror = () => reject(reader.error ?? new Error(`Failed to read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

export async function filesToDraftImageAttachments(files: FileList | File[]): Promise<DraftImageAttachment[]> {
  const imageFiles = [...files].filter(isImageFile);

  const attachmentGroups = await Promise.all(
    imageFiles.map(async (file) => {
      const previewUrl = await readFileAsDataUrl(file);
      const parsed = parseDataUrl(previewUrl);
      if (!parsed || parsed.base64Data.length === 0) {
        return [];
      }

      return [
        {
          id: createClientId(),
          name: file.name,
          mediaType: file.type || parsed.mediaType || "image/png",
          previewUrl,
          base64Data: parsed.base64Data,
          size: file.size
        }
      ];
    })
  );

  return attachmentGroups.flat();
}

export function formatAttachmentSize(size: number) {
  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(size >= 10 * 1024 ? 0 : 1)} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatAttachmentType(mediaType: string) {
  const normalized = mediaType.toLowerCase();
  if (normalized === "image/jpeg") {
    return "JPG";
  }

  if (normalized.startsWith("image/")) {
    return normalized.slice("image/".length).toUpperCase();
  }

  return mediaType.toUpperCase();
}

export function resolveImageSource(part: Extract<MessagePart, { type: "image" }>) {
  const value = part.image.trim();
  if (value.startsWith("data:") || /^https?:\/\//iu.test(value) || value.startsWith("blob:")) {
    return value;
  }

  return `data:${part.mediaType ?? "image/png"};base64,${value}`;
}

export function agentModeTone(mode: "primary" | "subagent" | "all") {
  switch (mode) {
    case "primary":
      return toneBadgeClass("sky");
    case "subagent":
      return toneBadgeClass("amber");
    case "all":
      return toneBadgeClass("emerald");
  }
}

export function toolStatusTone(status: ToolStatus) {
  switch (status) {
    case "running":
      return toneBadgeClass("amber");
    case "started":
      return toneBadgeClass("sky");
    case "completed":
      return toneBadgeClass("emerald");
    case "failed":
      return toneBadgeClass("rose");
  }
}

export function readToolMeta(messageMetadata: Message["metadata"] | undefined) {
  if (!isRecord(messageMetadata)) {
    return {};
  }

  return {
    status:
      messageMetadata.toolStatus === "running" ||
      messageMetadata.toolStatus === "started" ||
      messageMetadata.toolStatus === "completed" ||
      messageMetadata.toolStatus === "failed"
        ? (messageMetadata.toolStatus as ToolStatus)
        : undefined,
    durationMs: typeof messageMetadata.toolDurationMs === "number" ? messageMetadata.toolDurationMs : undefined,
    sourceType: typeof messageMetadata.toolSourceType === "string" ? messageMetadata.toolSourceType : undefined
  };
}

export function isTodoStatus(value: unknown): value is TodoStatus {
  return value === "pending" || value === "in_progress" || value === "completed";
}

export function normalizeTodoProgressItem(value: unknown): TodoProgressItem | null {
  if (!isRecord(value) || !isTodoStatus(value.status)) {
    return null;
  }

  const content = typeof value.content === "string" ? value.content.trim() : "";
  const activeForm = typeof value.activeForm === "string" ? value.activeForm.trim() : "";
  const label = content || activeForm;
  if (!label) {
    return null;
  }

  return {
    content: label,
    ...(activeForm ? { activeForm } : {}),
    status: value.status
  };
}

export function readTodoWriteItemsFromToolCall(part: Extract<MessagePart, { type: "tool-call" }>) {
  if (part.toolName !== "TodoWrite" || !isRecord(part.input) || !Array.isArray(part.input.todos)) {
    return null;
  }

  const items = part.input.todos
    .map((item) => normalizeTodoProgressItem(item))
    .filter((item): item is TodoProgressItem => item !== null);
  return items.length > 0 ? items : null;
}

export function buildConversationTodoProgress(messages: Message[]): ConversationTodoProgress | null {
  let latestItems: TodoProgressItem[] | null = null;
  let updatedAt: string | undefined;

  for (const message of messages) {
    if (typeof message.content === "string") {
      continue;
    }

    for (const part of message.content) {
      if (part.type !== "tool-call") {
        continue;
      }

      const items = readTodoWriteItemsFromToolCall(part);
      if (!items) {
        continue;
      }

      latestItems = items;
      updatedAt = message.createdAt;
    }
  }

  if (!latestItems) {
    return null;
  }

  return {
    items: latestItems,
    updatedAt,
    completedCount: latestItems.filter((item) => item.status === "completed").length,
    activeCount: latestItems.filter((item) => item.status === "in_progress").length,
    pendingCount: latestItems.filter((item) => item.status === "pending").length
  };
}

export function readStringFieldFromToolText(output: string, key: string) {
  const prefix = `${key}:`;
  const line = output.split("\n").find((entry) => entry.startsWith(prefix));
  return line?.slice(prefix.length).trim() || undefined;
}

export function readBooleanFieldFromToolText(output: string, key: string) {
  const value = readStringFieldFromToolText(output, key);
  return value === "true" ? true : value === "false" ? false : undefined;
}

export function readTerminalOutputBlock(output: string) {
  const marker = "\noutput:\n";
  const index = output.indexOf(marker);
  if (index >= 0) {
    return output.slice(index + marker.length);
  }

  return output.startsWith("output:\n") ? output.slice("output:\n".length) : undefined;
}

export function readTerminalStateFromMessagePart(
  part: Extract<MessagePart, { type: "tool-call" }> | Extract<MessagePart, { type: "tool-result" }>,
  message: Message
): ConversationTerminalState | null {
  if (part.toolName !== "TerminalOutput" && part.toolName !== "TerminalInput") {
    return null;
  }

  if (part.type === "tool-call") {
    if (!isRecord(part.input) || typeof part.input.terminal_id !== "string" || part.input.terminal_id.trim().length === 0) {
      return null;
    }
    return {
      terminalId: part.input.terminal_id.trim(),
      updatedAt: message.createdAt
    };
  }

  const resolved = resolveToolResultContent(part.output as ToolResultOutput | undefined);
  const terminalId = readStringFieldFromToolText(resolved.content, "terminal_id");
  if (!terminalId) {
    return null;
  }

  return {
    terminalId,
    status: readStringFieldFromToolText(resolved.content, "status"),
    outputPath: readStringFieldFromToolText(resolved.content, "output_path"),
    output: readTerminalOutputBlock(resolved.content),
    inputWritable: readBooleanFieldFromToolText(resolved.content, "input_writable"),
    terminalKind: readStringFieldFromToolText(resolved.content, "terminal_kind"),
    updatedAt: message.createdAt
  };
}

export function buildConversationTerminalStates(messages: Message[]): ConversationTerminalState[] {
  const terminalsById = new Map<string, ConversationTerminalState>();

  for (const message of messages) {
    if (typeof message.content === "string") {
      continue;
    }

    for (const part of message.content) {
      if (part.type !== "tool-call" && part.type !== "tool-result") {
        continue;
      }

      const state = readTerminalStateFromMessagePart(part, message);
      if (!state) {
        continue;
      }

      terminalsById.set(state.terminalId, {
        ...(terminalsById.get(state.terminalId) ?? {}),
        ...state
      });
    }
  }

  return [...terminalsById.values()].sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
}

export function formatToolDuration(durationMs: number | undefined) {
  if (durationMs === undefined || !Number.isFinite(durationMs)) {
    return null;
  }

  if (durationMs < 1000) {
    return `${Math.max(0, Math.round(durationMs))} ms`;
  }

  return `${(durationMs / 1000).toFixed(durationMs >= 10000 ? 0 : 1)} s`;
}

export const LONG_MESSAGE_COLLAPSE_CHARS = 2800;
export const LONG_MESSAGE_PREVIEW_CHARS = 1200;
export const COMPACT_SUMMARY_PREVIEW_CHARS = 900;
export const CONVERSATION_VIRTUALIZATION_THRESHOLD = 40;
export const CONVERSATION_OVERSCAN_PX = 900;

export type CompactRuntimeKind = "compact_boundary" | "compact_summary";

export function readRuntimeKind(messageMetadata: Message["metadata"] | undefined): CompactRuntimeKind | undefined {
  if (!isRecord(messageMetadata)) {
    return undefined;
  }

  return messageMetadata.runtimeKind === "compact_boundary" || messageMetadata.runtimeKind === "compact_summary"
    ? messageMetadata.runtimeKind
    : undefined;
}

export function readNumericMetadataValue(messageMetadata: Message["metadata"] | undefined, key: string) {
  if (!isRecord(messageMetadata)) {
    return undefined;
  }

  const value = messageMetadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function formatCompactCount(value: number | undefined, suffix: string) {
  if (value === undefined) {
    return null;
  }

  return `${value.toLocaleString()} ${suffix}`;
}

export function decodeXmlText(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function readXmlTag(source: string, tagName: string) {
  const match = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "u").exec(source);
  return match?.[1] ? decodeXmlText(match[1]).trim() : undefined;
}

export function readXmlBoolean(source: string, tagName: string) {
  const value = readXmlTag(source, tagName);
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

export function readXmlInteger(source: string, tagName: string) {
  const value = readXmlTag(source, tagName);
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function messageContentTextParts(content: Message["content"]) {
  if (typeof content === "string") {
    return [content];
  }

  return content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : []));
}

export function parseAgentTaskReference(text: string): ParsedAgentTaskReference | null {
  const taskStateText = readXmlTag(text, "task_state") ?? "";
  if (text.includes("<task-notification>")) {
    const taskId = readXmlTag(text, "task-id");
    if (!taskId) {
      return null;
    }

    return {
      kind: "notification",
      taskId,
      childRunId: readXmlTag(text, "child_run_id"),
      status: readXmlTag(text, "status"),
      toolUseId: readXmlTag(text, "tool_use_id"),
      summary: readXmlTag(text, "summary"),
      result: readXmlTag(text, "result"),
      error: readXmlTag(text, "error"),
      outputRef: readXmlTag(text, "output_ref"),
      outputFile: readXmlTag(text, "output_file"),
      retrieved: readXmlBoolean(taskStateText, "retrieved"),
      notified: readXmlBoolean(taskStateText, "notified"),
      backgrounded: readXmlBoolean(taskStateText, "backgrounded"),
      pendingMessageCount: readXmlInteger(taskStateText, "pending_messages"),
      reportedToolCount: readXmlInteger(taskStateText, "reported_tool_count"),
      reportedTokenCount: readXmlInteger(taskStateText, "reported_token_count")
    };
  }

  if (text.includes("<retrieval_status>") && text.includes("<task_id>")) {
    const taskId = readXmlTag(text, "task_id");
    if (!taskId) {
      return null;
    }

    return {
      kind: "task_output",
      taskId,
      childRunId: readXmlTag(text, "child_run_id"),
      retrievalStatus: readXmlTag(text, "retrieval_status"),
      taskType: readXmlTag(text, "task_type"),
      status: readXmlTag(text, "status"),
      description: readXmlTag(text, "description"),
      output: readXmlTag(text, "output"),
      error: readXmlTag(text, "error"),
      outputRef: readXmlTag(text, "output_ref"),
      outputFile: readXmlTag(text, "output_file"),
      retrieved: readXmlBoolean(taskStateText, "retrieved"),
      notified: readXmlBoolean(taskStateText, "notified"),
      backgrounded: readXmlBoolean(taskStateText, "backgrounded"),
      pendingMessageCount: readXmlInteger(taskStateText, "pending_messages"),
      reportedToolCount: readXmlInteger(taskStateText, "reported_tool_count"),
      reportedTokenCount: readXmlInteger(taskStateText, "reported_token_count")
    };
  }

  return null;
}

export function readTaskStateFromMetadata(metadata: Message["metadata"] | undefined): Partial<ParsedAgentTaskReference> {
  if (!isRecord(metadata) || !isRecord(metadata.taskState)) {
    return {};
  }

  const taskState = metadata.taskState;
  const pendingMessages = Array.isArray(taskState.pendingMessages) ? taskState.pendingMessages : undefined;
  return {
    ...(typeof taskState.retrieved === "boolean" ? { retrieved: taskState.retrieved } : {}),
    ...(typeof taskState.notified === "boolean" ? { notified: taskState.notified } : {}),
    ...(typeof taskState.isBackgrounded === "boolean" ? { backgrounded: taskState.isBackgrounded } : {}),
    ...(pendingMessages ? { pendingMessageCount: pendingMessages.length } : {}),
    ...(typeof taskState.lastReportedToolCount === "number" ? { reportedToolCount: taskState.lastReportedToolCount } : {}),
    ...(typeof taskState.lastReportedTokenCount === "number" ? { reportedTokenCount: taskState.lastReportedTokenCount } : {})
  };
}

export function parseAgentTaskReferenceFromContent(content: Message["content"]) {
  for (const text of messageContentTextParts(content)) {
    const taskReference = parseAgentTaskReference(text);
    if (taskReference) {
      return taskReference;
    }
  }

  return null;
}

export function parseAgentTaskReferenceFromMessage(message: Message) {
  const taskReference = parseAgentTaskReferenceFromContent(message.content);
  if (!taskReference) {
    return null;
  }

  return {
    ...taskReference,
    ...readTaskStateFromMetadata(message.metadata)
  };
}

export function isTaskNotificationMessage(message: Message) {
  return (
    message.mode === "task-notification" ||
    (isRecord(message.metadata) && message.metadata.taskNotification === true) ||
    messageContentTextParts(message.content).some((text) => text.includes("<task-notification>"))
  );
}

export function partitionStructuredMessageContent(content: Exclude<Message["content"], string>) {
  const textParts: Extract<MessagePart, { type: "text" }>[] = [];
  const imageParts: Extract<MessagePart, { type: "image" }>[] = [];
  const reasoningParts: Extract<MessagePart, { type: "reasoning" }>[] = [];
  const toolParts: Array<Extract<MessagePart, { type: "tool-call" }> | Extract<MessagePart, { type: "tool-result" }>> = [];
  const approvalParts: Array<
    Extract<MessagePart, { type: "tool-approval-request" }> | Extract<MessagePart, { type: "tool-approval-response" }>
  > = [];

  for (const part of content) {
    switch (part.type) {
      case "text":
        textParts.push(part);
        break;
      case "image":
        imageParts.push(part);
        break;
      case "reasoning":
        reasoningParts.push(part);
        break;
      case "tool-call":
      case "tool-result":
        toolParts.push(part);
        break;
      case "tool-approval-request":
      case "tool-approval-response":
        approvalParts.push(part);
        break;
    }
  }

  return {
    textParts,
    imageParts,
    reasoningParts,
    toolParts,
    approvalParts
  };
}
