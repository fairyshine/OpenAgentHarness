import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { Download, Search, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import { useUiStore } from "../stores/ui-store";
import { downloadJsonFile, formatTimestamp, prettyJson, toneBadgeClass, type ConsoleFilter, type RuntimeConsoleEntry } from "../support";
import { useShallow } from "zustand/shallow";

const filters: Array<{ id: ConsoleFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "errors", label: "Errors" },
  { id: "runs", label: "Runs" },
  { id: "tools", label: "Tools" },
  { id: "hooks", label: "Hooks" },
  { id: "model", label: "Model" },
  { id: "system", label: "System" }
];

const CONSOLE_ROW_GAP_PX = 8;
const CONSOLE_ROW_ESTIMATED_HEIGHT_PX = 72;
const CONSOLE_ROW_EXPANDED_ESTIMATED_HEIGHT_PX = 220;
const CONSOLE_OVERSCAN_PX = 720;

function levelBadgeClass(level: RuntimeConsoleEntry["level"]) {
  switch (level) {
    case "error":
      return toneBadgeClass("rose");
    case "warn":
      return toneBadgeClass("amber");
    case "debug":
      return toneBadgeClass("sky");
    default:
      return toneBadgeClass("emerald");
  }
}

function matchesConsoleFilter(entry: RuntimeConsoleEntry, filter: ConsoleFilter) {
  switch (filter) {
    case "all":
      return true;
    case "errors":
      return entry.level === "error" || entry.level === "warn";
    case "runs":
      return entry.category === "run" || entry.category === "agent";
    case "tools":
      return entry.category === "tool";
    case "hooks":
      return entry.category === "hook";
    case "model":
      return entry.category === "model";
    case "system":
      return entry.category === "system" || entry.category === "http";
  }
}

function readConsoleEntryDetailsText(
  entry: RuntimeConsoleEntry,
  cache: Map<string, { details: RuntimeConsoleEntry["details"]; text: string }>
) {
  const cached = cache.get(entry.id);
  if (cached && Object.is(cached.details, entry.details)) {
    return cached.text;
  }

  const text = entry.details === undefined ? "" : prettyJson(entry.details);
  cache.set(entry.id, {
    details: entry.details,
    text
  });
  return text;
}

interface EngineConsolePanelProps {
  isOpen: boolean;
  entries: RuntimeConsoleEntry[];
  onEntryInspect: (entry: RuntimeConsoleEntry) => void;
}

type ConsoleEntryRowProps = {
  entry: RuntimeConsoleEntry;
  isExpanded: boolean;
  onInspect: (entry: RuntimeConsoleEntry) => void;
  onToggleExpanded: (entryId: string) => void;
};

type ConsoleVirtualRowProps = ConsoleEntryRowProps & {
  onHeightChange: (entryId: string, height: number) => void;
};

