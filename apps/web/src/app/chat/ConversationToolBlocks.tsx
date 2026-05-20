import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, CornerDownRight, Loader2, MessageSquare, Send, Wrench } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Message } from "@oah/api-contracts";

import { toneBadgeClass } from "../support";
import { DeferredConversationBlock } from "./conversation-markdown";
import {
  type AskUserQuestionPayload,
  type ToolResultOutput,
  formatAskUserQuestionAnswer,
  formatToolDuration,
  readAskUserQuestionPayload,
  readToolMeta,
  resolveToolResultContent,
  toolStatusTone
} from "./conversation-model";

const MAX_STREAMING_INPUT_PREVIEW_CHARS = 12000;
const MAX_STRING_PARAM_PREVIEW_CHARS = 12000;
const MAX_JSON_PARAM_PREVIEW_CHARS = 16000;
const MAX_TOOL_OUTPUT_PREVIEW_CHARS = 32000;

export type ParamKind = "string" | "number" | "boolean" | "null" | "array" | "object" | "unknown";

export function getParamKind(value: unknown): ParamKind {
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return "unknown";
}

export function paramTypeBadgeClass(kind: ParamKind) {
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

function readStreamingInput(value: unknown) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as { __streamingInput?: unknown }).__streamingInput !== "string"
  ) {
    return undefined;
  }

  const truncatedChars = (value as { __streamingInputTruncatedChars?: unknown }).__streamingInputTruncatedChars;
  return {
    text: (value as { __streamingInput: string }).__streamingInput,
    truncatedChars: typeof truncatedChars === "number" && Number.isFinite(truncatedChars) ? Math.max(0, truncatedChars) : 0
  };
}

function previewHead(value: string, limit: number) {
  if (value.length <= limit) {
    return {
      text: value,
      truncatedChars: 0
    };
  }

  return {
    text: value.slice(0, limit),
    truncatedChars: value.length - limit
  };
}

function previewTail(value: string, limit: number, alreadyTruncatedChars = 0) {
  if (value.length <= limit) {
    return {
      text: value,
      truncatedChars: alreadyTruncatedChars
    };
  }

  return {
    text: value.slice(-limit),
    truncatedChars: alreadyTruncatedChars + value.length - limit
  };
}

function formatJsonPreview(value: unknown, limit = MAX_JSON_PARAM_PREVIEW_CHARS) {
  let serialized: string;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch {
    serialized = String(value);
  }

  return previewHead(serialized, limit);
}

function TruncationNotice({ truncatedChars, prefix = "Showing preview" }: { truncatedChars: number; prefix?: string }) {
  if (truncatedChars <= 0) {
    return null;
  }

  return (
    <div className="mb-2 rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-200">
      {prefix}; {truncatedChars.toLocaleString()} chars hidden while rendering.
    </div>
  );
}

