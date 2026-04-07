import { Bot, ChevronDown, ChevronRight, Folder, MoreHorizontal, PencilLine, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";

import { formatTimestamp, type SavedSessionRecord, type SavedWorkspaceRecord } from "../support";

function workspaceItemClass(active: boolean) {
  return active
    ? "text-foreground"
    : "text-foreground/82 hover:bg-muted/18 hover:text-foreground/94";
}

function sessionItemClass(active: boolean) {
  return active
    ? "bg-foreground/[0.045] border border-foreground/10 shadow-sm"
    : "border border-transparent hover:bg-muted/30";
}

function hasTextSelection() {
  const selection = window.getSelection();
  return Boolean(selection && selection.type === "Range" && selection.toString().trim());
}

export function WorkspaceNavItem(props: {
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
  const subtitle = [props.entry.template, props.entry.lastOpenedAt ? formatTimestamp(props.entry.lastOpenedAt) : undefined]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      className={`group relative flex items-center gap-2 rounded-lg px-2 py-2.5 transition-colors cursor-pointer ${workspaceItemClass(props.active)}`}
      onClick={() => {
        if (hasTextSelection()) return;
        props.onSelect();
      }}
    >
      {props.active ? <span className="absolute left-0 top-2 bottom-2 w-1 rounded-full bg-foreground/40" aria-hidden="true" /> : null}
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0 rounded-md text-muted-foreground/78 hover:bg-background/55 hover:text-foreground"
        onClick={(e) => { e.stopPropagation(); props.onToggleExpanded(); }}
      >
        <ExpandIcon className="h-3.5 w-3.5" />
      </Button>
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <div className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center ${props.active ? "text-foreground/82" : "text-muted-foreground/78"}`}>
          <Folder className="h-[13px] w-[13px]" />
        </div>
        <div className="min-w-0 select-text">
          <p className="truncate text-sm font-medium text-foreground">{props.entry.name}</p>
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="shrink-0 tabular-nums">{props.sessionCount}</span>
            <span className="shrink-0 opacity-45">sessions</span>
            {subtitle ? <span className="shrink-0 opacity-35">·</span> : null}
            {subtitle ? <span className="truncate">{subtitle}</span> : null}
          </div>
        </div>
      </div>
      {props.canRemove ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 rounded-md text-muted-foreground/56 opacity-0 group-hover:opacity-100 transition hover:bg-background/55 hover:text-foreground"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem variant="destructive" onClick={props.onRemove}>
              <Trash2 className="h-4 w-4" />
              Delete Workspace
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

export function SessionNavItem(props: {
  entry: SavedSessionRecord;
  active: boolean;
  onSelect: () => void;
  onRename: (title: string) => void | Promise<void>;
  onRemove: () => void;
}) {
  const subtitle = [props.entry.agentName, formatTimestamp(props.entry.lastRunAt || props.entry.createdAt)].filter(Boolean).join(" · ");

  return (
    <div
      className={`group relative flex items-center gap-2 rounded-md px-2 py-2.5 pr-[4.25rem] transition-colors cursor-pointer ${sessionItemClass(props.active)}`}
      onClick={() => {
        if (hasTextSelection()) return;
        props.onSelect();
      }}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
        <div className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center ${props.active ? "text-foreground" : "text-muted-foreground"}`}>
          <Bot className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 select-text">
          <p className="truncate text-sm font-medium text-foreground">{props.entry.title || "Untitled session"}</p>
          <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      <div className={`absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-md bg-background/72 px-1 py-0.5 backdrop-blur-sm transition-opacity ${props.active ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 rounded-md text-muted-foreground/72 hover:bg-background/70 hover:text-foreground"
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
          <PencilLine className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 rounded-md text-muted-foreground/72 hover:bg-background/70 hover:text-rose-600 dark:hover:text-rose-400"
          title="Delete session"
          onClick={(event) => {
            event.stopPropagation();
            props.onRemove();
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
