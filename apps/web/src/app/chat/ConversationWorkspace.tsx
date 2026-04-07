import { useEffect, useRef, useCallback, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, ChevronRight, Folder, Loader2, RefreshCw, Send, Square, Wrench, CornerDownRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

import { formatTimestamp, readMessageAgentSnapshot, statusTone } from "../support";
import type { Message } from "@oah/api-contracts";
import type { useAppController } from "../use-app-controller";
import { Badge } from "@/components/ui/badge";

type RuntimeProps = ReturnType<typeof useAppController>["runtimeDetailSurfaceProps"];

function agentModeTone(mode: "primary" | "subagent" | "all") {
  switch (mode) {
    case "primary":
      return "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300";
    case "subagent":
      return "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300";
    case "all":
      return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300";
  }
}

function resolveMessageAgentInfo(message: Message, props: RuntimeProps) {
  if (message.role !== "assistant" && message.role !== "tool") {
    return null;
  }

  const agentModeByName = new Map((props.catalog?.agents ?? []).map((agent) => [agent.name, agent.mode]));
  const snapshot = readMessageAgentSnapshot(message);
  const latestStepForMessageRun =
    message.runId
      ? [...props.runSteps]
          .reverse()
          .find((step) => step.runId === message.runId && typeof step.agentName === "string" && step.agentName.trim())
      : undefined;

  const agentName =
    snapshot?.name ??
    latestStepForMessageRun?.agentName ??
    (message.runId && props.run?.id === message.runId ? props.run?.effectiveAgentName ?? props.run?.agentName : undefined) ??
    props.session?.activeAgentName ??
    undefined;

  if (!agentName) {
    return null;
  }

  const mode = agentModeByName.get(agentName);
  return {
    name: agentName,
    mode: snapshot?.mode ?? mode
  };
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
    case "string":   return "border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300";
    case "number":   return "border-blue-500/20 bg-blue-500/10 text-blue-700 dark:text-blue-300";
    case "boolean":  return "border-violet-500/20 bg-violet-500/10 text-violet-700 dark:text-violet-300";
    case "null":     return "border-border/60 bg-muted/60 text-muted-foreground";
    case "array":
    case "object":   return "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    default:         return "border-border/60 bg-muted/60 text-muted-foreground";
  }
}