function AutoFollowPre({
  className,
  text,
  placeholder
}: {
  className: string;
  text: string;
  placeholder: string;
}) {
  const preRef = useRef<HTMLPreElement | null>(null);
  const shouldFollowRef = useRef(true);

  const scrollToBottom = useCallback(() => {
    const el = preRef.current;
    if (!el) {
      return;
    }

    el.scrollTop = el.scrollHeight;
  }, []);

  useLayoutEffect(() => {
    if (!shouldFollowRef.current) {
      return;
    }

    scrollToBottom();
    const frameId = window.requestAnimationFrame(scrollToBottom);
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [scrollToBottom, text]);

  const handleScroll = useCallback(() => {
    const el = preRef.current;
    if (!el) {
      return;
    }

    shouldFollowRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
  }, []);

  return (
    <pre
      ref={preRef}
      className={className}
      onScroll={handleScroll}
    >
      {text || placeholder}
    </pre>
  );
}

export function ToolCallBlock({
  part,
  messageMetadata
}: {
  part: { type: "tool-call"; toolName?: string; input?: Record<string, unknown> };
  messageMetadata?: Message["metadata"];
}) {
  const [expanded, setExpanded] = useState(true);
  const toolMeta = readToolMeta(messageMetadata);
  const durationLabel = formatToolDuration(toolMeta.durationMs);
  const { paramEntries, paramKeys, hasParams, shouldDeferParams, streamingInputPreview } = useMemo(() => {
    const streamingInput = readStreamingInput(part.input);
    const params = streamingInput === undefined ? (part.input ?? {}) : {};
    const paramEntries = Object.entries(params);
    const paramKeys = paramEntries.map(([key]) => key);
    return {
      paramEntries,
      paramKeys,
      hasParams: paramEntries.length > 0 || streamingInput !== undefined,
      streamingInputPreview:
        streamingInput !== undefined
          ? previewTail(streamingInput.text, MAX_STREAMING_INPUT_PREVIEW_CHARS, streamingInput.truncatedChars)
          : undefined,
      shouldDeferParams:
        streamingInput === undefined &&
        paramEntries.length > 0 &&
        (paramEntries.length > 6 ||
          paramEntries.some(([, value]) => typeof value === "string" && value.length > 400) ||
          paramEntries.some(([, value]) => typeof value === "object" && value !== null))
    };
  }, [part.input]);

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
        {paramKeys.length > 0 && (
          <span className="text-xs text-muted-foreground/50 truncate flex-1">
            · {paramKeys.join(", ")}
          </span>
        )}
        {streamingInputPreview !== undefined ? (
          <span className="text-xs text-muted-foreground/50 truncate flex-1">
            · receiving parameters…
          </span>
        ) : null}
      </button>
      {expanded && (
        <DeferredConversationBlock
          estimatedHeight={hasParams ? 220 : 72}
          placeholderLabel="Rendering tool parameters..."
          eager={!shouldDeferParams}
        >
          <div className="border-t border-border/40 px-4 py-3">
            {hasParams ? (
              <div className="space-y-2">
                <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/60 mb-2">Parameters</div>
                {streamingInputPreview !== undefined ? (
                  <div className="rounded-xl border border-border/50 bg-background/40 px-3 py-2.5">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center rounded-md border border-primary/15 bg-primary/5 px-2 py-0.5 text-[11px] font-mono font-semibold text-primary/90">
                        input
                      </span>
                      <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${paramTypeBadgeClass("string")}`}>
                        streaming
                      </span>
                      <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/60" />
                    </div>
                    <TruncationNotice truncatedChars={streamingInputPreview.truncatedChars} prefix="Showing latest parameters" />
                    <AutoFollowPre
                      className="code-panel max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded-lg px-3 py-2 text-xs font-mono"
                      text={streamingInputPreview.text}
                      placeholder="Waiting for parameters..."
                    />
                  </div>
                ) : null}
                {paramEntries.map(([key, value]) => {
                  const kind = getParamKind(value);
                  const isMultiline = typeof value === "string" && value.includes("\n");
                  const stringPreview = typeof value === "string" ? previewHead(value, MAX_STRING_PARAM_PREVIEW_CHARS) : null;
                  const jsonPreview =
                    typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean" && value !== null
                      ? formatJsonPreview(value)
                      : null;
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
                          isMultiline || (stringPreview?.truncatedChars ?? 0) > 0 ? (
                            <>
                              <TruncationNotice truncatedChars={stringPreview?.truncatedChars ?? 0} />
                              <pre className={`rounded-lg border px-3 py-2 whitespace-pre-wrap break-all max-h-48 overflow-y-auto ${toneBadgeClass("sky")}`}>
                                {stringPreview?.text ?? ""}
                              </pre>
                            </>
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
                          <>
                            <TruncationNotice truncatedChars={jsonPreview?.truncatedChars ?? 0} />
                            <pre className="code-panel rounded-lg px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
                              {jsonPreview?.text ?? ""}
                            </pre>
                          </>
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
        </DeferredConversationBlock>
      )}
    </div>
  );
}

export function ToolResultBlock({
  part,
  messageMetadata,
  onAnswerAskUserQuestion
}: {
  part: { type: "tool-result"; toolName?: string; output?: ToolResultOutput };
  messageMetadata?: Message["metadata"];
  onAnswerAskUserQuestion?: (answer: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const { content, isError } = resolveToolResultContent(part.output);
  const outputPreview = useMemo(() => previewHead(content, MAX_TOOL_OUTPUT_PREVIEW_CHARS), [content]);
  const preview = outputPreview.text.slice(0, 60).replace(/\n/g, " ") + (content.length > 60 ? "…" : "");
  const toolMeta = readToolMeta(messageMetadata);
  const durationLabel = formatToolDuration(toolMeta.durationMs);
  const shouldDeferOutput = content.length > 800 || part.output?.type === "json" || part.output?.type === "error-json";
  const askUserQuestionPayload = part.toolName === "AskUserQuestion" ? readAskUserQuestionPayload(part.output) : null;

  if (askUserQuestionPayload) {
    return (
      <AskUserQuestionCard
        payload={askUserQuestionPayload}
        {...(onAnswerAskUserQuestion ? { onAnswer: onAnswerAskUserQuestion } : {})}
      />
    );
  }

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
        <DeferredConversationBlock
          estimatedHeight={Math.min(360, Math.max(120, Math.ceil(content.length / 10)))}
          placeholderLabel="Rendering tool output..."
          eager={!shouldDeferOutput}
        >
          <div className="border-t border-border/40 px-4 py-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/60 mb-2">Output</div>
            <TruncationNotice truncatedChars={outputPreview.truncatedChars} />
            <pre className={`rounded-xl border px-3 py-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all max-h-64 overflow-y-auto shadow-sm ${
              isError
                ? "border-destructive/20 bg-destructive/5 text-destructive/90"
                : "code-panel"
            }`}>
              {outputPreview.text}
            </pre>
          </div>
        </DeferredConversationBlock>
      )}
    </div>
  );
}

export function AskUserQuestionCard({ payload, onAnswer }: { payload: AskUserQuestionPayload; onAnswer?: (answer: string) => void }) {
  const [selectedByQuestion, setSelectedByQuestion] = useState<Record<number, string[]>>({});
  const [notesByQuestion, setNotesByQuestion] = useState<Record<number, string>>({});

  const toggleOption = useCallback((questionIndex: number, optionLabel: string, multiSelect: boolean) => {
    setSelectedByQuestion((current) => {
      const selected = current[questionIndex] ?? [];
      const next = multiSelect
        ? selected.includes(optionLabel)
          ? selected.filter((item) => item !== optionLabel)
          : [...selected, optionLabel]
        : [optionLabel];
      return {
        ...current,
        [questionIndex]: next
      };
    });
  }, []);

  const answers = payload.questions.map((question, index) => {
    const selected = selectedByQuestion[index] ?? [];
    const note = notesByQuestion[index]?.trim();
    return [selected.join(", "), note].filter(Boolean).join(note && selected.length > 0 ? " — " : "");
  });
  const canSubmit = answers.some((answer) => answer.trim().length > 0);

  return (
    <div className="rounded-2xl border border-sky-200/70 bg-sky-50/70 p-4 text-sm shadow-sm dark:border-sky-500/25 dark:bg-sky-500/10">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-sky-300/60 bg-background/80 text-sky-600 dark:border-sky-400/30 dark:text-sky-300">
          <MessageSquare className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-sky-700/75 dark:text-sky-200/75">User input needed</div>
          {payload.context ? <p className="mt-1 leading-6 text-muted-foreground">{payload.context}</p> : null}
        </div>
      </div>

      <div className="mt-4 space-y-4">
        {payload.questions.map((question, questionIndex) => {
          const selected = selectedByQuestion[questionIndex] ?? [];
          const multiSelect = question.multiSelect === true;
          return (
            <div key={`${question.question}:${questionIndex}`} className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                {question.header ? (
                  <span className="rounded-md border border-sky-300/45 bg-background/70 px-2 py-0.5 text-[10px] font-medium text-sky-700 dark:border-sky-400/25 dark:text-sky-200">
                    {question.header}
                  </span>
                ) : null}
                <div className="font-medium leading-6 text-foreground">{question.question}</div>
              </div>
              {question.options && question.options.length > 0 ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  {question.options.map((option) => {
                    const active = selected.includes(option.label);
                    return (
                      <button
                        key={option.label}
                        type="button"
                        onClick={() => toggleOption(questionIndex, option.label, multiSelect)}
                        className={`rounded-xl border px-3 py-2 text-left transition ${
                          active
                            ? "border-sky-400 bg-sky-100 text-sky-950 shadow-sm dark:border-sky-300/50 dark:bg-sky-400/15 dark:text-sky-50"
                            : "border-border/60 bg-background/75 hover:border-sky-300/60 hover:bg-background"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={`flex h-4 w-4 shrink-0 items-center justify-center border ${
                              multiSelect ? "rounded-[4px]" : "rounded-full"
                            } ${active ? "border-sky-500 bg-sky-500 text-white" : "border-muted-foreground/35"}`}
                          >
                            {active ? <Check className="h-3 w-3" /> : null}
                          </span>
                          <span className="font-medium">{option.label}</span>
                        </div>
                        {option.description ? <div className="mt-1 pl-6 text-xs leading-5 text-muted-foreground">{option.description}</div> : null}
                        {option.preview ? <pre className="mt-2 max-h-28 overflow-auto rounded-lg border bg-background/70 p-2 text-[11px] text-muted-foreground">{option.preview}</pre> : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
              {question.freeText !== false ? (
                <Textarea
                  value={notesByQuestion[questionIndex] ?? ""}
                  onChange={(event) =>
                    setNotesByQuestion((current) => ({
                      ...current,
                      [questionIndex]: event.target.value
                    }))
                  }
                  placeholder="Optional notes or another answer"
                  rows={2}
                  className="min-h-[52px] resize-none bg-background/75 text-sm"
                />
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex items-center justify-end">
        <Button
          type="button"
          size="sm"
          disabled={!canSubmit || !onAnswer}
          onClick={() => onAnswer?.(formatAskUserQuestionAnswer(payload, answers))}
          className="gap-2"
        >
          <Send className="h-3.5 w-3.5" />
          Send answer
        </Button>
      </div>
    </div>
  );
}
