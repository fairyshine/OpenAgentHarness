import { AppError } from "@oah/engine-core";
import type { StoragePostgresTableName } from "@oah/api-contracts";

export type PostgresOverviewCountStatus = "exact" | "cached" | "estimated" | "skipped";

export type PostgresTableSortTerm = {
  expression: string;
  field: string;
  direction: "asc" | "desc";
  nullsLast?: boolean | undefined;
};

export const POSTGRES_TABLE_CONFIG = {
  workspaces: {
    orderBy: "updated_at desc, created_at desc, id asc",
    keyset: [
      { expression: "updated_at", field: "updated_at", direction: "desc" },
      { expression: "created_at", field: "created_at", direction: "desc" },
      { expression: "id", field: "id", direction: "asc" }
    ],
    description: "Workspace registry and resolved catalog snapshots."
  },
  sessions: {
    orderBy: "updated_at desc, created_at desc, id asc",
    keyset: [
      { expression: "updated_at", field: "updated_at", direction: "desc" },
      { expression: "created_at", field: "created_at", direction: "desc" },
      { expression: "id", field: "id", direction: "asc" }
    ],
    description: "Session headers per workspace."
  },
  runs: {
    orderBy: "created_at desc, id asc",
    keyset: [
      { expression: "created_at", field: "created_at", direction: "desc" },
      { expression: "id", field: "id", direction: "asc" }
    ],
    description: "Run lifecycle records and status."
  },
  messages: {
    orderBy: "created_at desc, id asc",
    keyset: [
      { expression: "created_at", field: "created_at", direction: "desc" },
      { expression: "id", field: "id", direction: "asc" }
    ],
    description: "Persisted session messages, with content stored in AI SDK-compatible message format."
  },
  run_steps: {
    orderBy: "coalesce(started_at, ended_at) desc nulls last, seq desc, id asc",
    keyset: [
      { expression: "coalesce(started_at, ended_at)", field: "__oah_sort_0", direction: "desc", nullsLast: true },
      { expression: "seq", field: "seq", direction: "desc" },
      { expression: "id", field: "id", direction: "asc" }
    ],
    description: "Per-run step audit trail. model_call steps snapshot AI SDK-facing request/response data plus OAH audit fields."
  },
  session_events: {
    orderBy: "cursor desc",
    keyset: [{ expression: "cursor", field: "cursor", direction: "desc" }],
    description: "SSE/session event log. Transport/event stream only, not the canonical conversation store."
  },
  session_current_state: {
    orderBy: "updated_at desc, session_id asc",
    keyset: [
      { expression: "updated_at", field: "updated_at", direction: "desc" },
      { expression: "session_id", field: "session_id", direction: "asc" }
    ],
    description: "Session current-state projection for fast WebUI session open and status rendering."
  },
  tool_calls: {
    orderBy: "started_at desc, id asc",
    keyset: [
      { expression: "started_at", field: "started_at", direction: "desc" },
      { expression: "id", field: "id", direction: "asc" }
    ],
    description: "Tool call audit records."
  },
  hook_runs: {
    orderBy: "started_at desc, id asc",
    keyset: [
      { expression: "started_at", field: "started_at", direction: "desc" },
      { expression: "id", field: "id", direction: "asc" }
    ],
    description: "Hook execution audit records."
  },
  artifacts: {
    orderBy: "created_at desc, id asc",
    keyset: [
      { expression: "created_at", field: "created_at", direction: "desc" },
      { expression: "id", field: "id", direction: "asc" }
    ],
    description: "Artifact metadata emitted by runs."
  },
  history_events: {
    orderBy: "id desc",
    keyset: [{ expression: "id", field: "id", direction: "desc" }],
    description: "History mirror event source for workspace mirror sync."
  },
  archives: {
    orderBy: "archived_at desc, id asc",
    keyset: [
      { expression: "archived_at", field: "archived_at", direction: "desc" },
      { expression: "id", field: "id", direction: "asc" }
    ],
    description: "Deletion archive buffer before daily SQLite export."
  }
} satisfies Record<StoragePostgresTableName, { orderBy: string; keyset: PostgresTableSortTerm[]; description: string }>;

export type PostgresTableConfigName = keyof typeof POSTGRES_TABLE_CONFIG;

export const POSTGRES_TABLE_FILTER_COLUMNS: Record<
  StoragePostgresTableName,
  {
    workspaceId?: string;
    sessionId?: string;
    runId?: string;
  }
