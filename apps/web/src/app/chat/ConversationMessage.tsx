import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowRight,
  Bot,
  ChevronRight,
  Clock3,
  Sparkles,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Message, MessagePart } from "@oah/api-contracts";

import { formatTimestamp, toneBadgeClass } from "../support";
import {
  type ParsedAgentTaskReference,
  type ToolResultOutput,
  agentModeTone,
  COMPACT_SUMMARY_PREVIEW_CHARS,
  formatCompactCount,
  isTaskNotificationMessage,
  parseAgentTaskReference,
  parseAgentTaskReferenceFromMessage,
  partitionStructuredMessageContent,
  readNumericMetadataValue,
  readRuntimeKind,
  readTaskStateFromMetadata,
  resolveImageSource,
} from "./conversation-model";
import { ToolCallBlock, ToolResultBlock } from "./ConversationToolBlocks";
import {
  DeferredConversationBlock,
  ExpandableMarkdownText,
  MarkdownText,
  estimateMarkdownBlockHeight
} from "./conversation-markdown";

export function agentTaskStatusTone(status?: string) {
  switch (status) {
    case "completed":
    case "success":
      return toneBadgeClass("emerald");
    case "failed":
    case "killed":
    case "timeout":
      return toneBadgeClass("rose");
    case "running":
    case "pending":
    case "not_ready":
      return toneBadgeClass("amber");
    default:
      return "border-border/60 bg-muted/60 text-muted-foreground";
  }
}

export function agentTaskStatusDotClass(status?: string) {
  switch (status) {
    case "completed":
    case "success":
      return "bg-emerald-500";
    case "failed":
    case "killed":
    case "timeout":
      return "bg-rose-500";
    case "running":
    case "pending":
    case "not_ready":
      return "bg-amber-500";
    default:
      return "bg-muted-foreground";
  }
}

export function taskStateBadges(task: ParsedAgentTaskReference) {
  return [
    task.backgrounded === true ? "background" : "",
    task.pendingMessageCount && task.pendingMessageCount > 0 ? `${task.pendingMessageCount} queued` : "",
    task.retrieved === true ? "retrieved" : "",
    task.notified === true ? "notified" : "",
    task.reportedToolCount && task.reportedToolCount > 0 ? `${Math.round(task.reportedToolCount)} tools` : "",
    task.reportedTokenCount && task.reportedTokenCount > 0 ? `${Math.round(task.reportedTokenCount).toLocaleString()} tokens` : ""
  ].filter(Boolean);
}

