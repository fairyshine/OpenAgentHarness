import type { StoragePostgresTableName } from "@oah/api-contracts";

export const STORAGE_TABLE_META: Record<
  StoragePostgresTableName,
  {
    label: string;
  }
> = {
  workspaces: {
    label: "Workspaces"
  },
  sessions: {
    label: "Sessions"
  },
  runs: {
    label: "Runs"
  },
  messages: {
    label: "Messages"
  },
  run_steps: {
    label: "Run Steps"
  },
  session_events: {
    label: "Session Events"
  },
  session_current_state: {
    label: "Session Current State"
  },
  tool_calls: {
    label: "Tool Calls"
  },
  hook_runs: {
    label: "Hook Runs"
  },
  artifacts: {
    label: "Artifacts"
  },
  history_events: {
    label: "History Events"
  },
  archives: {
    label: "Archives"
  }
};

export function StorageToolbarMeta(props: { label: string; value: string | number }) {
  return (
    <div className="rounded-full border border-border/70 px-2.5 py-1 text-xs text-muted-foreground">
      <span className="uppercase tracking-[0.12em]">{props.label}</span>
      <span className="ml-1.5 font-medium tracking-normal text-foreground">{props.value}</span>
    </div>
  );
}