function ConsoleEntryRowImpl(props: ConsoleEntryRowProps) {
  const { entry, isExpanded, onInspect, onToggleExpanded } = props;

  return (
    <article
      className={cn(
        "rounded-2xl border px-3 py-2 transition",
        entry.level === "error" ? toneBadgeClass("rose") : "console-entry"
      )}
    >
      <div className="flex flex-wrap items-start gap-2">
        <span className="pt-0.5 text-[11px] text-muted-foreground">{formatTimestamp(entry.timestamp)}</span>
        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] ${levelBadgeClass(entry.level)}`}>
          {entry.level}
        </span>
        <span className="console-chip rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-foreground/68">
          {entry.category}
        </span>
        {entry.runId ? (
          <button
            type="button"
            onClick={() => onInspect(entry)}
            className="console-chip rounded-full px-2 py-0.5 text-[10px] text-foreground/68 hover:text-foreground"
          >
            {entry.runId}
          </button>
        ) : null}
        <button
          type="button"
          className="min-w-0 flex-1 text-left text-foreground/84"
          onClick={() => {
            if (entry.details !== undefined) {
              onToggleExpanded(entry.id);
              return;
            }

            if (entry.eventId || entry.runId || entry.stepId) {
              onInspect(entry);
            }
          }}
        >
          <span className="whitespace-pre-wrap break-words leading-6">{entry.message}</span>
        </button>
      </div>
      {entry.details !== undefined && isExpanded ? (
        <pre className="console-detail mt-2 max-h-56 overflow-auto rounded-xl p-3 text-[11px] leading-6">
          {prettyJson(entry.details)}
        </pre>
      ) : null}
    </article>
  );
}

function areConsoleEntryRowPropsEqual(previous: ConsoleEntryRowProps, next: ConsoleEntryRowProps) {
  return previous.entry === next.entry && previous.isExpanded === next.isExpanded;
}

const ConsoleEntryRow = memo(ConsoleEntryRowImpl, areConsoleEntryRowPropsEqual);

const ConsoleVirtualRow = memo(function ConsoleVirtualRow(props: ConsoleVirtualRowProps) {
  const { entry, isExpanded, onInspect, onToggleExpanded, onHeightChange } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    const reportHeight = () => {
      onHeightChange(entry.id, Math.ceil(element.getBoundingClientRect().height));
    };

    reportHeight();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      reportHeight();
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [entry.id, isExpanded, onHeightChange]);

  return (
    <div ref={containerRef}>
      <ConsoleEntryRow
        entry={entry}
        isExpanded={isExpanded}
        onInspect={onInspect}
        onToggleExpanded={onToggleExpanded}
      />
    </div>
  );
});

function EngineConsolePanelImpl(props: EngineConsolePanelProps) {
  const { height, onHeightChange, filter, onFilterChange, setConsoleOpen } = useUiStore(
    useShallow((state) => ({
      height: state.consoleHeight,
      onHeightChange: state.setConsoleHeight,
      filter: state.consoleFilter,
      onFilterChange: state.setConsoleFilter,
      setConsoleOpen: state.setConsoleOpen
    }))
  );
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [autoScroll, setAutoScroll] = useState(true);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [rowHeightVersion, setRowHeightVersion] = useState(0);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const detailsTextCacheRef = useRef(new Map<string, { details: RuntimeConsoleEntry["details"]; text: string }>());
  const rowHeightsRef = useRef(new Map<string, number>());

  const handleToggleExpanded = useCallback((entryId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(entryId)) {
        next.delete(entryId);
      } else {
        next.add(entryId);
      }
      return next;
    });
  }, []);

  const handleViewportScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
  }, []);

  const handleRowHeightChange = useCallback((entryId: string, height: number) => {
    const normalizedHeight = Math.max(CONSOLE_ROW_ESTIMATED_HEIGHT_PX, height);
    if (rowHeightsRef.current.get(entryId) === normalizedHeight) {
      return;
    }

    rowHeightsRef.current.set(entryId, normalizedHeight);
    setRowHeightVersion((current) => current + 1);
  }, []);

  const { visibleEntries, errorCount, toolEventCount } = useMemo(() => {
    const searchQuery = deferredSearch.trim().toLowerCase();
    const visibleEntries = props.entries.filter((entry) => {
      if (!matchesConsoleFilter(entry, filter)) {
        return false;
      }

      if (!searchQuery) {
        return true;
      }

      const searchable = `${entry.message}\n${readConsoleEntryDetailsText(entry, detailsTextCacheRef.current)}`.toLowerCase();
      return searchable.includes(searchQuery);
    });

    let errorCount = 0;
    let toolEventCount = 0;
    for (const entry of props.entries) {
      if (entry.level === "error") {
        errorCount += 1;
      }
      if (entry.category === "tool") {
        toolEventCount += 1;
      }
    }

    return {
      visibleEntries,
      errorCount,
      toolEventCount
    };
  }, [deferredSearch, filter, props.entries]);

  const virtualRows = useMemo(() => {
    if (visibleEntries.length === 0) {
      return {
        items: [] as RuntimeConsoleEntry[],
        topSpacerHeight: 0,
        bottomSpacerHeight: 0
      };
    }

    const overscanStart = Math.max(0, scrollTop - CONSOLE_OVERSCAN_PX);
    const overscanEnd = scrollTop + viewportHeight + CONSOLE_OVERSCAN_PX;
    let topSpacerHeight = 0;
    let totalHeight = 0;
    let renderStartIndex = 0;
    let renderEndIndex = visibleEntries.length;
    let foundStart = false;
    let foundEnd = false;

    for (let index = 0; index < visibleEntries.length; index += 1) {
      const entry = visibleEntries[index];
      if (!entry) {
        continue;
      }

      const estimatedHeight =
        rowHeightsRef.current.get(entry.id) ??
        (expandedIds.has(entry.id) ? CONSOLE_ROW_EXPANDED_ESTIMATED_HEIGHT_PX : CONSOLE_ROW_ESTIMATED_HEIGHT_PX);
      const itemTop = totalHeight;
      const itemBottom = itemTop + estimatedHeight;

      if (!foundStart && itemBottom >= overscanStart) {
        renderStartIndex = index;
        topSpacerHeight = itemTop;
        foundStart = true;
      }

      if (!foundEnd && itemTop > overscanEnd) {
        renderEndIndex = index;
        foundEnd = true;
      }

      totalHeight = itemBottom + (index < visibleEntries.length - 1 ? CONSOLE_ROW_GAP_PX : 0);
    }

    if (!foundStart) {
      renderStartIndex = Math.max(0, visibleEntries.length - 1);
      topSpacerHeight = Math.max(0, totalHeight - CONSOLE_ROW_ESTIMATED_HEIGHT_PX);
    }

    const items = visibleEntries.slice(renderStartIndex, renderEndIndex);
    const renderedHeight = items.reduce((sum, entry, index) => {
      const estimatedHeight =
        rowHeightsRef.current.get(entry.id) ??
        (expandedIds.has(entry.id) ? CONSOLE_ROW_EXPANDED_ESTIMATED_HEIGHT_PX : CONSOLE_ROW_ESTIMATED_HEIGHT_PX);
      return sum + estimatedHeight + (index < items.length - 1 ? CONSOLE_ROW_GAP_PX : 0);
    }, 0);

    return {
      items,
      topSpacerHeight,
      bottomSpacerHeight: Math.max(0, totalHeight - topSpacerHeight - renderedHeight)
    };
  }, [expandedIds, rowHeightVersion, scrollTop, viewportHeight, visibleEntries]);

  useEffect(() => {
    if (autoScroll && props.isOpen) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [autoScroll, props.isOpen, visibleEntries]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    setViewportHeight(viewport.clientHeight);

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      setViewportHeight(viewport.clientHeight);
    });
    observer.observe(viewport);
    return () => {
      observer.disconnect();
    };
  }, [height, props.isOpen]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const dragState = dragStateRef.current;
      if (!dragState) {
        return;
      }

      const minHeight = 170;
      const maxHeight = Math.max(minHeight, Math.floor(window.innerHeight * 0.72));
      const nextHeight = dragState.startHeight + (dragState.startY - event.clientY);
      onHeightChange(Math.min(maxHeight, Math.max(minHeight, nextHeight)));
    };

    const handlePointerUp = () => {
      dragStateRef.current = null;
      setDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [onHeightChange]);

  if (!props.isOpen) {
    return null;
  }

  return (
    <section className="console-surface" style={{ height }}>
      <div
        className={cn(
          "console-resizer h-2 cursor-ns-resize transition-colors",
          dragging ? "console-resizer-active" : undefined
        )}
        onPointerDown={(event) => {
          dragStateRef.current = { startY: event.clientY, startHeight: height };
          setDragging(true);
          document.body.style.cursor = "ns-resize";
          document.body.style.userSelect = "none";
        }}
      />
      <div className="flex h-[calc(100%-8px)] min-h-0 flex-col">
        <div className="console-divider flex flex-wrap items-center gap-2 border-b px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground/56">Console</span>
            <Badge variant="secondary">{visibleEntries.length}</Badge>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {filters.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => onFilterChange(option.id)}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-[11px] transition",
                  filter === option.id ? "console-filter-chip-active" : "console-filter-chip"
                )}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <div className="relative w-44 sm:w-56">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search logs" className="h-8 pl-8 text-xs" />
            </div>
            <div className="console-chip flex items-center gap-2 rounded-full px-2.5 py-1.5">
              <Switch checked={autoScroll} onCheckedChange={setAutoScroll} size="sm" />
              <span className="text-[11px] text-muted-foreground">Auto-scroll</span>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => downloadJsonFile(`engine-console-${new Date().toISOString()}.json`, visibleEntries)}
            >
              <Download className="h-3.5 w-3.5" />
              Export
            </Button>
            <Button type="button" variant="ghost" size="icon" onClick={() => setConsoleOpen(false)} aria-label="Close console">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <ScrollArea
          className="min-h-0 flex-1"
          viewportProps={{
            className: "px-2 py-2",
            ref: viewportRef,
            onScroll: handleViewportScroll
          }}
        >
          {visibleEntries.length === 0 ? (
            <div className="flex h-full min-h-48 items-center justify-center text-sm text-muted-foreground">No console entries yet.</div>
          ) : (
            <div className="pb-2 font-mono text-xs">
              {virtualRows.topSpacerHeight > 0 ? <div style={{ height: virtualRows.topSpacerHeight }} aria-hidden="true" /> : null}
              <div className="space-y-2">
                {virtualRows.items.map((entry) => (
                  <ConsoleVirtualRow
                    key={entry.id}
                    entry={entry}
                    isExpanded={expandedIds.has(entry.id)}
                    onInspect={props.onEntryInspect}
                    onToggleExpanded={handleToggleExpanded}
                    onHeightChange={handleRowHeightChange}
                  />
                ))}
              </div>
              {virtualRows.bottomSpacerHeight > 0 ? <div style={{ height: virtualRows.bottomSpacerHeight }} aria-hidden="true" /> : null}
              <div ref={bottomRef} />
            </div>
          )}
        </ScrollArea>

        <div className="console-divider flex flex-wrap items-center gap-3 border-t px-3 py-2 text-[11px] text-muted-foreground">
          <span>{visibleEntries.length} visible entries</span>
          <span>{errorCount} errors</span>
          <span>{toolEventCount} tool events</span>
        </div>
      </div>
    </section>
  );
}

export const EngineConsolePanel = memo(EngineConsolePanelImpl);