export function AgentTaskReferenceCard({
  task,
  isUser,
  compactNotification = false,
  onOpenSession,
  onInspectRun
}: {
  task: ParsedAgentTaskReference;
  isUser?: boolean;
  compactNotification?: boolean;
  onOpenSession?: (sessionId: string) => void;
  onInspectRun?: (runId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const primaryStatus = task.status ?? task.retrievalStatus;
  const title =
    task.kind === "notification"
      ? primaryStatus === "failed" || primaryStatus === "killed" || primaryStatus === "timeout"
        ? "Subagent failed"
        : "Subagent completed"
      : "Task output";
  const bodyText = task.result ?? task.output ?? task.error ?? task.summary ?? task.description ?? "";
  const preview = bodyText.slice(0, 520).trimEnd();
  const canOpenSession = Boolean(onOpenSession && task.taskId.trim());
  const canInspectRun = Boolean(onInspectRun && task.childRunId?.trim());
  const stateBadges = taskStateBadges(task);

  if (compactNotification) {
    const notificationText = task.summary ?? task.error ?? task.result ?? title;
    const detailsText = [task.error, task.result, task.output, task.outputRef]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0 && value !== notificationText)
      .join("\n\n");
    const hasDetails = detailsText.length > 0;

    return (
      <div className="mx-auto max-w-3xl overflow-hidden rounded-xl border border-border/60 bg-background/75 px-3 py-2 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className={`h-2.5 w-2.5 flex-shrink-0 rounded-full ${agentTaskStatusDotClass(primaryStatus)}`} />
            <span className="min-w-0 truncate text-sm text-foreground">{notificationText}</span>
            {primaryStatus ? (
              <span className={`inline-flex rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] ${agentTaskStatusTone(primaryStatus)}`}>
                {primaryStatus}
              </span>
            ) : null}
            {stateBadges.map((badge) => (
              <span key={badge} className="hidden rounded-md border border-border/50 bg-muted/45 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground sm:inline-flex">
                {badge}
              </span>
            ))}
          </div>
          <div className="flex flex-shrink-0 items-center gap-1.5">
            {hasDetails ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 rounded-lg px-2 text-xs"
                onClick={() => setExpanded((current) => !current)}
              >
                <ChevronRight className={`mr-1.5 h-3.5 w-3.5 transition-transform ${expanded ? "rotate-90" : ""}`} />
                Details
              </Button>
            ) : null}
            {canInspectRun ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 rounded-lg px-2 text-xs"
                onClick={() => onInspectRun?.(task.childRunId ?? "")}
              >
                <Clock3 className="mr-1.5 h-3.5 w-3.5" />
                Inspect run
              </Button>
            ) : null}
            {canOpenSession ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 rounded-lg px-2 text-xs"
                onClick={() => onOpenSession?.(task.taskId)}
              >
                <ArrowRight className="mr-1.5 h-3.5 w-3.5" />
                Open child session
              </Button>
            ) : null}
          </div>
        </div>
        {expanded && hasDetails ? (
          <pre className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-muted/45 px-3 py-2 text-xs leading-5 text-foreground/86">
            {detailsText}
          </pre>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={`overflow-hidden rounded-2xl border px-4 py-3 shadow-sm ${
        isUser
          ? "border-white/12 bg-background/12 text-background"
          : "border-sky-500/20 bg-gradient-to-br from-sky-500/10 via-background to-background text-foreground"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={`mt-0.5 inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl border ${
              isUser ? "border-white/12 bg-background/14" : "border-sky-500/20 bg-sky-500/12 text-sky-700 dark:text-sky-300"
            }`}
          >
            <Bot className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold tracking-tight">{title}</p>
              {primaryStatus ? (
                <span className={`inline-flex rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] ${agentTaskStatusTone(primaryStatus)}`}>
                  {primaryStatus}
                </span>
              ) : null}
              {task.retrievalStatus && task.retrievalStatus !== primaryStatus ? (
                <span className={`inline-flex rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] ${agentTaskStatusTone(task.retrievalStatus)}`}>
                  {task.retrievalStatus}
                </span>
              ) : null}
            </div>
            <div className={`mt-1 flex flex-wrap items-center gap-2 text-[11px] ${isUser ? "text-background/68" : "text-muted-foreground"}`}>
              <code className="rounded-md bg-current/8 px-1.5 py-0.5 font-mono">{task.taskId}</code>
              {task.taskType ? <span>{task.taskType}</span> : null}
              {task.toolUseId ? <code className="rounded-md bg-current/8 px-1.5 py-0.5 font-mono">{task.toolUseId}</code> : null}
            </div>
            {stateBadges.length > 0 ? (
              <div className={`mt-2 flex flex-wrap gap-1.5 text-[10px] ${isUser ? "text-background/62" : "text-muted-foreground"}`}>
                {stateBadges.map((badge) => (
                  <span key={badge} className="rounded-md border border-current/15 bg-current/7 px-1.5 py-0.5 font-medium uppercase tracking-[0.12em]">
                    {badge}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-1.5">
          {canInspectRun ? (
            <Button
              type="button"
              size="sm"
              variant={isUser ? "secondary" : "outline"}
              className="h-7 rounded-lg px-2.5 text-xs"
              onClick={() => onInspectRun?.(task.childRunId ?? "")}
            >
              <Clock3 className="mr-1.5 h-3.5 w-3.5" />
              Inspect run
            </Button>
          ) : null}
          {canOpenSession ? (
            <Button
              type="button"
              size="sm"
              variant={isUser ? "secondary" : "outline"}
              className="h-7 rounded-lg px-2.5 text-xs"
              onClick={() => onOpenSession?.(task.taskId)}
            >
              <ArrowRight className="mr-1.5 h-3.5 w-3.5" />
              Open child session
            </Button>
          ) : null}
        </div>
      </div>

      {task.summary ? (
        <p className={`mt-3 text-sm leading-6 ${isUser ? "text-background/88" : "text-foreground/86"}`}>{task.summary}</p>
      ) : task.description ? (
        <p className={`mt-3 text-sm leading-6 ${isUser ? "text-background/88" : "text-foreground/86"}`}>{task.description}</p>
      ) : null}

      {bodyText ? (
        <div className={`mt-3 rounded-xl border px-3 py-2.5 ${isUser ? "border-white/10 bg-background/12" : "border-border/60 bg-background/68"}`}>
          <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-5">
            {expanded ? bodyText : preview}
            {!expanded && preview.length < bodyText.length ? "…" : null}
          </pre>
          {bodyText.length > preview.length ? (
            <button
              type="button"
              className={`mt-2 text-xs font-medium transition ${isUser ? "text-background/72 hover:text-background" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded ? "Collapse output" : "Show full output"}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className={`mt-3 flex flex-wrap gap-2 text-[11px] ${isUser ? "text-background/62" : "text-muted-foreground"}`}>
        {task.outputRef ? <code className="rounded-md bg-current/8 px-1.5 py-0.5 font-mono">{task.outputRef}</code> : null}
      </div>
    </div>
  );
}

