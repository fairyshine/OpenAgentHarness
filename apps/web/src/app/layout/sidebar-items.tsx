import { Bot, ChevronDown, ChevronRight, Folder, PencilLine, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { formatTimestamp, pathLeaf, type SavedSessionRecord, type SavedWorkspaceRecord } from "../support";

function workspaceItemClass(active: boolean) {
  return active ? "ob-list-item-active text-foreground" : "text-foreground/82";
}

function sessionItemClass(active: boolean) {
  return active ? "ob-list-item-active" : "";
}

function hasTextSelection() {
  const selection = window.getSelection();
  return Boolean(selection && selection.type === "Range" && selection.toString().trim());
}

function DetailLine(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-2">
      <span className="shrink-0 text-[10px] uppercase tracking-[0.14em] text-background/60">{props.label}</span>
      <span className={`min-w-0 break-all text-[11px] text-background/88 ${props.mono ? "font-mono" : ""}`}>{props.value}</span>
    </div>
  );
}

export function WorkspaceNavItem(props: {
  entry: SavedWorkspaceRecord;
  active: boolean;
  expanded: boolean;
  sessionCount: number;
  lastEditedAt?: string;
  canRemove: boolean;
  onSelect: () => void;
  onToggleExpanded: () => void;
  onRemove: () => void;
}) {
  const ExpandIcon = props.expanded ? ChevronDown : ChevronRight;
  const folderName = pathLeaf(props.entry.rootPath);
  const metaLine = [
    `${props.sessionCount} sessions`,
    props.lastEditedAt ? formatTimestamp(props.lastEditedAt) : undefined
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      className={`ob-list-item ob-workspace-item group relative flex items-center gap-1.5 rounded-xl px-2 py-2 transition-colors cursor-pointer ${workspaceItemClass(props.active)}`}
      onClick={() => {
        if (hasTextSelection()) return;
        props.onSelect();
      }}
    >
      {props.active ? <span className="ob-list-item-branch-line-active absolute left-0 top-2 bottom-2 w-1 rounded-full" aria-hidden="true" /> : null}
      <Button
        variant="ghost"
        size="icon"
        className="ob-list-item-control h-4 w-4 shrink-0 rounded-[8px] text-muted-foreground/72"
        onClick={(e) => { e.stopPropagation(); props.onToggleExpanded(); }}
      >
        <ExpandIcon className="h-[11px] w-[11px]" />
      </Button>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div className={`ob-list-item-icon ob-workspace-item-icon flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[9px] ${props.active ? "ob-list-item-icon-active" : ""}`}>
              <Folder className="h-[11px] w-[11px]" />
            </div>
            <div className="min-w-0 select-text leading-tight">
              <p className="truncate text-[13px] font-semibold tracking-[-0.018em] text-foreground">{props.entry.name}</p>
              <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground/88">
                {metaLine ? <span className="truncate">{metaLine}</span> : <span className="truncate text-muted-foreground/70">No recent runs</span>}
              </div>
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={10} className="max-w-sm items-start rounded-xl px-3 py-3">
          <div className="space-y-2">
            <div className="space-y-1">
              <p className="text-sm font-semibold text-background">{props.entry.name}</p>
              <p className="text-[11px] text-background/70">{props.sessionCount} sessions</p>
            </div>
            {props.lastEditedAt ? <DetailLine label="edited" value={formatTimestamp(props.lastEditedAt)} /> : null}
            <DetailLine label="service" value={props.entry.serviceName ?? "default"} />
            {props.entry.blueprint ? <DetailLine label="blueprint" value={props.entry.blueprint} /> : null}
            <DetailLine label="id" value={props.entry.id} mono />
            {folderName ? <DetailLine label="dir" value={folderName} /> : null}
          </div>
        </TooltipContent>
      </Tooltip>
      {props.canRemove ? (
        <Button
          variant="ghost"
          size="icon"
          className="ob-list-item-control h-4 w-4 shrink-0 rounded-[8px] text-muted-foreground/56 opacity-0 group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            props.onRemove();
          }}
          title="Delete workspace"
        >
          <Trash2 className="h-[11px] w-[11px]" />
        </Button>
      ) : null}
    </div>
  );
}

