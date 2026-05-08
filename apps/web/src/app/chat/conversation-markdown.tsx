import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components as MarkdownComponents } from "react-markdown";
import remarkGfm from "remark-gfm";

import { LONG_MESSAGE_COLLAPSE_CHARS, LONG_MESSAGE_PREVIEW_CHARS } from "./conversation-model";

const MARKDOWN_REMARK_PLUGINS = [remarkGfm];

export function estimateMarkdownBlockHeight(text: string) {
  const lineCount = text.split("\n").length;
  return Math.min(720, Math.max(120, lineCount * 24 + Math.ceil(text.length / 14)));
}

export function shouldDeferMarkdownRendering(text: string) {
  return text.length > 1400 || text.includes("```") || text.includes("|");
}

export function DeferredConversationBlock({
  children,
  estimatedHeight,
  placeholderLabel,
  rootMargin = "320px 0px",
  eager = false
}: {
  children: ReactNode;
  estimatedHeight: number;
  placeholderLabel: string;
  rootMargin?: string;
  eager?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [shouldRender, setShouldRender] = useState(eager);

  useEffect(() => {
    if (eager) {
      setShouldRender(true);
      return;
    }

    if (shouldRender) {
      return;
    }

    const element = containerRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setShouldRender(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShouldRender(true);
          observer.disconnect();
        }
      },
      {
        rootMargin
      }
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [eager, rootMargin, shouldRender]);

  return (
    <div ref={containerRef}>
      {shouldRender ? (
        children
      ) : (
        <div
          className="rounded-xl border border-border/50 bg-background/40 px-3 py-2 text-xs text-muted-foreground/70"
          style={{ minHeight: estimatedHeight }}
        >
          {placeholderLabel}
        </div>
      )}
    </div>
  );
}

export function ExpandableMarkdownText({
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
  const shouldDeferRichMarkdown = shouldDeferMarkdownRendering(text);
  const markdownNode = <MarkdownText text={text} {...(isUser !== undefined ? { isUser } : {})} />;

  if (!shouldCollapse) {
    if (!shouldDeferRichMarkdown) {
      return markdownNode;
    }

    return (
      <DeferredConversationBlock
        estimatedHeight={estimateMarkdownBlockHeight(text)}
        placeholderLabel="Rendering message..."
      >
        {markdownNode}
      </DeferredConversationBlock>
    );
  }

  return (
    <div className="space-y-3">
      {expanded ? (
        shouldDeferRichMarkdown ? (
          <DeferredConversationBlock
            estimatedHeight={estimateMarkdownBlockHeight(text)}
            placeholderLabel="Rendering message..."
            eager={expanded}
          >
            {markdownNode}
          </DeferredConversationBlock>
        ) : (
          markdownNode
        )
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


export function MarkdownText({ text, isUser }: { text: string; isUser?: boolean }) {
  const markdownComponents = useMemo(
    (): MarkdownComponents => ({
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
      td: ({ children }) => <td className="border border-current/20 px-2 py-1">{children}</td>
    }),
    [isUser]
  );

  return (
    <ReactMarkdown
      remarkPlugins={MARKDOWN_REMARK_PLUGINS}
      components={markdownComponents}
    >
      {text}
    </ReactMarkdown>
  );
}