> = {
  workspaces: {
    workspaceId: "id"
  },
  sessions: {
    workspaceId: "workspace_id",
    sessionId: "id"
  },
  runs: {
    workspaceId: "workspace_id",
    sessionId: "session_id",
    runId: "id"
  },
  messages: {
    sessionId: "session_id",
    runId: "run_id"
  },
  run_steps: {
    runId: "run_id"
  },
  session_events: {
    sessionId: "session_id",
    runId: "run_id"
  },
  session_current_state: {
    workspaceId: "workspace_id",
    sessionId: "session_id",
    runId: "latest_run_id"
  },
  tool_calls: {
    runId: "run_id"
  },
  hook_runs: {
    runId: "run_id"
  },
  artifacts: {
    runId: "run_id"
  },
  history_events: {
    workspaceId: "workspace_id"
  },
  archives: {
    workspaceId: "workspace_id"
  }
};

const DEFAULT_POSTGRES_OVERVIEW_COUNT_TTL_MS = 30_000;
const DEFAULT_POSTGRES_DEEP_OFFSET_LIMIT = 10_000;

export function isTruthy(value: string | undefined): boolean {
  return value ? ["1", "true", "yes", "on"].includes(value.trim().toLowerCase()) : false;
}

export function resolvePostgresOverviewCountMode(): "cached" | "exact" | "estimated" | "skip" {
  const raw = process.env.OAH_STORAGE_ADMIN_POSTGRES_OVERVIEW_COUNTS?.trim().toLowerCase();
  return raw === "exact" || raw === "estimated" || raw === "skip" || raw === "cached" ? raw : "cached";
}

export function resolvePostgresOverviewCountTtlMs(): number {
  const raw = process.env.OAH_STORAGE_ADMIN_POSTGRES_OVERVIEW_COUNT_TTL_MS?.trim();
  if (!raw) {
    return DEFAULT_POSTGRES_OVERVIEW_COUNT_TTL_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, 3_600_000) : DEFAULT_POSTGRES_OVERVIEW_COUNT_TTL_MS;
}

export function resolvePostgresDeepOffsetLimit(): number {
  const raw = process.env.OAH_STORAGE_ADMIN_POSTGRES_DEEP_OFFSET_LIMIT?.trim();
  if (!raw) {
    return DEFAULT_POSTGRES_DEEP_OFFSET_LIMIT;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_POSTGRES_DEEP_OFFSET_LIMIT;
}

export function encodePostgresCursor(table: StoragePostgresTableName, values: unknown[]): string {
  return Buffer.from(JSON.stringify({ table, values }), "utf8").toString("base64url");
}

export function decodePostgresCursor(cursor: string | undefined, table: StoragePostgresTableName): unknown[] | undefined {
  const trimmed = cursor?.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const decoded = JSON.parse(Buffer.from(trimmed, "base64url").toString("utf8")) as {
      table?: unknown;
      values?: unknown;
    };
    if (decoded.table !== table || !Array.isArray(decoded.values)) {
      throw new Error("Cursor does not match the requested table.");
    }
    return decoded.values;
  } catch (error) {
    throw new AppError(
      400,
      "invalid_storage_table_cursor",
      error instanceof Error ? error.message : "Invalid storage table cursor."
    );
  }
}

export function buildPostgresKeysetWhere(
  terms: PostgresTableSortTerm[],
  cursorValues: unknown[],
  values: unknown[]
): string | undefined {
  if (cursorValues.length !== terms.length) {
    throw new AppError(400, "invalid_storage_table_cursor", "Storage table cursor shape does not match the table order.");
  }

  const disjunctions: string[] = [];
  for (let index = 0; index < terms.length; index += 1) {
    const term = terms[index]!;
    const equalityParts: string[] = [];
    for (let previousIndex = 0; previousIndex < index; previousIndex += 1) {
      const previousTerm = terms[previousIndex]!;
      const previousValue = cursorValues[previousIndex];
      if (previousValue === null || previousValue === undefined) {
        equalityParts.push(`${previousTerm.expression} is null`);
      } else {
        values.push(previousValue);
        equalityParts.push(`${previousTerm.expression} = $${values.length}`);
      }
    }

    const cursorValue = cursorValues[index];
    if (cursorValue === null || cursorValue === undefined) {
      continue;
    }

    values.push(cursorValue);
    const comparison = `${term.expression} ${term.direction === "desc" ? "<" : ">"} $${values.length}`;
    disjunctions.push([...equalityParts, comparison].join(" and "));
  }

  return disjunctions.length > 0 ? `(${disjunctions.map((clause) => `(${clause})`).join(" or ")})` : undefined;
}