export function CompactMetaRow({ message }: { message: Message }) {
  return (
    <div className="mt-2 flex flex-wrap items-center justify-center gap-2 text-[10px] font-medium text-muted-foreground/60">
      {message.runId ? <Badge variant="outline" className="h-5 rounded-md px-1.5 text-[10px]">{message.runId}</Badge> : null}
      <span>{formatTimestamp(message.createdAt)}</span>
    </div>
  );
}

export function CompactBoundaryCard({ message }: { message: Message }) {
  const estimatedInputTokens = readNumericMetadataValue(message.metadata, "estimatedInputTokens");
  const estimatedPostCompactTokens = readNumericMetadataValue(message.metadata, "estimatedPostCompactTokens");
  const contextWindowTokens = readNumericMetadataValue(message.metadata, "contextWindowTokens");
  const compactThresholdTokens = readNumericMetadataValue(message.metadata, "compactThresholdTokens");
  const summarizedMessageCount = readNumericMetadataValue(message.metadata, "summarizedMessageCount");

  return (
    <div className="mx-auto max-w-3xl">
      <div className="overflow-hidden rounded-2xl border border-amber-500/20 bg-gradient-to-r from-amber-500/10 via-background to-sky-500/10 px-4 py-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-center gap-2 text-center">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-amber-500/20 bg-amber-500/12 text-amber-700 dark:text-amber-300">
            <Archive className="h-4 w-4" />
          </span>
          <div>
            <div className="text-sm font-semibold tracking-tight text-foreground">Context Compacted</div>
            <div className="text-xs text-muted-foreground">Earlier history was compressed so the runtime can keep the active thread moving.</div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
          {estimatedInputTokens !== undefined || estimatedPostCompactTokens !== undefined ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/75 px-2.5 py-1 text-[11px] font-medium text-foreground/80">
              {formatCompactCount(estimatedInputTokens, "tokens") ?? "input"}
              <ArrowRight className="h-3 w-3 text-muted-foreground/70" />
              {formatCompactCount(estimatedPostCompactTokens, "tokens") ?? "after compact"}
            </span>
          ) : null}
          {compactThresholdTokens !== undefined ? (
            <span className="inline-flex rounded-full border border-border/60 bg-background/75 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
              threshold {compactThresholdTokens.toLocaleString()}
            </span>
          ) : null}
          {contextWindowTokens !== undefined ? (
            <span className="inline-flex rounded-full border border-border/60 bg-background/75 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
              window {contextWindowTokens.toLocaleString()}
            </span>
          ) : null}
          {summarizedMessageCount !== undefined ? (
            <span className="inline-flex rounded-full border border-border/60 bg-background/75 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
              summarized {summarizedMessageCount.toLocaleString()} messages
            </span>
          ) : null}
        </div>
      </div>
      <CompactMetaRow message={message} />
    </div>
  );
}

