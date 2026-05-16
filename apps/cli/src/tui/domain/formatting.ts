import type { Run, Session, WorkspaceRuntime } from "@oah/api-contracts";

import type { VisibleWindow } from "./types.js";

export const STATUS_COLORS: Record<string, string> = {
  active: "green",
  archived: "yellow",
  closed: "yellow",
  disabled: "red",
  queued: "yellow",
  running: "cyan",
  waiting_tool: "magenta",
  completed: "green",
  failed: "red",
  cancelled: "yellow",
  timed_out: "red"
};

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const SLASH_COMMANDS = [
  { command: "/help", description: "Show shortcuts" },
  { command: "/clear", description: "Clear the current transcript view" },
  { command: "/workspace", description: "Switch workspace" },
  { command: "/session", description: "Switch session in current workspace" },
  { command: "/memory", description: "Inspect workspace memory" },
  { command: "/new-workspace", description: "Create workspace" },
  { command: "/new-session", description: "Create session" },
  { command: "/quit", description: "Exit OAH" }
] as const;

export function getSlashCommandMatches(value: string) {
  if (!value.startsWith("/") || value.includes(" ")) {
    return [];
  }
  return SLASH_COMMANDS.filter((item) => item.command.startsWith(value));
}

export function insertTextAt(value: string, cursor: number, input: string) {
  return `${value.slice(0, cursor)}${input}${value.slice(cursor)}`;
}

export function clampIndex(index: number, length: number) {
  if (length <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(index, length - 1));
}

export function visibleWindow<T>(items: T[], selectedIndex: number, limit: number): VisibleWindow<T> {
  if (items.length <= limit) {
    return { items, offset: 0 };
  }
  const half = Math.floor(limit / 2);
  const offset = Math.max(0, Math.min(selectedIndex - half, items.length - limit));
  return {
    items: items.slice(offset, offset + limit),
    offset
  };
}

export function getRuntimeMatches(runtimes: WorkspaceRuntime[], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return runtimes;
  }
  return runtimes
    .filter((runtime) => runtime.name.toLowerCase().includes(needle))
    .sort((left, right) => {
      const leftStarts = left.name.toLowerCase().startsWith(needle);
      const rightStarts = right.name.toLowerCase().startsWith(needle);
      if (leftStarts === rightStarts) {
        return left.name.localeCompare(right.name);
      }
      return leftStarts ? -1 : 1;
    });
}

export function shortId(id: string | undefined) {
  if (!id) {
    return "-";
  }
  return id.length <= 12 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`;
}

export function formatTime(value: string | undefined) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

export function latestSessionRun(runs: Run[]): Run | undefined {
  return [...runs].sort((left, right) => {
    const leftTime = Date.parse(left.endedAt ?? left.heartbeatAt ?? left.startedAt ?? left.createdAt);
    const rightTime = Date.parse(right.endedAt ?? right.heartbeatAt ?? right.startedAt ?? right.createdAt);
    if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) {
      return left.id.localeCompare(right.id);
    }
    if (Number.isNaN(leftTime)) {
      return 1;
    }
    if (Number.isNaN(rightTime)) {
      return -1;
    }
    return rightTime - leftTime;
  })[0];
}

export function formatSessionActivity(session: Session, run: Run | undefined): { label: string; tone: string; detail: string } {
  if (!run) {
    return {
      label: session.status,
      tone: STATUS_COLORS[session.status] ?? "white",
      detail: `updated ${formatTime(session.updatedAt)}`
    };
  }
  const runTime = run.endedAt ?? run.heartbeatAt ?? run.startedAt ?? run.createdAt;
  switch (run.status) {
    case "queued":
      return { label: "queued", tone: STATUS_COLORS.queued ?? "yellow", detail: `queued ${formatTime(run.createdAt)}` };
    case "running":
      return { label: "running", tone: STATUS_COLORS.running ?? "cyan", detail: `started ${formatTime(run.startedAt ?? run.createdAt)}` };
    case "waiting_tool":
      return { label: "waiting tool", tone: STATUS_COLORS.waiting_tool ?? "magenta", detail: `waiting ${formatTime(run.heartbeatAt ?? runTime)}` };
    case "completed":
      return { label: "completed", tone: STATUS_COLORS.completed ?? "green", detail: `completed ${formatTime(run.endedAt ?? runTime)}` };
    case "failed":
      return { label: "failed", tone: STATUS_COLORS.failed ?? "red", detail: `failed ${formatTime(run.endedAt ?? runTime)}` };
    case "cancelled":
      return { label: "cancelled", tone: STATUS_COLORS.cancelled ?? "yellow", detail: `cancelled ${formatTime(run.endedAt ?? runTime)}` };
    case "timed_out":
      return { label: "timed out", tone: STATUS_COLORS.timed_out ?? "red", detail: `timed out ${formatTime(run.endedAt ?? runTime)}` };
    default:
      return { label: run.status, tone: STATUS_COLORS[run.status] ?? "white", detail: `updated ${formatTime(runTime)}` };
  }
}
