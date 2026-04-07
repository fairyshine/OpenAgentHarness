import { Activity, Bot, ChevronDown, ChevronRight, Folder, Trash2 } from "lucide-react";

import type { Message } from "@oah/api-contracts";

import { Badge } from "../components/ui/badge";
import { cn } from "../lib/utils";

import {
  contentPreview,
  formatTimestamp,
  isRecord,
  prettyJson,
  type ModelCallTrace,
  type ModelCallTraceRuntimeTool,
  type SavedSessionRecord,
  type SavedWorkspaceRecord
} from "./support";

function WorkspaceSidebarItem(props: {
  entry: SavedWorkspaceRecord;
  active: boolean;
  expanded: boolean;
  sessionCount: number;
  canRemove: boolean;
  onSelect: () => void;
  onToggleExpanded: () => void;
  onRemove: () => void;
}) {
  const ExpandIcon = props.expanded ? ChevronDown : ChevronRight;
  const subtitleParts = [
    props.entry.template,
    `${props.sessionCount} sessions`,
    props.entry.lastOpenedAt ? formatTimestamp(props.entry.lastOpenedAt) : undefined
  ].filter(Boolean);

  return (
    <div
      className={cn(
        "ob-list-item group relative flex items-center gap-3 px-3 py-2.5",
        props.active
          ? "ob-list-item-active"
          : undefined
      )}
    >
      <button
        className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-muted/50 hover:text-foreground"
        onClick={props.onToggleExpanded}
        title={props.expanded ? "折叠 sessions" : "展开 sessions"}
      >
        <ExpandIcon className="h-4 w-4" />
      </button>
      <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={props.onSelect}>
        <div
          className={cn(
            "flex h-9 w-9 items-center justify-center rounded-[12px] transition",
            props.active ? "bg-foreground/[0.08] text-foreground" : "bg-foreground/[0.035] text-muted-foreground"
          )}
        >
          <Folder className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{props.entry.name}</p>
          <p className="truncate text-xs text-muted-foreground">{subtitleParts.join(" · ")}</p>
        </div>
      </button>
      {props.canRemove ? (
        <button
          className="rounded-lg p-1.5 text-muted-foreground opacity-0 transition hover:bg-muted/50 hover:text-foreground group-hover:opacity-100"
          onClick={props.onRemove}
          title="删除 workspace"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}

function SessionSidebarItem(props: {
  entry: SavedSessionRecord;
  active: boolean;
  contextLabel?: string;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const subtitleParts = [
    props.contextLabel,
    props.entry.agentName,
    formatTimestamp(props.entry.lastRunAt || props.entry.createdAt)
  ].filter(Boolean);

  return (
    <div
      className={cn(
        "ob-list-item group relative flex items-center gap-3 px-3 py-2.5",
        props.active
          ? "ob-list-item-active"
          : undefined
      )}
    >
      <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={props.onSelect}>
        <div
          className={cn(
            "flex h-9 w-9 items-center justify-center rounded-[12px] transition",
            props.active ? "bg-foreground/[0.08] text-foreground" : "bg-foreground/[0.035] text-muted-foreground"
          )}
        >
          <Bot className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{props.entry.title || "Untitled session"}</p>
          <p className="truncate text-xs text-muted-foreground">{subtitleParts.join(" · ")}</p>
        </div>
      </button>
      <button
        className="rounded-lg p-1.5 text-muted-foreground opacity-0 transition hover:bg-muted/50 hover:text-foreground group-hover:opacity-100"
        onClick={props.onRemove}
        title="从本地侧栏移除"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

function ToggleChip(props: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      className={cn(
        "rounded-md border px-3 py-1.5 text-xs font-medium transition",
        props.active
          ? "border-border/20 bg-foreground text-background"
          : "border-border bg-background text-muted-foreground hover:bg-muted/40 hover:text-foreground"
      )}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

function InspectorTabButton(props: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      className={cn(
        "rounded-md px-3 py-2 text-xs font-medium transition",
        props.active
          ? "bg-background text-foreground"
          : "text-muted-foreground hover:bg-background hover:text-foreground"
      )}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

function InsightRow(props: { label: string; value: string }) {
  return (
    <div className="ob-subsection min-w-0 px-4 py-3">
      <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{props.label}</p>
      <p className="mt-2 whitespace-pre-wrap break-words text-[15px] font-semibold leading-6 text-foreground [overflow-wrap:anywhere]">
        {props.value}
      </p>
    </div>
  );
}

function EntityPreview(props: { title: string; data: unknown }) {
  return (
    <div className="ob-subsection overflow-hidden">
      <div className="px-4 py-2 text-xs text-muted-foreground">
        {props.title}
      </div>
      <pre className="max-h-72 overflow-auto border-t border-border/70 p-4 text-xs leading-6 text-foreground/80">{prettyJson(props.data)}</pre>
    </div>
  );
}

function JsonBlock(props: { title: string; value: unknown }) {
  return (
    <div className="ob-subsection overflow-hidden">
      <div className="px-3 py-2 text-xs text-muted-foreground">
        {props.title}
      </div>
      <pre className="max-h-64 overflow-auto border-t border-border/70 p-3 text-xs leading-6 text-foreground/80">{prettyJson(props.value)}</pre>
    </div>
  );
}

function modelMessageTone(role: Message["role"]) {
  switch (role) {
    case "system":
      return "bg-foreground text-background";
    case "user":
      return "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300";
    case "assistant":
      return "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300";
    case "tool":
      return "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300";
    default:
      return "";
  }
}

function PayloadValueView(props: {
  value: unknown;
  maxHeightClassName?: string | undefined;
  mode?: "input" | "result" | undefined;
}) {
  const kindLabel =
    props.value === null
      ? "null"
      : Array.isArray(props.value)
        ? "array"
        : typeof props.value === "object"
          ? "object"
          : typeof props.value;
  const sizeLabel =
    Array.isArray(props.value)
      ? `${props.value.length} items`
      : isRecord(props.value)
        ? `${Object.keys(props.value).length} keys`
        : undefined;

  if (typeof props.value === "string") {
    const lineCount = props.value.length === 0 ? 0 : props.value.split(/\r?\n/u).length;
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Badge>{props.mode === "result" ? "text result" : "text payload"}</Badge>
          <Badge>{`${lineCount} lines`}</Badge>
          <Badge>{`${props.value.length} chars`}</Badge>
        </div>
        <div className="rounded-[16px] border border-border bg-muted/30 p-3">
          <pre
            className={cn(
              "overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-foreground/80",
              props.maxHeightClassName
            )}
          >
            {props.value}
          </pre>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Badge>{props.mode === "result" ? "structured result" : "structured payload"}</Badge>
        <Badge>{kindLabel}</Badge>
        {sizeLabel ? <Badge>{sizeLabel}</Badge> : null}
      </div>
      <div className="rounded-[16px] border border-border bg-muted/30 p-3">
        <pre className={cn("overflow-auto text-xs leading-6 text-foreground/80", props.maxHeightClassName)}>{prettyJson(props.value)}</pre>
      </div>
    </div>
  );
}

function compactPreviewText(value: Message["content"], limit = 120) {
  const compact = contentPreview(value, limit).replace(/\s+/g, " ").trim();
  if (compact.length <= limit) {
    return compact || " ";
  }

  return `${compact.slice(0, limit)}...`;
}

function buildAiSdkToolsObject(tools: ModelCallTraceRuntimeTool[]) {
  return Object.fromEntries(
    tools.map((tool) => [
      tool.name,
      {
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {})
      }
    ])
  );
}

function buildAiSdkLikeRequest(trace: ModelCallTrace | null) {
  if (!trace) {
    return null;
  }

  return {
    model: trace.input.model ?? null,
    canonicalModelRef: trace.input.canonicalModelRef ?? null,
    provider: trace.input.provider ?? null,
    ...(trace.input.temperature !== undefined ? { temperature: trace.input.temperature } : {}),
    ...(trace.input.maxTokens !== undefined ? { maxTokens: trace.input.maxTokens } : {}),
    messages: trace.input.messages,
    tools: buildAiSdkToolsObject(trace.input.runtimeTools),
    activeTools: trace.input.activeToolNames,
    toolServers: trace.input.toolServers
  };
}

function buildAiSdkLikeStoredMessages(messages: Message[]) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    _meta: {
      id: message.id,
      sessionId: message.sessionId,
      ...(message.runId ? { runId: message.runId } : {}),
      createdAt: message.createdAt,
      ...(message.metadata ? { metadata: message.metadata } : {})
    }
  }));
}


function EmptyState(props: { title: string; description: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-muted/20 px-4 py-7 text-center">
      <p className="text-sm font-medium text-foreground">{props.title}</p>
      <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{props.description}</p>
    </div>
  );
}

function CatalogLine(props: { label: string; value: number | string }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start gap-3 rounded-xl border border-border bg-background px-4 py-3 text-sm">
      <span className="min-w-0 text-muted-foreground">{props.label}</span>
      <span className="min-w-0 whitespace-pre-wrap break-words text-right font-semibold text-foreground [overflow-wrap:anywhere]">
        {props.value}
      </span>
    </div>
  );
}

function StatusTile(props: {
  icon: typeof Activity;
  label: string;
  value: string;
  tone: "sky" | "emerald" | "rose" | "amber";
  compact?: boolean;
}) {
  const colorClass =
    props.tone === "emerald"
      ? "border-emerald-200/80 bg-emerald-50/70 text-emerald-700 dark:border-emerald-800/80 dark:bg-emerald-950/40 dark:text-emerald-400"
      : props.tone === "rose"
        ? "border-rose-200/80 bg-rose-50/70 text-rose-700 dark:border-rose-800/80 dark:bg-rose-950/40 dark:text-rose-400"
        : props.tone === "amber"
          ? "border-amber-200/80 bg-amber-50/70 text-amber-700 dark:border-amber-800/80 dark:bg-amber-950/40 dark:text-amber-400"
          : "border-border bg-muted text-muted-foreground";

  const Icon = props.icon;

  if (props.compact) {
    return (
      <div className={cn("inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs", colorClass)}>
        <Icon className="h-3.5 w-3.5" />
        <span className="uppercase tracking-[0.16em]">{props.label}</span>
        <span className="max-w-[120px] truncate font-medium normal-case tracking-normal">{props.value}</span>
      </div>
    );
  }

  return (
    <div className={cn("rounded-xl border px-4 py-3", colorClass)}>
      <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.18em]">
        <Icon className="h-4 w-4" />
        {props.label}
      </div>
      <div className="truncate text-sm font-medium">{props.value}</div>
    </div>
  );
}

export {
  WorkspaceSidebarItem,
  SessionSidebarItem,
  ToggleChip,
  InspectorTabButton,
  InsightRow,
  EntityPreview,
  JsonBlock,
  PayloadValueView,
  EmptyState,
  CatalogLine,
  StatusTile,
  buildAiSdkLikeRequest,
  buildAiSdkLikeStoredMessages,
  compactPreviewText,
  modelMessageTone
};