export function CompactSummaryCard({ message }: { message: Message }) {
  const [expanded, setExpanded] = useState(false);
  const contextWindowTokens = readNumericMetadataValue(message.metadata, "contextWindowTokens");
  const compactThresholdTokens = readNumericMetadataValue(message.metadata, "compactThresholdTokens");
  const keepRecentGroupCount = readNumericMetadataValue(message.metadata, "keepRecentGroupCount");
  const summarizedMessageCount = readNumericMetadataValue(message.metadata, "summarizedMessageCount");
  const summaryText = typeof message.content === "string" ? message.content : "";
  const preview = summaryText.slice(0, COMPACT_SUMMARY_PREVIEW_CHARS).trimEnd();

  return (
    <div className="mx-auto max-w-3xl">
      <div className="overflow-hidden rounded-3xl border border-sky-500/20 bg-gradient-to-br from-sky-500/12 via-background to-background px-5 py-4 shadow-sm">
        <div className="flex flex-wrap items-start gap-3">
          <span className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-2xl border border-sky-500/20 bg-sky-500/12 text-sky-700 dark:text-sky-300">
            <Sparkles className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-sm font-semibold tracking-tight text-foreground">Compaction Summary</div>
              {summarizedMessageCount !== undefined ? (
                <span className="inline-flex rounded-full border border-border/60 bg-background/75 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                  {summarizedMessageCount.toLocaleString()} msgs
                </span>
              ) : null}
              {keepRecentGroupCount !== undefined ? (
                <span className="inline-flex rounded-full border border-border/60 bg-background/75 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                  keep {keepRecentGroupCount}
                </span>
              ) : null}
            </div>
            <div className="mt-1 text-xs leading-6 text-muted-foreground">
              This summary stands in for earlier conversation context after compaction.
            </div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {compactThresholdTokens !== undefined ? (
            <span className="inline-flex rounded-full border border-border/60 bg-background/75 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
              threshold {compactThresholdTokens.toLocaleString()}
            </span>
          ) : null}
          {contextWindowTokens !== undefined ? (
            <span className="inline-flex rounded-full border border-border/60 bg-background/75 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
              window {contextWindowTokens.toLocaleString()}
            </span>
          ) : null}
        </div>
        <div className="mt-4 rounded-2xl border border-border/60 bg-background/70 px-4 py-3">
          {expanded ? (
            <DeferredConversationBlock
              estimatedHeight={estimateMarkdownBlockHeight(summaryText)}
              placeholderLabel="Rendering summary..."
              eager={summaryText.length < 1200}
            >
              <MarkdownText text={summaryText} />
            </DeferredConversationBlock>
          ) : (
            <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/85">
              {preview}
              {preview.length < summaryText.length ? "…" : null}
            </div>
          )}
        </div>
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setExpanded((current) => !current)}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground"
          >
            {expanded ? "Collapse summary" : "Show full summary"}
          </button>
        </div>
      </div>
      <CompactMetaRow message={message} />
    </div>
  );
}

export function isToolOnlyMessage(content: Message["content"]) {
  if (typeof content === "string") return false;

  const hasText = content.some((part) => part.type === "text" && "text" in part && part.text?.trim());
  const hasReasoning = content.some((part) => part.type === "reasoning");
  const hasToolOrApproval = content.some(
    (part) =>
      part.type === "tool-call" ||
      part.type === "tool-result" ||
      part.type === "tool-approval-request" ||
      part.type === "tool-approval-response"
  );

  return hasToolOrApproval && !hasText && !hasReasoning;
}

/** Render message content — text parts as prose, reasoning as visible context, tool calls/results as chips */
export function ImagePartsGrid({ parts }: { parts: Extract<MessagePart, { type: "image" }>[] }) {
  if (parts.length === 0) {
    return null;
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {parts.map((part, index) => (
        <a
          key={`${part.image}:${index}`}
          href={resolveImageSource(part)}
          target="_blank"
          rel="noopener noreferrer"
          className="group overflow-hidden rounded-2xl border border-border/60 bg-background/50"
        >
          <img
            src={resolveImageSource(part)}
            alt={`Attached image ${index + 1}`}
            className="max-h-80 w-full object-cover transition duration-200 group-hover:scale-[1.01]"
          />
        </a>
      ))}
    </div>
  );
}

