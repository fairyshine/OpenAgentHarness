import { memo } from "react";

import { AlertCircle, Folder, LoaderCircle, Network, PencilLine, Trash2 } from "lucide-react";
import type { Run } from "@oah/api-contracts";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { formatTimestamp, pathLeaf, type SavedSessionRecord, type SavedWorkspaceRecord } from "../support";

function workspaceItemClass(active: boolean) {
  return active ? "text-foreground" : "text-foreground/68";
}

function sessionItemClass(active: boolean) {
  return active ? "ob-list-item-active" : "";
}

function formatRelativeShort(value?: string) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const diffMs = Date.now() - date.getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  if (diffMs < dayMs) {
    return "Today";
  }
  const days = Math.max(1, Math.round(diffMs / dayMs));
  if (days < 7) {
    return `${days} d`;
  }
  return `${Math.max(1, Math.round(days / 7))} w`;
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

type WorkspaceNavItemProps = {
  entry: SavedWorkspaceRecord;
  active: boolean;
  expanded: boolean;
  sessionCount: number;
  lastEditedAt?: string;
  canRemove: boolean;
  onSelect: () => void;
  onToggleExpanded: () => void;
  onRemove: () => void;
};

function WorkspaceNavItemImpl(props: WorkspaceNavItemProps) {
  const folderName = pathLeaf(props.entry.rootPath);

  return (
    <div
      className={`ob-list-item ob-workspace-item group relative flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors cursor-pointer ${workspaceItemClass(props.active)}`}
      onClick={() => {
        if (hasTextSelection()) return;
        props.onSelect();
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex min-w-0 flex-1 items-center gap-2 pr-7">
            <button
              type="button"
              className={`ob-list-item-icon ob-workspace-item-icon flex h-5 w-5 shrink-0 items-center justify-center rounded-md ${props.active ? "ob-list-item-icon-active" : ""}`}
              onClick={(event) => {
                event.stopPropagation();
                props.onToggleExpanded();
              }}
              title={props.expanded ? "Collapse workspace" : "Expand workspace"}
            >
              <Folder className="h-4 w-4" />
            </button>
            <div className="min-w-0 flex-1 select-text leading-tight">
              <p className="truncate text-sm font-medium tracking-[-0.018em]">{props.entry.name}</p>
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
            {props.entry.runtime ? <DetailLine label="runtime" value={props.entry.runtime} /> : null}
            <DetailLine label="id" value={props.entry.id} mono />
            {folderName ? <DetailLine label="dir" value={folderName} /> : null}
          </div>
        </TooltipContent>
      </Tooltip>
      <Button
        variant="ghost"
        size="icon"
        className="ob-list-item-control absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2 shrink-0 rounded-md text-muted-foreground/58 opacity-70 transition-opacity group-hover:opacity-100"
        onClick={(event) => {
          event.stopPropagation();
          if (props.canRemove) {
            props.onRemove();
          } else {
            props.onToggleExpanded();
          }
        }}
        title={props.canRemove ? "Delete workspace" : props.expanded ? "Collapse workspace" : "Expand workspace"}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function areWorkspaceNavItemPropsEqual(previous: WorkspaceNavItemProps, next: WorkspaceNavItemProps) {
  return (
    previous.active === next.active &&
    previous.expanded === next.expanded &&
    previous.sessionCount === next.sessionCount &&
    previous.lastEditedAt === next.lastEditedAt &&
    previous.canRemove === next.canRemove &&
    previous.entry.id === next.entry.id &&
    previous.entry.name === next.entry.name &&
    previous.entry.rootPath === next.entry.rootPath &&
    previous.entry.runtime === next.entry.runtime &&
    previous.entry.serviceName === next.entry.serviceName &&
    previous.entry.status === next.entry.status &&
    previous.entry.createdAt === next.entry.createdAt &&
    previous.entry.updatedAt === next.entry.updatedAt &&
    previous.entry.lastOpenedAt === next.entry.lastOpenedAt
  );
}

export const WorkspaceNavItem = memo(WorkspaceNavItemImpl, areWorkspaceNavItemPropsEqual);

type SessionNavItemProps = {
  entry: SavedSessionRecord;
  active: boolean;
  runStatus?: Run["status"];
  depth?: number;
  childSessions?: Array<{
    entry: SavedSessionRecord;
    depth: number;
    runStatus?: Run["status"] | undefined;
    active: boolean;
  }>;
  onSelect: () => void;
  onSelectChild?: (sessionId: string) => void;
  onRename: (title: string) => void | Promise<void>;
  onRemove: () => void;
};

function SessionNavItemImpl(props: SessionNavItemProps) {
  const primaryTime = formatTimestamp(props.entry.lastRunAt || props.entry.createdAt);
  const relativeTime = formatRelativeShort(props.entry.lastRunAt || props.entry.createdAt);
  const subtitle = [props.entry.agentName, primaryTime].filter(Boolean).join(" · ");
  const hasActiveRunStatus =
    props.runStatus === "queued" || props.runStatus === "running" || props.runStatus === "waiting_tool";
  const hasProblemRunStatus = props.runStatus === "failed" || props.runStatus === "timed_out";
  const childSessions = props.childSessions ?? [];
  const hasChildren = childSessions.length > 0;
  const activeChild = childSessions.find((child) => child.active);
  const isChild = (props.depth ?? 0) > 0;
  const rowSurfaceClass = isChild
    ? props.active
      ? "ob-list-item-child-active"
      : ""
    : sessionItemClass(props.active);
  const titleToneClass = isChild
    ? props.active
      ? "text-sm font-medium text-foreground"
      : "text-sm font-medium text-foreground/68 group-hover:text-foreground/82"
    : "text-sm font-medium tracking-[-0.018em] text-foreground/76";

  return (
    <div
      className={`ob-list-item group relative flex items-center gap-2 transition-colors cursor-pointer ${
        isChild ? "ob-session-item-child rounded-md py-1.5 pr-2 shadow-none" : "ob-session-item rounded-xl py-1.5 pr-2"
      } ${rowSurfaceClass}`}
      style={{
        paddingLeft: "8px"
      }}
      onClick={() => {
        if (hasTextSelection()) return;
        props.onSelect();
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex min-w-0 flex-1 items-center gap-2 text-left">
            <div className="min-w-0 flex-1 select-text leading-tight">
              <div className="flex min-w-0 items-center">
                <p className={`truncate ${titleToneClass}`}>
                  {props.entry.title || "Untitled session"}
                </p>
              </div>
            </div>
            {hasChildren ? (
              <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full border border-foreground/8 bg-background/50 px-1 text-[10px] font-medium text-muted-foreground/68 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
                {childSessions.length}
              </span>
            ) : null}
            {hasActiveRunStatus ? (
              <LoaderCircle
                className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground/70 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"
                aria-label={props.runStatus}
              />
            ) : hasProblemRunStatus ? (
              <AlertCircle
                className="h-3.5 w-3.5 shrink-0 text-destructive/70 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"
                aria-label={props.runStatus}
              />
            ) : null}
            {relativeTime ? (
              <span className="shrink-0 text-xs text-muted-foreground/58 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
                {relativeTime}
              </span>
            ) : null}
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
            {props.entry.parentSessionId ? <DetailLine label="type" value="subagent session" /> : null}
            {hasChildren ? <DetailLine label="children" value={String(childSessions.length)} /> : null}
            {activeChild ? <DetailLine label="selected child" value={activeChild.entry.title || activeChild.entry.id} /> : null}
            {props.runStatus ? <DetailLine label="status" value={props.runStatus} /> : null}
            <DetailLine label="created" value={formatTimestamp(props.entry.createdAt)} />
            {props.entry.lastRunAt ? <DetailLine label="last run" value={formatTimestamp(props.entry.lastRunAt)} /> : null}
            {props.entry.agentName ? <DetailLine label="agent" value={props.entry.agentName} /> : null}
          </div>
        </TooltipContent>
      </Tooltip>
      <div
        className="absolute right-1 top-1/2 flex -translate-y-1/2 translate-x-1 items-center gap-0.5 opacity-0 transition-all pointer-events-none group-hover:pointer-events-auto group-hover:translate-x-0 group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:translate-x-0 group-focus-within:opacity-100"
      >
        {hasChildren ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={`ob-list-item-control h-4 w-4 shrink-0 rounded-[8px] text-muted-foreground/66 ${activeChild ? "text-foreground/76" : ""}`}
                title="Open child sessions"
                onClick={(event) => event.stopPropagation()}
              >
                <Network className="h-[11px] w-[11px]" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              side="right"
              sideOffset={8}
              className="w-[280px] rounded-2xl p-1.5"
              onClick={(event) => event.stopPropagation()}
            >
              <DropdownMenuLabel className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Child sessions
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <div className="max-h-[320px] overflow-y-auto">
                {childSessions.map((child) => {
                  const childTitle = child.entry.title || "Untitled session";
                  const childTime = formatRelativeShort(child.entry.lastRunAt || child.entry.createdAt);
                  const childActiveRun =
                    child.runStatus === "queued" || child.runStatus === "running" || child.runStatus === "waiting_tool";
                  const childProblemRun = child.runStatus === "failed" || child.runStatus === "timed_out";
                  return (
                    <DropdownMenuItem
                      key={child.entry.id}
                      className={`mx-0.5 min-h-10 rounded-xl px-2 py-2 ${child.active ? "bg-accent text-accent-foreground" : ""}`}
                      onSelect={() => props.onSelectChild?.(child.entry.id)}
                    >
                      <div
                        className="flex min-w-0 flex-1 items-center gap-2"
                        style={{
                          paddingLeft: `${Math.max(0, child.depth - 1) * 10}px`
                        }}
                      >
                        <Network className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-medium">{childTitle}</div>
                          <div className="truncate text-[11px] text-muted-foreground">
                            {[child.entry.agentName, childTime].filter(Boolean).join(" · ")}
                          </div>
                        </div>
                        {childActiveRun ? (
                          <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground/70" />
                        ) : childProblemRun ? (
                          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive/70" />
                        ) : null}
                      </div>
                    </DropdownMenuItem>
                  );
                })}
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
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

function areSessionNavItemPropsEqual(previous: SessionNavItemProps, next: SessionNavItemProps) {
  return (
    previous.active === next.active &&
    previous.runStatus === next.runStatus &&
    previous.depth === next.depth &&
    previous.childSessions === next.childSessions &&
    previous.entry.id === next.entry.id &&
    previous.entry.workspaceId === next.entry.workspaceId &&
    previous.entry.parentSessionId === next.entry.parentSessionId &&
    previous.entry.title === next.entry.title &&
    previous.entry.modelRef === next.entry.modelRef &&
    previous.entry.agentName === next.entry.agentName &&
    previous.entry.lastRunAt === next.entry.lastRunAt &&
    previous.entry.createdAt === next.entry.createdAt &&
    previous.entry.lastOpenedAt === next.entry.lastOpenedAt
  );
}

export const SessionNavItem = memo(SessionNavItemImpl, areSessionNavItemPropsEqual);