function ToolCallBlock({ part }: { part: { type: "tool-call"; toolName?: string; input?: Record<string, unknown> } }) {
  const [expanded, setExpanded] = useState(true);
  const params = part.input ?? {};
  const hasParams = Object.keys(params).length > 0;

  return (
    <div className="rounded-2xl border border-border/60 bg-muted/35 overflow-hidden shadow-sm">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm hover:bg-muted/55 transition-colors text-left"
      >
        <ChevronRight className={`w-3 h-3 text-foreground/50 transition-transform flex-shrink-0 ${expanded ? "rotate-90" : ""}`} />
        <span className="inline-flex items-center rounded-md border border-border/60 bg-background/45 px-2 py-0.5 text-[10px] font-medium text-muted-foreground/80">
          tool call
        </span>
        <Wrench className="w-3 h-3 text-foreground/40 flex-shrink-0" />
        <code className="text-[11px] font-mono font-semibold text-foreground/80">{part.toolName ?? "unknown"}</code>
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
                          <pre className="rounded-lg border border-sky-500/15 bg-sky-500/5 px-3 py-2 text-sky-800 dark:text-sky-200 whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
                            {value}
                          </pre>
                        ) : (
                          <span className="inline-flex items-center rounded-md border border-sky-500/15 bg-sky-500/5 px-2 py-1 text-sky-800 dark:text-sky-200">
                            <span className="opacity-50 mr-0.5">"</span>{value}<span className="opacity-50 ml-0.5">"</span>
                          </span>
                        )
                      ) : typeof value === "number" ? (
                        <span className="inline-flex items-center rounded-md border border-blue-500/15 bg-blue-500/5 px-2 py-1 text-blue-700 dark:text-blue-300">{value}</span>
                      ) : typeof value === "boolean" ? (
                        <span className="inline-flex items-center rounded-md border border-violet-500/15 bg-violet-500/5 px-2 py-1 text-violet-700 dark:text-violet-300">{String(value)}</span>
                      ) : value === null ? (
                        <span className="inline-flex items-center rounded-md border border-border/60 bg-muted/50 px-2 py-1 text-muted-foreground">null</span>
                      ) : (
                        <pre className="rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-foreground/75 overflow-x-auto whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
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

function ToolResultBlock({ part }: { part: { type: "tool-result"; toolName?: string; output?: ToolResultOutput } }) {
  const [expanded, setExpanded] = useState(true);
  const { content, isError } = resolveToolResultContent(part.output);
  const preview = content.slice(0, 60).replace(/\n/g, " ") + (content.length > 60 ? "…" : "");

  return (
    <div className={`rounded-2xl border overflow-hidden shadow-sm ${isError ? "border-destructive/20 bg-destructive/5" : "border-border/60 bg-muted/35"}`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-sm transition-colors text-left ${isError ? "hover:bg-destructive/10" : "hover:bg-muted/55"}`}
      >
        <ChevronRight className={`w-3 h-3 transition-transform flex-shrink-0 ${expanded ? "rotate-90" : ""} ${isError ? "text-destructive/70" : "text-foreground/50"}`} />
        <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-medium ${isError ? "border-destructive/20 bg-destructive/10 text-destructive" : "border-primary/15 bg-primary/5 text-primary/85"}`}>
          {isError ? "error" : "result"}
        </span>
        <CornerDownRight className={`w-3 h-3 flex-shrink-0 ${isError ? "text-destructive/60" : "text-foreground/40"}`} />
        {part.toolName && (
          <code className="inline-flex items-center rounded-md border border-border/60 bg-background/45 px-2 py-0.5 text-[11px] font-mono text-foreground/70">
            {part.toolName}
          </code>
        )}
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
              : "border-border/60 bg-background/50 text-foreground/80"
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

/** Render message content — text parts as prose, reasoning as collapsible, tool calls/results as chips */
function MessageContent({ content, isUser }: { content: Message["content"]; isUser?: boolean }) {
  if (typeof content === "string") {
    return <MarkdownText text={content} {...(isUser !== undefined ? { isUser } : {})} />;
  }

  const textParts = content.filter((p) => p.type === "text");
  const reasoningParts = content.filter((p) => p.type === "reasoning");
  const toolParts = content.filter((p) => p.type === "tool-call" || p.type === "tool-result");
  const approvalParts = content.filter((p) => p.type === "tool-approval-request" || p.type === "tool-approval-response");

  return (
    <div className="space-y-2">
      {reasoningParts.length > 0 && (
        <details className="group/reasoning">
          <summary className="list-none cursor-pointer select-none">
            <span className="inline-flex items-center gap-1.5 rounded-md border border-violet-200/70 bg-violet-50/60 px-2 py-0.5 text-[11px] font-medium text-violet-600 transition hover:bg-violet-50 dark:border-violet-800/70 dark:bg-violet-950/40 dark:text-violet-400 dark:hover:bg-violet-950/60">
              <span className="opacity-70">✦</span> reasoning
              <span className="opacity-50 text-[10px] group-open/reasoning:hidden">▸</span>
              <span className="opacity-50 text-[10px] hidden group-open/reasoning:inline">▾</span>
            </span>
          </summary>
          <div className="mt-1.5 rounded-lg border border-violet-200/50 bg-violet-50/30 px-3 py-2 dark:border-violet-800/50 dark:bg-violet-950/20">
            {reasoningParts.map((part, i) => (
              <div key={i} className="whitespace-pre-wrap break-words text-xs leading-relaxed text-violet-700/80 dark:text-violet-400/80">
                {"text" in part ? part.text : null}
              </div>
            ))}
          </div>
        </details>
      )}
      {textParts.map((part, i) => (
        <div key={i}>
          {"text" in part && part.text ? <MarkdownText text={part.text} {...(isUser !== undefined ? { isUser } : {})} /> : null}
        </div>
      ))}
      {approvalParts.length > 0 && (
        <div className="space-y-1.5 pt-1">
          {approvalParts.map((part, i) => (
            <div
              key={i}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium ${
                part.type === "tool-approval-request"
                  ? "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-400"
                  : "approved" in part && part.approved
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-400"
                  : "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-400"
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
              <ToolCallBlock key={i} part={part as { type: "tool-call"; toolName?: string; input?: Record<string, unknown> }} />
            ) : (
              <ToolResultBlock key={i} part={part as { type: "tool-result"; toolName?: string; output?: ToolResultOutput }} />
            )
          )}
        </div>
      )}
    </div>
  );
}

/** Persist scroll positions per session across component re-mounts */
const scrollPositions = new Map<string, number>();

export function ConversationWorkspace(props: RuntimeProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const prevMessageCountRef = useRef(0);
  const restoredRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const sessionId = props.session?.id ?? "";
  const messageCount = props.messageFeed.length;
  const hasStreamingMessage = props.messageFeed.some((m) => m.id.startsWith("live:"));
  const isRunning = props.isRunning;
  const canSend = !isRunning && props.draftMessage.trim().length > 0;
  const inputPlaceholder = isRunning
    ? "Agent is running…"
    : props.isSwitchingSessionAgent
    ? "Updating session agent…"
    : "Message the current session";

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

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  }, [props.draftMessage]);

  // Enter to send, Shift+Enter for newline
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) {
        props.sendMessage();
      }
    }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
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
        {/* Sticky status bar */}
        {props.hasActiveSession && (isRunning || props.run?.status) ? (
          <div className="sticky top-0 z-10 flex items-center justify-end gap-2 px-4 py-1.5 pointer-events-none min-h-[36px]">
            {isRunning ? (
              <Badge variant="secondary" className="pointer-events-auto animate-pulse gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" />
                {props.run?.effectiveAgentName ?? "running"}
              </Badge>
            ) : props.run?.status ? (
              <Badge className={`pointer-events-auto ${statusTone(props.run.status)}`}>
                {props.run.status}
              </Badge>
            ) : null}
          </div>
        ) : null}

        <div className="mx-auto flex w-full max-w-4xl flex-col px-4 py-6 md:px-6 md:py-8">
          {!props.hasActiveSession ? (
            <div className="flex min-h-[52vh] items-center justify-center py-10">
              <div className="max-w-md text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-border/70 bg-background/85 text-muted-foreground shadow-sm">
                  <Folder className="h-5 w-5" />
                </div>
                <h2 className="text-xl font-semibold tracking-tight text-foreground">No Session Selected</h2>
                <p className="mt-3 text-sm leading-7 text-muted-foreground">Choose a session from the sidebar, or create one in {props.currentWorkspaceName}.</p>
              </div>
            </div>
          ) : props.messageFeed.length === 0 ? (
            <div className="flex min-h-[52vh] items-center justify-center py-10">
              <div className="max-w-md text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-foreground text-background shadow-lg">
                  <Bot className="h-5 w-5" />
                </div>
                <h2 className="text-xl font-semibold tracking-tight text-foreground">OpenAgentHarness</h2>
                <p className="mt-3 text-sm leading-7 text-muted-foreground">Send a message to start this session. Tool calls, traces, and runtime output will appear as the conversation unfolds.</p>
              </div>
            </div>
          ) : (
            props.messageFeed.map((message) => {
              const isUser = message.role === "user";
              const isStreaming = message.id.startsWith("live:");
              const isToolOnly = !isUser && isToolOnlyMessage(message.content);
              const messageAgentInfo = resolveMessageAgentInfo(message, props);

              return (
                <article key={message.id} className={`group/message animate-fade-in flex gap-3 md:gap-4 py-2 md:py-3 ${isUser ? "flex-row-reverse" : ""}`}>
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
                      <MessageContent content={message.content} isUser={isUser} />
                      {isStreaming && (
                        <span className="mt-1 inline-block h-4 w-0.5 animate-pulse bg-current opacity-60" />
                      )}
                    </div>
                    <div
                      className={`mt-1.5 flex min-h-5 flex-wrap items-center gap-2 text-[10px] font-medium text-muted-foreground/50 max-md:visible max-md:opacity-100 md:invisible md:opacity-0 md:pointer-events-none md:group-hover/message:visible md:group-hover/message:opacity-100 md:group-hover/message:pointer-events-auto md:group-focus-within/message:visible md:group-focus-within/message:opacity-100 md:group-focus-within/message:pointer-events-auto ${isUser ? "justify-end" : ""}`}
                    >
                      {message.runId ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-5 rounded-md px-1.5 text-[10px]"
                          onClick={() => {
                            props.setSelectedRunId(message.runId ?? "");
                            props.setMainViewMode("inspector");
                            props.setInspectorTab("timeline");
                            props.refreshRunById(message.runId ?? "");
                            props.refreshRunStepsById(message.runId ?? "");
                          }}
                        >
                          {message.runId}
                        </Button>
                      ) : null}
                      {isStreaming ? <span className="uppercase tracking-[0.14em]">Streaming</span> : null}
                      {!isUser && messageAgentInfo ? (
                        <>
                          <Badge variant="outline" className="h-5 rounded-md px-1.5 text-[10px] font-medium">
                            {messageAgentInfo.name}
                          </Badge>
                          {messageAgentInfo.mode ? (
                            <span
                              className={`inline-flex h-5 items-center rounded-md border px-1.5 text-[10px] font-medium uppercase tracking-[0.12em] ${agentModeTone(messageAgentInfo.mode)}`}
                            >
                              {messageAgentInfo.mode}
                            </span>
                          ) : null}
                        </>
                      ) : null}
                      <span>{formatTimestamp(message.createdAt)}</span>
                    </div>
                  </div>
                </article>
              );
            })
          )}
          {props.hasActiveSession ? <div className="h-36" aria-hidden="true" /> : null}
          <div ref={props.conversationTailRef} aria-hidden="true" />
        </div>
      </div>

      {props.hasActiveSession ? (
        <div className="flex-shrink-0">
          <div className="p-4 md:p-6">
            <div className="max-w-4xl mx-auto">
              <div
                className="relative flex items-end gap-2 rounded-xl p-2 shadow-lg"
                style={{
                  background: "color-mix(in srgb, var(--background) 80%, transparent)",
                  backdropFilter: "blur(12px)",
                  WebkitBackdropFilter: "blur(12px)",
                  border: "1px solid color-mix(in srgb, var(--foreground) 12%, transparent)",
                }}
              >
                <Button
                  onClick={props.refreshMessages}
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 flex-shrink-0"
                  title="Refresh messages"
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>

                <Textarea
                  ref={textareaRef}
                  value={props.draftMessage}
                  onChange={(event) => props.setDraftMessage(event.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={inputPlaceholder}
                  disabled={isRunning}
                  rows={1}
                  className="min-h-[24px] max-h-[200px] flex-1 resize-none border-none bg-transparent px-0 py-2 text-sm shadow-none outline-none focus-visible:ring-0 disabled:opacity-50"
                />

                {isRunning ? (
                  <Button
                    onClick={props.cancelCurrentRun}
                    size="icon"
                    variant="ghost"
                    className="h-9 w-9 flex-shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                    title="Stop run"
                  >
                    <Square className="h-4 w-4 fill-current" />
                  </Button>
                ) : (
                  <Button
                    onClick={props.sendMessage}
                    disabled={!canSend}
                    size="icon"
                    className="shadow-elegant h-9 w-9 flex-shrink-0"
                    title="Send message"
                  >
                    <Send className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