export function SessionNavItem(props: {
  entry: SavedSessionRecord;
  active: boolean;
  depth?: number;
  expanded?: boolean;
  hasChildren?: boolean;
  onSelect: () => void;
  onToggleExpanded?: () => void;
  onRename: (title: string) => void | Promise<void>;
  onRemove: () => void;
}) {
  const primaryTime = formatTimestamp(props.entry.lastRunAt || props.entry.createdAt);
  const subtitle = [props.entry.agentName, primaryTime].filter(Boolean).join(" · ");
  const isChild = (props.depth ?? 0) > 0;
  const ExpandIcon = props.expanded ? ChevronDown : ChevronRight;
  const rowSurfaceClass = isChild
    ? props.active
      ? "ob-list-item-child-active"
      : ""
    : sessionItemClass(props.active);
  const rowPaddingClass = isChild ? "py-1.5 pr-2.5 pl-2" : "px-2 py-2 pr-2";
  const rowGapClass = isChild ? "gap-1.5" : "gap-1.5";
  const controlSizeClass = isChild ? "h-5 w-5" : "h-5 w-5";
  const iconToneClass = props.active ? "ob-list-item-icon-active" : "ob-list-item-icon";
  const titleToneClass = isChild
    ? props.active
      ? "text-[13px] font-medium text-foreground"
      : "text-[13px] font-medium text-foreground/82 group-hover:text-foreground/92"
    : "text-sm font-medium tracking-[-0.018em] text-foreground";
  const metaToneClass = isChild
    ? props.active
      ? "text-[11px] text-muted-foreground/82"
      : "text-[11px] text-muted-foreground/72 group-hover:text-muted-foreground/82"
    : "text-[11px] text-muted-foreground";

  return (
    <div
      className={`ob-list-item group relative flex items-center transition-colors cursor-pointer ${rowGapClass} ${rowPaddingClass} ${rowSurfaceClass} ${
        isChild ? "ob-session-item-child rounded-md shadow-none" : "ob-session-item rounded-xl"
      }`}
      onClick={() => {
        if (hasTextSelection()) return;
        props.onSelect();
      }}
    >
      {isChild ? (
        <>
          <span className={`absolute left-0.5 top-1.5 bottom-1.5 w-px rounded-full ${props.active ? "ob-list-item-branch-line-active" : "ob-list-item-branch-line"}`} aria-hidden="true" />
          {props.active ? <span className="ob-list-item-branch-line-active absolute left-0 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full" aria-hidden="true" /> : null}
        </>
      ) : null}
      {props.hasChildren ? (
        <Button
          variant="ghost"
          size="icon"
          className={`ob-list-item-control ${controlSizeClass} shrink-0 rounded-[8px] text-muted-foreground/70`}
          onClick={(event) => {
            event.stopPropagation();
            props.onToggleExpanded?.();
          }}
          title={props.expanded ? "Collapse child sessions" : "Expand child sessions"}
        >
          <ExpandIcon className="h-[11px] w-[11px]" />
        </Button>
      ) : (
        <div className={`${controlSizeClass} shrink-0`} aria-hidden="true" />
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <div className={`flex min-w-0 flex-1 items-center text-left ${isChild ? "gap-1.5" : "gap-2"}`}>
            <div className={`ob-list-item-icon ${isChild ? "" : "ob-session-item-icon"} flex shrink-0 items-center justify-center rounded-[9px] ${isChild ? "h-6 w-6" : "h-[26px] w-[26px]"} ${iconToneClass}`}>
              <Bot className={isChild ? "h-[11px] w-[11px]" : "h-[11px] w-[11px]"} />
            </div>
            <div className="min-w-0 select-text leading-tight">
              <p className={`truncate ${titleToneClass}`}>
                {props.entry.title || "Untitled session"}
              </p>
              <p className={`mt-1 truncate ${metaToneClass}`}>{primaryTime}</p>
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={10} className="max-w-sm items-start rounded-xl px-3 py-3">
          <div className="space-y-2">
            <div className="space-y-1">
              <p className="text-sm font-semibold text-background">{props.entry.title || "Untitled session"}</p>
              <p className="text-[11px] text-background/70">{subtitle}</p>
            </div>
            <DetailLine label="id" value={props.entry.id} mono />
            {props.entry.parentSessionId ? <DetailLine label="parent" value={props.entry.parentSessionId} mono /> : null}
            {props.hasChildren ? <DetailLine label="children" value={props.expanded ? "expanded" : "collapsed"} /> : null}
            <DetailLine label="created" value={formatTimestamp(props.entry.createdAt)} />
            {props.entry.lastRunAt ? <DetailLine label="last run" value={formatTimestamp(props.entry.lastRunAt)} /> : null}
            {props.entry.agentName ? <DetailLine label="agent" value={props.entry.agentName} /> : null}
          </div>
        </TooltipContent>
      </Tooltip>
      <div
        className={`absolute right-1 top-1/2 flex -translate-y-1/2 translate-x-1 items-center gap-0.5 transition-all ${
          props.active
            ? "opacity-0 pointer-events-none group-hover:pointer-events-auto group-hover:translate-x-0 group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:translate-x-0 group-focus-within:opacity-100"
            : "opacity-0 pointer-events-none group-hover:pointer-events-auto group-hover:translate-x-0 group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:translate-x-0 group-focus-within:opacity-100"
        }`}
      >
        <Button
          variant="ghost"
          size="icon"
          className="ob-list-item-control h-4 w-4 shrink-0 rounded-[8px] text-muted-foreground/66"
          title="Rename session"
          onClick={(event) => {
            event.stopPropagation();
            const nextTitle = window.prompt("请输入新的 Session 名称", props.entry.title ?? "");
            if (nextTitle == null) {
              return;
            }
            void props.onRename(nextTitle);
          }}
        >
          <PencilLine className="h-[11px] w-[11px]" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="ob-list-item-control h-4 w-4 shrink-0 rounded-[8px] text-muted-foreground/66"
          title="Delete session"
          onClick={(event) => {
            event.stopPropagation();
            props.onRemove();
          }}
        >
          <Trash2 className="h-[11px] w-[11px]" />
        </Button>
      </div>
    </div>
  );
}
