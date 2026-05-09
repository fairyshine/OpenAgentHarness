import type { StoragePostgresTableName } from "@oah/api-contracts";

const storagePostgresTables: StoragePostgresTableName[] = [
  "workspaces",
  "sessions",
  "runs",
  "messages",
  "run_steps",
  "session_events",
  "tool_calls",
  "hook_runs",
  "artifacts",
  "history_events",
  "archives"
];

function storageTablePreviewLimit(table: StoragePostgresTableName) {
  switch (table) {
    case "session_events":
    case "run_steps":
      return 20;
    case "messages":
    case "tool_calls":
    case "hook_runs":
    case "archives":
      return 25;
    default:
      return 50;
  }
}

export { storagePostgresTables, storageTablePreviewLimit };
