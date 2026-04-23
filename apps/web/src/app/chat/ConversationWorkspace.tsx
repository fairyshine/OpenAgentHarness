import { memo, useEffect, useRef, useCallback, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Archive, ArrowRight, Bot, ChevronRight, CornerDownRight, Folder, ImagePlus, Loader2, RefreshCw, Send, Sparkles, Square, Wrench, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

import { useStreamStore } from "../stores/stream-store";
import { useUiStore } from "../stores/ui-store";
import { formatTimestamp, statusTone, toneBadgeClass } from "../support";
import type { Message, MessagePart } from "@oah/api-contracts";
import type { useAppController } from "../use-app-controller";
import { Badge } from "@/components/ui/badge";
import { WorkspaceFileManagerPanel } from "./WorkspaceFileManagerPanel";
import { buildMessageAgentInfoIndex } from "./message-agent-info";
import type { DraftImageAttachment } from "./composer-content";

type RuntimeProps = ReturnType<typeof useAppController>["runtimeDetailSurfaceProps"];
type ToolStatus = "running" | "started" | "completed" | "failed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isImageFile(file: File) {
  return file.type.startsWith("image/");
}

function createClientId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  if (typeof globalThis.crypto?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex
      .slice(8, 10)
      .join("")}-${hex.slice(10, 16).join("")}`;
  }

  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function parseDataUrl(dataUrl: string): { mediaType: string; base64Data: string } | null {
  const match = dataUrl.match(/^data:([^;,]+)?;base64,(.+)$/u);
  if (!match) {
    return null;
  }

  return {
    mediaType: match[1] ?? "image/png",
    base64Data: match[2] ?? ""
  };
}

function readFileAsDataUrl(file: File): Promise<string> {
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

async function filesToDraftImageAttachments(files: FileList | File[]): Promise<DraftImageAttachment[]> {
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

function formatAttachmentSize(size: number) {
  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(size >= 10 * 1024 ? 0 : 1)} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatAttachmentType(mediaType: string) {
  const normalized = mediaType.toLowerCase();
  if (normalized === "image/jpeg") {
    return "JPG";
  }

  if (normalized.startsWith("image/")) {
    return normalized.slice("image/".length).toUpperCase();
  }

  return mediaType.toUpperCase();
}

function resolveImageSource(part: Extract<MessagePart, { type: "image" }>) {
  const value = part.image.trim();
  if (value.startsWith("data:") || /^https?:\/\//iu.test(value) || value.startsWith("blob:")) {
    return value;
  }

  return `data:${part.mediaType ?? "image/png"};base64,${value}`;
}

function agentModeTone(mode: "primary" | "subagent" | "all") {
  switch (mode) {
    case "primary":
      return toneBadgeClass("sky");
    case "subagent":
      return toneBadgeClass("amber");
    case "all":
      return toneBadgeClass("emerald");
  }
}

function toolStatusTone(status: ToolStatus) {
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

function readToolMeta(messageMetadata: Message["metadata"] | undefined) {
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

function formatToolDuration(durationMs: number | undefined) {
  if (durationMs === undefined || !Number.isFinite(durationMs)) {
    return null;
  }

  if (durationMs < 1000) {
    return `${Math.max(0, Math.round(durationMs))} ms`;
  }

  return `${(durationMs / 1000).toFixed(durationMs >= 10000 ? 0 : 1)} s`;
}

const LONG_MESSAGE_COLLAPSE_CHARS = 2800;
const LONG_MESSAGE_PREVIEW_CHARS = 1200;
const COMPACT_SUMMARY_PREVIEW_CHARS = 900;

type CompactRuntimeKind = "compact_boundary" | "compact_summary";

function readRuntimeKind(messageMetadata: Message["metadata"] | undefined): CompactRuntimeKind | undefined {
  if (!isRecord(messageMetadata)) {
    return undefined;
  }

  return messageMetadata.runtimeKind === "compact_boundary" || messageMetadata.runtimeKind === "compact_summary"
    ? messageMetadata.runtimeKind
    : undefined;
}

function readNumericMetadataValue(messageMetadata: Message["metadata"] | undefined, key: string) {
  if (!isRecord(messageMetadata)) {
    return undefined;
  }

  const value = messageMetadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatCompactCount(value: number | undefined, suffix: string) {
  if (value === undefined) {
    return null;
  }

  return `${value.toLocaleString()} ${suffix}`;
}

function ExpandableMarkdownText({
  text,
  isUser,
  collapseThreshold = LONG_MESSAGE_COLLAPSE_CHARS,
  previewChars = LONG_MESSAGE_PREVIEW_CHARS,
  expandLabel = "Expand full message",
  collapseLabel = "Collapse"
}: {
  text: string;
  isUser?: boolean;
  collapseThreshold?: number;
  previewChars?: number;
  expandLabel?: string;
  collapseLabel?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const shouldCollapse = text.length > collapseThreshold;
  const preview = text.slice(0, previewChars).trimEnd();

  if (!shouldCollapse) {
    return <MarkdownText text={text} {...(isUser !== undefined ? { isUser } : {})} />;
  }

  return (
    <div className="space-y-3">
      {expanded ? (
        <MarkdownText text={text} {...(isUser !== undefined ? { isUser } : {})} />
      ) : (
        <div
          className={`rounded-xl border px-3 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words ${
            isUser
              ? "border-white/10 bg-background/18 text-background/90"
              : "border-border/60 bg-muted/35 text-foreground/85"
          }`}
        >
          {preview}
          {preview.length < text.length ? "…" : null}
        </div>
      )}
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground"
      >
        {expanded ? collapseLabel : expandLabel}
        <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/70">
          {text.length.toLocaleString()} chars
        </span>
      </button>
    </div>
  );
}

function CompactMetaRow({ message }: { message: Message }) {
  return (
    <div className="mt-2 flex flex-wrap items-center justify-center gap-2 text-[10px] font-medium text-muted-foreground/60">
      {message.runId ? <Badge variant="outline" className="h-5 rounded-md px-1.5 text-[10px]">{message.runId}</Badge> : null}
      <span>{formatTimestamp(message.createdAt)}</span>
    </div>
  );
}

function CompactBoundaryCard({ message }: { message: Message }) {
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

function CompactSummaryCard({ message }: { message: Message }) {
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
            <MarkdownText text={summaryText} />
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

function MarkdownText({ text, isUser }: { text: string; isUser?: boolean }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="mb-2 last:mb-0 text-sm leading-relaxed">{children}</p>,
        h1: ({ children }) => <h1 className="text-lg font-semibold mb-2 mt-3 first:mt-0">{children}</h1>,
        h2: ({ children }) => <h2 className="text-base font-semibold mb-2 mt-3 first:mt-0">{children}</h2>,
        h3: ({ children }) => <h3 className="text-sm font-semibold mb-1.5 mt-2 first:mt-0">{children}</h3>,
        ul: ({ children }) => <ul className="list-disc pl-4 mb-2 space-y-0.5 text-sm">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal pl-4 mb-2 space-y-0.5 text-sm">{children}</ol>,
        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
        code: ({ children, className }) => {
          const isBlock = className?.includes("language-");
          if (isBlock) {
            return (
              <code className="block font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
                {children}
              </code>
            );
          }
          return (
            <code className={`font-mono text-xs px-1.5 py-0.5 rounded-md ${isUser ? "bg-background/18 ring-1 ring-white/10" : "bg-muted/85 ring-1 ring-black/5"}`}>
              {children}
            </code>
          );
        },
        pre: ({ children }) => (
          <pre className={`rounded-xl p-3 mb-2 overflow-auto text-xs font-mono leading-relaxed shadow-inner ${isUser ? "bg-background/18 ring-1 ring-white/10" : "bg-muted/55 border border-border/60"}`}>
            {children}
          </pre>
        ),
        blockquote: ({ children }) => (
          <blockquote className={`border-l-2 pl-3 my-2 text-sm italic ${isUser ? "border-background/40 opacity-80" : "border-border text-muted-foreground"}`}>
            {children}
          </blockquote>
        ),
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:opacity-80">
            {children}
          </a>
        ),
        strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
        hr: () => <hr className="my-3 border-current opacity-20" />,
        table: ({ children }) => (
          <div className="overflow-auto mb-2">
            <table className="text-xs border-collapse w-full">{children}</table>
          </div>
        ),
        th: ({ children }) => <th className="border border-current/20 px-2 py-1 font-semibold text-left bg-current/5">{children}</th>,
        td: ({ children }) => <td className="border border-current/20 px-2 py-1">{children}</td>,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

type ParamKind = "string" | "number" | "boolean" | "null" | "array" | "object" | "unknown";

function getParamKind(value: unknown): ParamKind {
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return "unknown";
}

function paramTypeBadgeClass(kind: ParamKind) {
  switch (kind) {
    case "string":   return toneBadgeClass("sky");
    case "number":   return toneBadgeClass("emerald");
    case "boolean":  return toneBadgeClass("plum");
    case "null":     return "border-border/60 bg-muted/60 text-muted-foreground";
    case "array":
    case "object":   return toneBadgeClass("amber");
    default:         return "border-border/60 bg-muted/60 text-muted-foreground";
  }
}

function ToolCallBlock({
  part,
  messageMetadata
}: {
  part: { type: "tool-call"; toolName?: string; input?: Record<string, unknown> };
  messageMetadata?: Message["metadata"];
}) {
  const [expanded, setExpanded] = useState(true);
  const params = part.input ?? {};
  const hasParams = Object.keys(params).length > 0;
  const toolMeta = readToolMeta(messageMetadata);
  const durationLabel = formatToolDuration(toolMeta.durationMs);

  return (
    <div className="info-panel rounded-2xl overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="info-panel-hoverable w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-left"
      >
        <ChevronRight className={`w-3 h-3 text-foreground/50 transition-transform flex-shrink-0 ${expanded ? "rotate-90" : ""}`} />
        <span className="info-inline inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-medium text-muted-foreground/80">
          tool call
        </span>
        <Wrench className="w-3 h-3 text-foreground/40 flex-shrink-0" />
        <code className="text-[11px] font-mono font-semibold text-foreground/80">{part.toolName ?? "unknown"}</code>
        {toolMeta.status ? (
          <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${toolStatusTone(toolMeta.status)}`}>
            {toolMeta.status === "running" ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
            {toolMeta.status}
          </span>
        ) : null}
        {toolMeta.sourceType ? (
          <span className="info-inline inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/75">
            {toolMeta.sourceType}
          </span>
        ) : null}
        {durationLabel ? (
          <span className="info-inline inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-medium text-muted-foreground/75">
            {durationLabel}
          </span>
        ) : null}
        {hasParams && (
          <span className="text-xs text-muted-foreground/50 truncate flex-1">
            · {Object.keys(params).join(", ")}
          </span>
        )}
      </button>
      {expanded && (
        <div className="border-t border-border/40 px-4 py-3">
          {hasParams ? (
            <div className="space-y-2">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/60 mb-2">Parameters</div>
              {Object.entries(params).map(([key, value]) => {
                const kind = getParamKind(value);
                const isMultiline = typeof value === "string" && value.includes("\n");
                return (
                  <div key={key} className="rounded-xl border border-border/50 bg-background/40 px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-2 mb-2">
                      <span className="inline-flex items-center rounded-md border border-primary/15 bg-primary/5 px-2 py-0.5 text-[11px] font-mono font-semibold text-primary/90">
                        {key}
                      </span>
                      <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${paramTypeBadgeClass(kind)}`}>
                        {kind}
                      </span>
                    </div>
                    <div className="text-xs font-mono text-foreground/80">
                      {typeof value === "string" ? (
                        isMultiline ? (
                          <pre className={`rounded-lg border px-3 py-2 whitespace-pre-wrap break-all max-h-48 overflow-y-auto ${toneBadgeClass("sky")}`}>
                            {value}
                          </pre>
                        ) : (
                          <span className={`inline-flex items-center rounded-md border px-2 py-1 ${toneBadgeClass("sky")}`}>
                            <span className="opacity-50 mr-0.5">"</span>{value}<span className="opacity-50 ml-0.5">"</span>
                          </span>
                        )
                      ) : typeof value === "number" ? (
                        <span className={`inline-flex items-center rounded-md border px-2 py-1 ${toneBadgeClass("emerald")}`}>{value}</span>
                      ) : typeof value === "boolean" ? (
                        <span className={`inline-flex items-center rounded-md border px-2 py-1 ${toneBadgeClass("plum")}`}>{String(value)}</span>
                      ) : value === null ? (
                        <span className="info-inline inline-flex items-center rounded-md px-2 py-1 text-muted-foreground">null</span>
                      ) : (
                        <pre className="code-panel rounded-lg px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
                          {JSON.stringify(value, null, 2)}
                        </pre>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <span className="text-xs text-muted-foreground/50 italic">no parameters</span>
          )}
        </div>
      )}
    </div>
  );
}

type ToolResultOutput = { type: string; value?: unknown; reason?: string };

function resolveToolResultContent(output: ToolResultOutput | undefined): { content: string; isError: boolean } {
  if (!output) return { content: "", isError: false };
  switch (output.type) {
    case "text":
      return { content: typeof output.value === "string" ? output.value : "", isError: false };
    case "json":
      return { content: JSON.stringify(output.value, null, 2), isError: false };
    case "error-text":
      return { content: typeof output.value === "string" ? output.value : "", isError: true };
    case "error-json":
      return { content: JSON.stringify(output.value, null, 2), isError: true };
    case "execution-denied":
      return { content: output.reason ?? "execution denied", isError: true };
    case "content":
      return { content: JSON.stringify(output.value, null, 2), isError: false };
    default:
      return { content: JSON.stringify(output, null, 2), isError: false };
  }
}

function ToolResultBlock({
  part,
  messageMetadata
}: {
  part: { type: "tool-result"; toolName?: string; output?: ToolResultOutput };
  messageMetadata?: Message["metadata"];
}) {
  const [expanded, setExpanded] = useState(true);
  const { content, isError } = resolveToolResultContent(part.output);
  const preview = content.slice(0, 60).replace(/\n/g, " ") + (content.length > 60 ? "…" : "");
  const toolMeta = readToolMeta(messageMetadata);
  const durationLabel = formatToolDuration(toolMeta.durationMs);

  return (
    <div className={isError ? "rounded-2xl border border-destructive/20 bg-destructive/5 overflow-hidden shadow-sm" : "info-panel rounded-2xl overflow-hidden"}>
      <button
        onClick={() => setExpanded(!expanded)}
        className={`${isError ? "w-full flex items-center gap-2.5 px-4 py-2.5 text-sm transition-colors text-left hover:bg-destructive/10" : "info-panel-hoverable w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-left"}`}
      >
        <ChevronRight className={`w-3 h-3 transition-transform flex-shrink-0 ${expanded ? "rotate-90" : ""} ${isError ? "text-destructive/70" : "text-foreground/50"}`} />
        <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-medium ${isError ? "border-destructive/20 bg-destructive/10 text-destructive" : "border-primary/15 bg-primary/5 text-primary/85"}`}>
          {isError ? "error" : "result"}
        </span>
        <CornerDownRight className={`w-3 h-3 flex-shrink-0 ${isError ? "text-destructive/60" : "text-foreground/40"}`} />
        {part.toolName && (
          <code className="info-inline inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-mono text-foreground/70">
            {part.toolName}
          </code>
        )}
        {toolMeta.status ? (
          <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${toolStatusTone(toolMeta.status)}`}>
            {toolMeta.status}
          </span>
        ) : null}
        {toolMeta.sourceType ? (
          <span className="info-inline inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/75">
            {toolMeta.sourceType}
          </span>
        ) : null}
        {durationLabel ? (
          <span className="info-inline inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-medium text-muted-foreground/75">
            {durationLabel}
          </span>
        ) : null}
        <span className={`text-xs truncate flex-1 ${isError ? "text-destructive/80" : "text-muted-foreground/60"}`}>
          {preview}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border/40 px-4 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/60 mb-2">Output</div>
          <pre className={`rounded-xl border px-3 py-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all max-h-64 overflow-y-auto shadow-sm ${
            isError
              ? "border-destructive/20 bg-destructive/5 text-destructive/90"
              : "code-panel"
          }`}>
            {content}
          </pre>
        </div>
      )}
    </div>
  );
}

function isToolOnlyMessage(content: Message["content"]) {
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

type ConversationComposerProps = Pick<
  RuntimeProps,
  "refreshMessages" | "sendMessage" | "cancelCurrentRun"
> & {
  isRunning: boolean;
  isSwitchingSessionAgent: boolean;
};

const ConversationComposer = memo(function ConversationComposer(props: ConversationComposerProps) {
  const draftMessage = useStreamStore((state) => state.draftMessage);
  const draftAttachments = useStreamStore((state) => state.draftAttachments);
  const setDraftMessage = useStreamStore((state) => state.setDraftMessage);
  const setDraftAttachments = useStreamStore((state) => state.setDraftAttachments);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const hasDraftMessage = draftMessage.trim().length > 0;
  const hasDraftAttachments = draftAttachments.length > 0;
  const canSend = !props.isSwitchingSessionAgent && (hasDraftMessage || hasDraftAttachments);
  const inputPlaceholder = props.isRunning
    ? "当前 run 正在执行，回车会先加入队列，也可以拖入图片"
    : props.isSwitchingSessionAgent
    ? "Updating session agent…"
    : "Message the current session or drop images here";

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  }, [draftMessage]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (canSend) {
          props.sendMessage();
        }
      }
    },
    [canSend, props.sendMessage]
  );

  const appendAttachments = useCallback(
    async (files: FileList | File[]) => {
      const nextAttachments = await filesToDraftImageAttachments(files);
      if (nextAttachments.length === 0) {
        return;
      }

      setDraftAttachments((current) => [...current, ...nextAttachments]);
    },
    [setDraftAttachments]
  );

  const handleFileSelection = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (!files || files.length === 0) {
        return;
      }

      await appendAttachments(files);
      event.target.value = "";
    },
    [appendAttachments]
  );

  const handleDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if ([...event.dataTransfer.items].some((item) => item.kind === "file")) {
      event.preventDefault();
      setIsDraggingFiles(true);
    }
  }, []);

  const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if ([...event.dataTransfer.items].some((item) => item.kind === "file")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setIsDraggingFiles(true);
    }
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }

    setIsDraggingFiles(false);
  }, []);

  const handleDrop = useCallback(
    async (event: React.DragEvent<HTMLDivElement>) => {
      if (event.dataTransfer.files.length === 0) {
        return;
      }

      event.preventDefault();
      setIsDraggingFiles(false);
      await appendAttachments(event.dataTransfer.files);
    },
    [appendAttachments]
  );

  const handlePaste = useCallback(
    async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const imageFiles = [...event.clipboardData.files].filter(isImageFile);
      if (imageFiles.length === 0) {
        return;
      }

      event.preventDefault();
      await appendAttachments(imageFiles);
    },
    [appendAttachments]
  );

  const removeAttachment = useCallback(
    (attachmentId: string) => {
      setDraftAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
    },
    [setDraftAttachments]
  );

  return (
    <div
      className={`pointer-events-auto relative rounded-2xl px-3 pb-3 pt-2 shadow-lg transition ${isDraggingFiles ? "ring-2 ring-sky-400/60" : ""} ${
        draftAttachments.length > 0 ? "mt-28" : ""
      }`}
      style={{
        background: "color-mix(in srgb, var(--background) 80%, transparent)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        border: "1px solid color-mix(in srgb, var(--foreground) 12%, transparent)"
      }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handleFileSelection}
      />
      {draftAttachments.length > 0 ? (
        <div className="pointer-events-none absolute inset-x-3 bottom-full mb-3 overflow-x-auto">
          <div className="pointer-events-auto flex min-w-max items-end gap-2 pr-6">
            {draftAttachments.map((attachment) => (
              <div
                key={attachment.id}
                className="group relative flex h-[92px] w-[92px] shrink-0 overflow-hidden rounded-2xl border border-white/35 bg-background/92 shadow-[0_16px_36px_-26px_rgba(15,23,42,0.45)] ring-1 ring-black/5 backdrop-blur"
              >
                <img src={attachment.previewUrl} alt={attachment.name} className="h-full w-full object-cover" />
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/65 via-black/25 to-transparent px-2 pb-2 pt-5 text-white">
                  <div className="truncate text-[11px] font-medium">{attachment.name}</div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-white/80">
                    <span>{formatAttachmentType(attachment.mediaType)}</span>
                    <span className="h-1 w-1 rounded-full bg-white/55" />
                    <span>{formatAttachmentSize(attachment.size)}</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => removeAttachment(attachment.id)}
                  className="absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-full border border-white/45 bg-black/45 text-white shadow-sm transition hover:bg-black/65"
                  aria-label={`Remove ${attachment.name}`}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex items-end gap-2">
        <Button
          onClick={props.refreshMessages}
          variant="ghost"
          size="icon"
          className="h-9 w-9 flex-shrink-0"
          title="Refresh messages"
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
        <Button
          onClick={() => fileInputRef.current?.click()}
          size="icon"
          variant="ghost"
          className="h-9 w-9 flex-shrink-0"
          title="Attach images"
        >
          <ImagePlus className="h-4 w-4" />
        </Button>

        <div className="flex-1">
          <Textarea
            ref={textareaRef}
            value={draftMessage}
            onChange={(event) => setDraftMessage(event.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={inputPlaceholder}
            disabled={props.isSwitchingSessionAgent}
            rows={1}
            className="min-h-[24px] max-h-[200px] flex-1 resize-none border-none bg-transparent px-0 py-2.5 text-sm shadow-none outline-none focus-visible:ring-0 disabled:opacity-50"
          />
        </div>

        {!props.isRunning || canSend ? (
          <Button
            onClick={props.sendMessage}
            disabled={!canSend}
            size="icon"
            className="shadow-elegant h-9 w-9 flex-shrink-0"
            title="Send message"
          >
            <Send className="h-4 w-4" />
          </Button>
        ) : null}

        {props.isRunning ? (
          <Button
            onClick={props.cancelCurrentRun}
            size="icon"
            variant="ghost"
            className="h-9 w-9 flex-shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10"
            title="Stop run"
          >
            <Square className="h-4 w-4 fill-current" />
          </Button>
        ) : null}
      </div>

      {isDraggingFiles ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-2xl border border-dashed border-sky-400/60 bg-sky-500/10">
          <span className="rounded-full border border-sky-300/40 bg-background/92 px-3 py-1 text-xs font-medium text-foreground shadow-sm">
            Drop images to attach
          </span>
        </div>
      ) : null}
    </div>
  );
});

/** Render message content — text parts as prose, reasoning as visible context, tool calls/results as chips */
function ImagePartsGrid({ parts }: { parts: Extract<MessagePart, { type: "image" }>[] }) {
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

function MessageContent({
  content,
  isUser,
  messageMetadata,
  isStreaming = false
}: {
  content: Message["content"];
  isUser?: boolean;
  messageMetadata?: Message["metadata"];
  isStreaming?: boolean;
}) {
  if (typeof content === "string") {
    return <ExpandableMarkdownText text={content} {...(isUser !== undefined ? { isUser } : {})} />;
  }

  const textParts = content.filter((p) => p.type === "text");
  const imageParts = content.filter((p) => p.type === "image") as Extract<MessagePart, { type: "image" }>[];
  const reasoningParts = content.filter((p) => p.type === "reasoning") as Extract<MessagePart, { type: "reasoning" }>[];
  const toolParts = content.filter((p) => p.type === "tool-call" || p.type === "tool-result");
  const approvalParts = content.filter((p) => p.type === "tool-approval-request" || p.type === "tool-approval-response");

  return (
    <div className="space-y-2">
      {imageParts.length > 0 ? <ImagePartsGrid parts={imageParts} /> : null}
      {reasoningParts.length > 0 && (
        <ReasoningBlock parts={reasoningParts} isStreaming={isStreaming} />
      )}
      {textParts.map((part, i) => (
        <div key={i}>
          {"text" in part && part.text ? (
            <ExpandableMarkdownText text={part.text} {...(isUser !== undefined ? { isUser } : {})} />
          ) : null}
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
              />
            )
          )}
        </div>
      )}
    </div>
  );
}

function ReasoningBlock({
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
      ) : null}
    </div>
  );
}

type ConversationMessageRowProps = {
  message: Message;
  agentName?: string;
  agentMode?: "primary" | "subagent" | "all";
  onInspectRun: (runId: string) => void;
};

const ConversationMessageRow = memo(function ConversationMessageRow(props: ConversationMessageRowProps) {
  const { message, agentName, agentMode, onInspectRun } = props;
  const isUser = message.role === "user";
  const isStreaming = message.id.startsWith("live:");
  const runtimeKind = readRuntimeKind(message.metadata);
  const isToolOnly = !isUser && isToolOnlyMessage(message.content);

  if (runtimeKind === "compact_boundary") {
    return (
      <article className="animate-fade-in py-2 md:py-3">
        <CompactBoundaryCard message={message} />
      </article>
    );
  }

  if (runtimeKind === "compact_summary") {
    return (
      <article className="animate-fade-in py-2 md:py-3">
        <CompactSummaryCard message={message} />
      </article>
    );
  }

  return (
    <article className={`group/message animate-fade-in flex gap-3 md:gap-4 py-2 md:py-3 ${isUser ? "flex-row-reverse" : ""}`}>
      <div
        className={`flex-shrink-0 w-8 h-8 md:w-9 md:h-9 rounded-full flex items-center justify-center text-sm shadow-elegant overflow-hidden ${
          isUser ? "bg-foreground text-background text-xs font-medium" : "bg-muted"
        }`}
      >
        {isUser ? "You" : "AI"}
      </div>

      <div className={`flex-1 ${isUser ? "max-w-[85%] md:max-w-[75%] text-right" : isToolOnly ? "max-w-[95%]" : "max-w-[95%] md:max-w-[85%]"}`}>
        <div
          className={
            isToolOnly
              ? "selection-surface"
              : isUser
              ? "selection-inverse inline-block select-text text-left rounded-2xl px-4 py-3 bg-foreground text-background shadow-elegant border-elegant"
              : "selection-surface select-text rounded-2xl px-4 py-3 shadow-elegant border-elegant hover-lift bg-card"
          }
        >
          <MessageContent content={message.content} isUser={isUser} messageMetadata={message.metadata} isStreaming={isStreaming} />
          {isStreaming ? (
            <span className="mt-1 inline-block h-4 w-0.5 animate-pulse bg-current opacity-60" />
          ) : null}
        </div>
        <div
          className={`mt-1.5 flex min-h-5 flex-wrap items-center gap-2 text-[10px] font-medium text-muted-foreground/50 max-md:visible max-md:opacity-100 md:invisible md:opacity-0 md:pointer-events-none md:group-hover/message:visible md:group-hover/message:opacity-100 md:group-hover/message:pointer-events-auto md:group-focus-within/message:visible md:group-focus-within/message:opacity-100 md:group-focus-within/message:pointer-events-auto ${isUser ? "justify-end" : ""}`}
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
          {!isUser && agentName ? (
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

type QueuedRunsPanelProps = Pick<RuntimeProps, "guideQueuedSessionInput" | "guideMessageSupported"> & {
  items: RuntimeProps["queuedSessionRuns"];
};

const QueuedRunsPanel = memo(function QueuedRunsPanel(props: QueuedRunsPanelProps) {
  if (props.items.length === 0) {
    return null;
  }

  return (
    <div
      className="pointer-events-auto mb-3 rounded-2xl border px-3 py-3 shadow-lg"
      style={{
        background: "color-mix(in srgb, var(--background) 88%, transparent)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        borderColor: "color-mix(in srgb, var(--foreground) 10%, transparent)"
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold tracking-[0.12em] text-muted-foreground">后续消息队列</p>
          <p className="mt-1 text-xs text-muted-foreground">当前 run 结束后，会按顺序自动发起后续轮次。</p>
        </div>
        <Badge variant="secondary">{props.items.length}</Badge>
      </div>
      <div className="mt-3 space-y-2">
        {props.items.map((item, index) => (
          <div key={item.runId} className="flex items-start justify-between gap-3 rounded-xl border border-border/60 bg-background/70 px-3 py-2">
            <CornerDownRight className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <span>{`#${item.position || index + 1}`}</span>
                <span>{formatTimestamp(item.createdAt)}</span>
              </div>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground">{item.content}</p>
            </div>
            {props.guideMessageSupported ? (
              <Button
                variant="secondary"
                size="sm"
                className="h-8 flex-shrink-0 px-3 text-xs"
                onClick={() => props.guideQueuedSessionInput(item.runId)}
              >
                引导
              </Button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
});

type ConversationStatusBarProps = {
  hasActiveSession: boolean;
  isRunning: boolean;
};

const ConversationStatusBar = memo(function ConversationStatusBar(props: ConversationStatusBarProps) {
  const run = useStreamStore((state) => state.run);

  if (!props.hasActiveSession || (!props.isRunning && !run?.status)) {
    return null;
  }

  return (
    <div className="sticky top-0 z-10 flex items-center justify-end gap-2 px-4 py-1.5 pointer-events-none min-h-[36px]">
      {props.isRunning ? (
        <Badge variant="secondary" className="pointer-events-auto animate-pulse gap-1.5">
          <Loader2 className="h-3 w-3 animate-spin" />
          {run?.effectiveAgentName ?? "running"}
        </Badge>
      ) : run?.status ? (
        <Badge className={`pointer-events-auto ${statusTone(run.status)}`}>{run.status}</Badge>
      ) : null}
    </div>
  );
});

type ConversationFeedProps = Pick<
  RuntimeProps,
  | "hasActiveSession"
  | "currentWorkspaceName"
  | "messagesLoading"
  | "messageFeed"
  | "conversationTailRef"
  | "catalog"
  | "session"
  | "sessionEvents"
  | "refreshRunById"
  | "refreshRunStepsById"
> & {
  hasMoreMessages: boolean;
  loadingOlderMessages: boolean;
  onLoadOlderMessages: () => void;
};

const ConversationFeed = memo(function ConversationFeed(props: ConversationFeedProps) {
  const run = useStreamStore((state) => state.run);
  const runSteps = useStreamStore((state) => state.runSteps);
  const setSelectedRunId = useStreamStore((state) => state.setSelectedRunId);
  const setMainViewMode = useUiStore((state) => state.setMainViewMode);
  const setInspectorTab = useUiStore((state) => state.setInspectorTab);
  const messageAgentInfoById = useMemo(
    () =>
      buildMessageAgentInfoIndex({
        messages: props.messageFeed,
        catalog: props.catalog,
        runSteps,
        run,
        session: props.session,
        sessionEvents: props.sessionEvents
      }),
    [props.catalog, props.messageFeed, props.session, props.sessionEvents, run, runSteps]
  );
  const handleInspectRun = useCallback(
    (runId: string) => {
      if (!runId) {
        return;
      }

      setSelectedRunId(runId);
      setMainViewMode("inspector");
      setInspectorTab("timeline");
      props.refreshRunById(runId);
      props.refreshRunStepsById(runId);
    },
    [props.refreshRunById, props.refreshRunStepsById, setInspectorTab, setMainViewMode, setSelectedRunId]
  );

  if (!props.hasActiveSession) {
    return (
      <div className="flex min-h-[52vh] items-center justify-center py-10">
        <div className="max-w-md text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-border/70 bg-background/85 text-muted-foreground shadow-sm">
            <Folder className="h-5 w-5" />
          </div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">No Session Selected</h2>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">Choose a session from the sidebar, or create one in {props.currentWorkspaceName}.</p>
        </div>
      </div>
    );
  }

  if (props.messagesLoading && props.messageFeed.length === 0) {
    return (
      <div className="flex min-h-[52vh] items-center justify-center py-10">
        <div className="max-w-md text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-border/70 bg-background/85 text-muted-foreground shadow-sm">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">Loading Conversation</h2>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">Fetching the latest message block for this session.</p>
        </div>
      </div>
    );
  }

  if (props.messageFeed.length === 0) {
    return (
      <div className="flex min-h-[52vh] items-center justify-center py-10">
        <div className="max-w-md text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-foreground text-background shadow-lg">
            <Bot className="h-5 w-5" />
          </div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">OpenAgentHarness</h2>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">Send a message to start this session. Tool calls, traces, and engine output will appear as the conversation unfolds.</p>
        </div>
      </div>
    );
  }

  return (
    <>
      {props.hasMoreMessages || props.loadingOlderMessages ? (
        <div className="mb-5 flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={props.onLoadOlderMessages}
            disabled={props.loadingOlderMessages}
            className="rounded-full bg-background/85 px-4 shadow-sm backdrop-blur-sm"
          >
            {props.loadingOlderMessages ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
            {props.loadingOlderMessages ? "Loading earlier messages" : "Load earlier messages"}
          </Button>
        </div>
      ) : null}
      {props.messageFeed.map((message) => {
        const messageAgentInfo = messageAgentInfoById.get(message.id);
        return (
          <ConversationMessageRow
            key={message.id}
            message={message}
            {...(messageAgentInfo?.name ? { agentName: messageAgentInfo.name } : {})}
            {...(messageAgentInfo?.mode ? { agentMode: messageAgentInfo.mode } : {})}
            onInspectRun={handleInspectRun}
          />
        );
      })}
      {props.hasActiveSession ? <div className="h-36" aria-hidden="true" /> : null}
      <div ref={props.conversationTailRef} aria-hidden="true" />
    </>
  );
});

/** Persist scroll positions per session across component re-mounts */
const scrollPositions = new Map<string, number>();

function ConversationWorkspaceImpl(props: RuntimeProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const prevMessageCountRef = useRef(0);
  const restoredRef = useRef(false);
  const prependSnapshotRef = useRef<{ messageCount: number; scrollHeight: number; scrollTop: number } | null>(null);

  const sessionId = props.session?.id ?? "";
  const messageCount = props.messageFeed.length;
  const hasStreamingMessage = useMemo(() => props.messageFeed.some((message) => message.id.startsWith("live:")), [props.messageFeed]);
  const isRunning = props.isRunning;
  const queuedSessionRuns = props.queuedSessionRuns;

  // Reset restored flag when session changes
  useEffect(() => {
    restoredRef.current = false;
  }, [sessionId]);

  // Restore saved scroll position once messages are loaded
  useEffect(() => {
    if (restoredRef.current) return;
    const el = scrollContainerRef.current;
    if (!el || messageCount === 0) return;

    const saved = scrollPositions.get(sessionId);
    if (saved != null) {
      requestAnimationFrame(() => {
        el.scrollTop = saved;
        isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
      });
    }
    restoredRef.current = true;
    prevMessageCountRef.current = messageCount;
  }, [sessionId, messageCount]);

  // Track scroll position
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    if (sessionId) {
      scrollPositions.set(sessionId, el.scrollTop);
    }
  }, [sessionId]);

  // Auto-scroll on new messages
  useEffect(() => {
    if (!restoredRef.current) return;
    if (prependSnapshotRef.current) return;
    const isNewMessage = messageCount > prevMessageCountRef.current;
    prevMessageCountRef.current = messageCount;

    if (isNewMessage && messageCount > 0) {
      const lastMsg = props.messageFeed[messageCount - 1];
      if (lastMsg?.role === "user") {
        isNearBottomRef.current = true;
      }
    }

    if (isNewMessage && isNearBottomRef.current) {
      props.conversationTailRef?.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messageCount, props.messageFeed, props.conversationTailRef]);

  // Streaming auto-scroll: pin to bottom without smooth animation
  useEffect(() => {
    if (!isNearBottomRef.current || !hasStreamingMessage) return;
    const el = scrollContainerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  });

  useEffect(() => {
    if (props.loadingOlderMessages) {
      return;
    }

    const snapshot = prependSnapshotRef.current;
    const el = scrollContainerRef.current;
    if (!snapshot || !el) {
      return;
    }

    const heightDelta = el.scrollHeight - snapshot.scrollHeight;
    el.scrollTop = snapshot.scrollTop + Math.max(0, heightDelta);
    prevMessageCountRef.current = messageCount;
    prependSnapshotRef.current = null;
  }, [messageCount, props.loadingOlderMessages]);

  const handleLoadOlderMessages = () => {
    const el = scrollContainerRef.current;
    if (el) {
      prependSnapshotRef.current = {
        messageCount,
        scrollHeight: el.scrollHeight,
        scrollTop: el.scrollTop
      };
    }
    props.loadOlderMessages();
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={(el) => {
          (scrollContainerRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
          if (props.conversationThreadRef) {
            (props.conversationThreadRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
          }
        }}
        className="flex-1 overflow-y-auto min-h-0"
        onScroll={handleScroll}
      >
        <ConversationStatusBar hasActiveSession={props.hasActiveSession} isRunning={isRunning} />

        <div className="mx-auto flex w-full max-w-4xl flex-col px-4 py-6 md:px-6 md:py-8">
          <ConversationFeed
            hasActiveSession={props.hasActiveSession}
            currentWorkspaceName={props.currentWorkspaceName}
            messagesLoading={props.messagesLoading}
            messageFeed={props.messageFeed}
            conversationTailRef={props.conversationTailRef}
            catalog={props.catalog}
            session={props.session}
            sessionEvents={props.sessionEvents}
            refreshRunById={props.refreshRunById}
            refreshRunStepsById={props.refreshRunStepsById}
            hasMoreMessages={props.hasMoreMessages}
            loadingOlderMessages={props.loadingOlderMessages}
            onLoadOlderMessages={handleLoadOlderMessages}
          />
        </div>
      </div>

      {props.hasActiveSession ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20">
          <div className="p-4 md:p-6">
            <div className="max-w-4xl mx-auto">
              <QueuedRunsPanel
                items={queuedSessionRuns}
                guideQueuedSessionInput={props.guideQueuedSessionInput}
                guideMessageSupported={props.guideMessageSupported}
              />
              <ConversationComposer
                refreshMessages={props.refreshMessages}
                sendMessage={props.sendMessage}
                cancelCurrentRun={props.cancelCurrentRun}
                isRunning={isRunning}
                isSwitchingSessionAgent={props.isSwitchingSessionAgent}
              />
            </div>
          </div>
        </div>
      ) : null}

      <WorkspaceFileManagerPanel fileManager={props.fileManager} />
    </div>
  );
}

export const ConversationWorkspace = memo(ConversationWorkspaceImpl);