export function MessageContent({
  content,
  isUser,
  compactTaskNotification = false,
  messageMetadata,
  isStreaming = false,
  onOpenSession,
  onInspectRun,
  onAnswerAskUserQuestion
}: {
  content: Message["content"];
  isUser?: boolean;
  compactTaskNotification?: boolean;
  messageMetadata?: Message["metadata"];
  isStreaming?: boolean;
  onOpenSession?: (sessionId: string) => void;
  onInspectRun?: (runId: string) => void;
  onAnswerAskUserQuestion?: (answer: string) => void;
}) {
  const structuredContent = typeof content === "string" ? [] : content;
  const { textParts, imageParts, reasoningParts, toolParts, approvalParts } = useMemo(
    () => partitionStructuredMessageContent(structuredContent),
    [structuredContent]
  );

  if (typeof content === "string") {
    const taskReference = parseAgentTaskReference(content);
    if (taskReference) {
      const taskWithMetadata = {
        ...taskReference,
        ...readTaskStateFromMetadata(messageMetadata)
      };
      return (
        <AgentTaskReferenceCard
          task={taskWithMetadata}
          {...(isUser !== undefined ? { isUser } : {})}
          compactNotification={compactTaskNotification && taskWithMetadata.kind === "notification"}
          {...(onOpenSession ? { onOpenSession } : {})}
          {...(onInspectRun ? { onInspectRun } : {})}
        />
      );
    }

    return <ExpandableMarkdownText text={content} {...(isUser !== undefined ? { isUser } : {})} />;
  }

  return (
    <div className="space-y-2">
      {imageParts.length > 0 ? <ImagePartsGrid parts={imageParts} /> : null}
      {reasoningParts.length > 0 && (
        <ReasoningBlock parts={reasoningParts} isStreaming={isStreaming} />
      )}
      {textParts.map((part, i) => (
        <div key={i}>
          {"text" in part && part.text ? (() => {
            const taskReference = parseAgentTaskReference(part.text);
            const taskWithMetadata = taskReference
              ? {
                  ...taskReference,
                  ...readTaskStateFromMetadata(messageMetadata)
                }
              : null;
            return taskReference ? (
              <AgentTaskReferenceCard
                task={taskWithMetadata ?? taskReference}
                {...(isUser !== undefined ? { isUser } : {})}
                compactNotification={compactTaskNotification && (taskWithMetadata ?? taskReference).kind === "notification"}
                {...(onOpenSession ? { onOpenSession } : {})}
                {...(onInspectRun ? { onInspectRun } : {})}
              />
            ) : (
              <ExpandableMarkdownText text={part.text} {...(isUser !== undefined ? { isUser } : {})} />
            );
          })() : null}
        </div>
      ))}
      {approvalParts.length > 0 && (
        <div className="space-y-1.5 pt-1">
          {approvalParts.map((part, i) => (
            <div
              key={i}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium ${
                part.type === "tool-approval-request"
                  ? toneBadgeClass("amber")
                  : "approved" in part && part.approved
                    ? toneBadgeClass("emerald")
                    : toneBadgeClass("rose")
              }`}
            >
              {part.type === "tool-approval-request" ? "⏳ approval requested" : "approved" in part && part.approved ? "✓ approved" : "✗ denied"}
              {"reason" in part && part.reason ? <span className="opacity-70">· {part.reason}</span> : null}
            </div>
          ))}
        </div>
      )}
      {toolParts.length > 0 && (
        <div className="space-y-2 pt-1">
          {toolParts.map((part, i) =>
            part.type === "tool-call" ? (
              <ToolCallBlock
                key={i}
                part={part as { type: "tool-call"; toolName?: string; input?: Record<string, unknown> }}
                messageMetadata={messageMetadata}
              />
            ) : (
              <ToolResultBlock
                key={i}
                part={part as { type: "tool-result"; toolName?: string; output?: ToolResultOutput }}
                messageMetadata={messageMetadata}
                {...(onAnswerAskUserQuestion ? { onAnswerAskUserQuestion } : {})}
              />
            )
          )}
        </div>
      )}
    </div>
  );
}

export function ReasoningBlock({
  parts,
  isStreaming
}: {
  parts: Extract<MessagePart, { type: "reasoning" }>[];
  isStreaming: boolean;
}) {
  const [expanded, setExpanded] = useState(isStreaming);
  const hasAutoExpandedRef = useRef(isStreaming);
  const previousStreamingRef = useRef(isStreaming);

  useEffect(() => {
    if (isStreaming && parts.length > 0 && !hasAutoExpandedRef.current) {
      hasAutoExpandedRef.current = true;
      setExpanded(true);
    }
  }, [isStreaming, parts.length]);

  useEffect(() => {
    if (previousStreamingRef.current && !isStreaming) {
      setExpanded(false);
    }
    previousStreamingRef.current = isStreaming;
  }, [isStreaming]);

  return (
    <div className="group/reasoning">
      <button type="button" className="cursor-pointer select-none" onClick={() => setExpanded((current) => !current)} aria-expanded={expanded}>
        <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium transition ${toneBadgeClass("plum")}`}>
          <Sparkles className="h-3 w-3 opacity-70" /> reasoning
          <span className="opacity-50 text-[10px]">{expanded ? "▾" : "▸"}</span>
        </span>
      </button>
      {expanded ? (
        <DeferredConversationBlock
          estimatedHeight={Math.min(520, Math.max(140, parts.reduce((sum, part) => sum + (part.text?.length ?? 0), 0) / 8))}
          placeholderLabel="Rendering reasoning..."
          eager={parts.every((part) => (part.text?.length ?? 0) < 900)}
        >
          <div className={`mt-1.5 rounded-lg border px-3 py-2 ${toneBadgeClass("plum")}`}>
            <div className="space-y-2">
              {parts.map((part, i) =>
                "text" in part && part.text ? (
                  <div key={i}>
                    <ExpandableMarkdownText
                      text={part.text}
                      collapseThreshold={1600}
                      previewChars={700}
                      expandLabel="Show full reasoning"
                      collapseLabel="Collapse reasoning"
                    />
                  </div>
                ) : null
              )}
            </div>
          </div>
        </DeferredConversationBlock>
      ) : null}
    </div>
  );
}

export type ConversationMessageRowProps = {
  message: Message;
  agentName?: string;
  agentMode?: "primary" | "subagent" | "all";
  onInspectRun: (runId: string) => void;
  onOpenSession?: (sessionId: string) => void;
  onAnswerAskUserQuestion?: (answer: string) => void;
};

export const ConversationMessageRow = memo(function ConversationMessageRow(props: ConversationMessageRowProps) {
  const { message, agentName, agentMode, onInspectRun, onOpenSession, onAnswerAskUserQuestion } = props;
  const isTaskNotification = isTaskNotificationMessage(message);
  const isHumanUser = message.role === "user" && !isTaskNotification;
  const isStreaming = message.id.startsWith("live:");
  const runtimeKind = readRuntimeKind(message.metadata);
  const isToolOnly = !isHumanUser && !isTaskNotification && isToolOnlyMessage(message.content);
  const deferredRenderStyle = isStreaming
    ? undefined
    : ({
        contentVisibility: "auto",
        containIntrinsicSize: runtimeKind ? "160px" : isTaskNotification ? "88px" : isToolOnly ? "112px" : isHumanUser ? "180px" : "240px"
      } as const);

  if (runtimeKind === "compact_boundary") {
    return (
      <article className="animate-fade-in py-2 md:py-3" style={deferredRenderStyle}>
        <CompactBoundaryCard message={message} />
      </article>
    );
  }

  if (runtimeKind === "compact_summary") {
    return (
      <article className="animate-fade-in py-2 md:py-3" style={deferredRenderStyle}>
        <CompactSummaryCard message={message} />
      </article>
    );
  }

  if (isTaskNotification) {
    const taskReference = parseAgentTaskReferenceFromMessage(message);

    return (
      <article className="group/message animate-fade-in py-2 md:py-3" style={deferredRenderStyle}>
        {taskReference ? (
          <AgentTaskReferenceCard
            task={taskReference}
            compactNotification
            isUser={false}
            {...(onOpenSession ? { onOpenSession } : {})}
            onInspectRun={onInspectRun}
          />
        ) : (
          <div className="mx-auto max-w-3xl rounded-xl border border-border/60 bg-background/75 px-3 py-2 text-sm text-muted-foreground shadow-sm">
            <MessageContent
              content={message.content}
              isUser={false}
              compactTaskNotification
              messageMetadata={message.metadata}
              isStreaming={isStreaming}
              {...(onOpenSession ? { onOpenSession } : {})}
              onInspectRun={onInspectRun}
              {...(onAnswerAskUserQuestion ? { onAnswerAskUserQuestion } : {})}
            />
          </div>
        )}
        <div className="mx-auto mt-1.5 flex max-w-3xl flex-wrap items-center justify-center gap-2 text-[10px] font-medium text-muted-foreground/50 max-md:visible max-md:opacity-100 md:invisible md:opacity-0 md:pointer-events-none md:group-hover/message:visible md:group-hover/message:opacity-100 md:group-hover/message:pointer-events-auto md:group-focus-within/message:visible md:group-focus-within/message:opacity-100 md:group-focus-within/message:pointer-events-auto">
          {message.runId ? (
            <Button
              variant="outline"
              size="sm"
              className="h-5 rounded-md px-1.5 text-[10px]"
              onClick={() => onInspectRun(message.runId ?? "")}
            >
              {message.runId}
            </Button>
          ) : null}
          <span>Task notification</span>
          <span>{formatTimestamp(message.createdAt)}</span>
        </div>
      </article>
    );
  }

  return (
    <article
      className={`group/message animate-fade-in flex gap-3 md:gap-4 py-2 md:py-3 ${isHumanUser ? "flex-row-reverse" : ""}`}
      style={deferredRenderStyle}
    >
      <div
        className={`conversation-avatar flex-shrink-0 w-8 h-8 md:w-9 md:h-9 rounded-full flex items-center justify-center text-sm shadow-elegant overflow-hidden ${
          isHumanUser ? "bg-foreground text-background text-xs font-medium" : "bg-muted"
        }`}
      >
        {isHumanUser ? "You" : "AI"}
      </div>

      <div className={`flex-1 ${isHumanUser ? "max-w-[85%] md:max-w-[75%] text-right" : isToolOnly ? "max-w-[95%]" : "max-w-[95%] md:max-w-[85%]"}`}>
        <div
          className={
            isToolOnly
              ? "selection-surface"
              : isHumanUser
              ? "conversation-message-bubble conversation-message-bubble-user selection-inverse inline-block select-text text-left rounded-2xl px-4 py-3 bg-foreground text-background shadow-elegant border-elegant"
              : "conversation-message-bubble conversation-message-bubble-assistant selection-surface select-text rounded-2xl px-4 py-3 shadow-elegant border-elegant hover-lift bg-card"
          }
        >
          <MessageContent
            content={message.content}
            isUser={isHumanUser}
            messageMetadata={message.metadata}
            isStreaming={isStreaming}
            {...(onOpenSession ? { onOpenSession } : {})}
            onInspectRun={onInspectRun}
            {...(onAnswerAskUserQuestion ? { onAnswerAskUserQuestion } : {})}
          />
        </div>
        <div
          className={`mt-1.5 flex min-h-5 flex-wrap items-center gap-2 text-[10px] font-medium text-muted-foreground/50 max-md:visible max-md:opacity-100 md:invisible md:opacity-0 md:pointer-events-none md:group-hover/message:visible md:group-hover/message:opacity-100 md:group-hover/message:pointer-events-auto md:group-focus-within/message:visible md:group-focus-within/message:opacity-100 md:group-focus-within/message:pointer-events-auto ${isHumanUser ? "justify-end" : ""}`}
        >
          {message.runId ? (
            <Button
              variant="outline"
              size="sm"
              className="h-5 rounded-md px-1.5 text-[10px]"
              onClick={() => onInspectRun(message.runId ?? "")}
            >
              {message.runId}
            </Button>
          ) : null}
          {isStreaming ? <span className="uppercase tracking-[0.14em]">Streaming</span> : null}
          {!isHumanUser && agentName ? (
            <>
              <Badge variant="outline" className="h-5 rounded-md px-1.5 text-[10px] font-medium">
                {agentName}
              </Badge>
              {agentMode ? (
                <span
                  className={`inline-flex h-5 items-center rounded-md border px-1.5 text-[10px] font-medium uppercase tracking-[0.12em] ${agentModeTone(agentMode)}`}
                >
                  {agentMode}
                </span>
              ) : null}
            </>
          ) : null}
          <span>{formatTimestamp(message.createdAt)}</span>
        </div>
      </div>
    </article>
  );
});
