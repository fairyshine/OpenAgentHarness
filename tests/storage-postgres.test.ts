import { describe, expect, it, vi } from "vitest";

import { createPostgresRuntimePersistence, ensurePostgresSchema } from "@oah/storage-postgres";

describe("storage postgres", () => {
  it("creates all expected schema statements", async () => {
    const query = vi.fn(async () => ({ rows: [] }));

    await ensurePostgresSchema({
      query
    } as unknown as import("pg").Pool);

    const statements = query.mock.calls.map(([statement]) => String(statement));

    expect(statements.some((statement) => statement.includes("create table if not exists workspaces"))).toBe(true);
    expect(statements.some((statement) => statement.includes("create table if not exists sessions"))).toBe(true);
    expect(statements.some((statement) => statement.includes("create table if not exists runs"))).toBe(true);
    expect(statements.some((statement) => statement.includes("parent_run_id"))).toBe(true);
    expect(statements.some((statement) => statement.includes("heartbeat_at"))).toBe(true);
    expect(statements.some((statement) => statement.includes("create table if not exists messages"))).toBe(true);
    expect(statements.some((statement) => statement.includes("create table if not exists run_steps"))).toBe(true);
    expect(statements.some((statement) => statement.includes("create table if not exists tool_calls"))).toBe(true);
    expect(statements.some((statement) => statement.includes("create table if not exists hook_runs"))).toBe(true);
    expect(statements.some((statement) => statement.includes("create table if not exists artifacts"))).toBe(true);
    expect(statements.some((statement) => statement.includes("create table if not exists history_events"))).toBe(true);
    expect(statements.some((statement) => statement.includes("create table if not exists session_events"))).toBe(true);
  });

  it("builds postgres persistence around an injected pool", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const end = vi.fn(async () => undefined);
    const fakePool = {
      query,
      end
    } as unknown as import("pg").Pool;

    const persistence = await createPostgresRuntimePersistence({
      pool: fakePool,
      ensureSchema: false
    });

    expect(persistence.pool).toBe(fakePool);
    expect(typeof persistence.workspaceRepository.create).toBe("function");
    expect(typeof persistence.sessionRepository.create).toBe("function");
    expect(typeof persistence.messageRepository.listBySessionId).toBe("function");
    expect(typeof persistence.runRepository.update).toBe("function");
    expect(typeof persistence.runStepRepository.listByRunId).toBe("function");
    expect(typeof persistence.sessionEventStore.append).toBe("function");
    expect(typeof persistence.toolCallAuditRepository.create).toBe("function");
    expect(typeof persistence.hookRunAuditRepository.create).toBe("function");
    expect(typeof persistence.artifactRepository.create).toBe("function");
    expect(typeof persistence.historyEventRepository.listByWorkspaceId).toBe("function");

    await persistence.close();
    expect(end).not.toHaveBeenCalled();
  });

  it("serializes schema creation with a PostgreSQL advisory lock when connect is available", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const release = vi.fn();
    const connect = vi.fn(async () => ({
      query,
      release
    }));

    await ensurePostgresSchema({
      connect
    } as unknown as import("pg").Pool);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain("pg_advisory_lock");
    expect(query.mock.calls.at(-1)?.[0]).toContain("pg_advisory_unlock");
    expect(release).toHaveBeenCalledTimes(1);
  });
});
