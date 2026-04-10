import { describe, expect, it, vi } from "vitest";

import { createPostgresRuntimePersistence, ensurePostgresSchema } from "@oah/storage-postgres";

function sqlText(statement: unknown): string {
  if (typeof statement === "string") {
    return statement;
  }

  if (statement && typeof statement === "object" && "text" in statement) {
    const text = (statement as { text?: unknown }).text;
    return typeof text === "string" ? text : String(statement);
  }

  return String(statement);
}

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

  it("serializes session event appends per session with a row lock", async () => {
    const query = vi.fn(async (statement: unknown) => {
      const text = sqlText(statement).toLowerCase();

      if (text.includes("for update")) {
        return {
          rows: [{ id: "ses_1" }]
        };
      }

      if (text.includes("coalesce(max(")) {
        return {
          rows: [{ maxCursor: 0 }]
        };
      }

      return { rows: [] };
    });
    const release = vi.fn();
    const connect = vi.fn(async () => ({
      query,
      release
    }));

    const persistence = await createPostgresRuntimePersistence({
      pool: {
        connect,
        query,
        end: vi.fn(async () => undefined)
      } as unknown as import("pg").Pool,
      ensureSchema: false
    });

    await expect(
      persistence.sessionEventStore.append({
        sessionId: "ses_1",
        runId: "run_1",
        event: "message.delta",
        data: {
          runId: "run_1",
          messageId: "msg_1",
          delta: "test"
        }
      })
    ).rejects.toThrow();
    expect(query.mock.calls.some(([statement]) => sqlText(statement).toLowerCase().includes("for update"))).toBe(true);
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

  it("reads workspace runtime messages without building a full workspace snapshot", async () => {
    const fakePool = {
      query: vi.fn(async () => ({ rows: [] })),
      end: vi.fn(async () => undefined)
    } as unknown as import("pg").Pool;

    const persistence = await createPostgresRuntimePersistence({
      pool: fakePool,
      ensureSchema: false
    });

    const orderBy = vi.fn(async () => [
      {
        id: "rtm_1",
        sessionId: "ses_1",
        runId: "run_1",
        role: "assistant",
        kind: "assistant_text",
        content: "hello",
        metadata: null,
        createdAt: "2026-04-01T00:00:00.000Z"
      }
    ]);
    const where = vi.fn(() => ({
      orderBy
    }));
    const from = vi.fn(() => ({
      where
    }));
    const select = vi.fn(() => ({
      from
    }));
    (persistence.db.select as unknown as typeof select) = select;
    const snapshotSpy = vi
      .spyOn(persistence.historyMirrorSnapshotSource, "readWorkspaceSnapshot")
      .mockRejectedValue(new Error("snapshot should not be read"));

    await expect(persistence.historyMirrorSnapshotSource.readWorkspaceRuntimeMessages("ws_1")).resolves.toEqual([
      {
        id: "rtm_1",
        sessionId: "ses_1",
        runId: "run_1",
        role: "assistant",
        kind: "assistant_text",
        content: "hello",
        createdAt: "2026-04-01T00:00:00.000Z"
      }
    ]);

    expect(select).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledTimes(1);
    expect(where).toHaveBeenCalledTimes(1);
    expect(orderBy).toHaveBeenCalledTimes(1);
    expect(snapshotSpy).not.toHaveBeenCalled();

    await persistence.close();
  });

  it("prunes exported archive metadata in bounded batches", async () => {
    const fakePool = {
      query: vi.fn(async () => ({ rows: [] })),
      end: vi.fn(async () => undefined)
    } as unknown as import("pg").Pool;

    const persistence = await createPostgresRuntimePersistence({
      pool: fakePool,
      ensureSchema: false
    });

    const limit = vi.fn(async () => [{ id: "warc_1" }, { id: "warc_2" }]);
    const orderBy = vi.fn(() => ({ limit }));
    const whereSelect = vi.fn(() => ({ orderBy }));
    const from = vi.fn(() => ({ where: whereSelect }));
    const select = vi.fn(() => ({ from }));

    const returning = vi.fn(async () => [{ id: "warc_1" }, { id: "warc_2" }]);
    const whereDelete = vi.fn(() => ({ returning }));
    const del = vi.fn(() => ({ where: whereDelete }));

    (persistence.db.select as unknown as typeof select) = select;
    (persistence.db.delete as unknown as typeof del) = del;

    await expect(persistence.workspaceArchiveRepository.pruneExportedBefore("2026-03-01", 20)).resolves.toBe(2);
    expect(select).toHaveBeenCalledTimes(1);
    expect(limit).toHaveBeenCalledWith(20);
    expect(del).toHaveBeenCalledTimes(1);
    expect(whereDelete).toHaveBeenCalledTimes(1);
    expect(returning).toHaveBeenCalledTimes(1);

    await persistence.close();
  });

  it("normalizes persisted legacy payloads while ensuring schema", async () => {
    const query = vi.fn(async (statement: unknown) => {
      const sql = String(statement);

      if (sql.startsWith("select id, session_id, run_id, role, content, metadata, created_at from messages")) {
        return {
          rows: [
            {
              id: "msg_user_1",
              session_id: "ses_dirty",
              run_id: "run_dirty",
              role: "user",
              content: "run the tools",
              metadata: null,
              created_at: "2026-01-01T00:00:02.000Z"
            },
            {
              id: "msg_assistant_1",
              session_id: "ses_dirty",
              run_id: "run_dirty",
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolCallId: "call_missing",
                  toolName: "Read",
                  input: { file_path: "README.md" }
                },
                {
                  type: "tool-call",
                  toolCallId: "call_done",
                  toolName: "Bash",
                  input: { command: "pwd" }
                }
              ],
              metadata: null,
              created_at: "2026-01-01T00:00:03.000Z"
            },
            {
              id: "msg_tool_1",
              session_id: "ses_dirty",
              run_id: "run_dirty",
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: "call_done",
                  toolName: "Bash",
                  output: "/tmp/demo"
                }
              ],
              metadata: null,
              created_at: "2026-01-01T00:00:04.000Z"
            },
            {
              id: "msg_user_2",
              session_id: "ses_dirty",
              run_id: "run_dirty",
              role: "user",
              content: "thanks",
              metadata: null,
              created_at: "2026-01-01T00:00:05.000Z"
            }
          ]
        };
      }

      if (sql.startsWith("select id, run_id, seq, step_type, name, agent_name, status, input, output, started_at, ended_at from run_steps")) {
        return {
          rows: [
            {
              id: "step_dirty",
              run_id: "run_dirty",
              seq: 1,
              step_type: "model_call",
              name: null,
              agent_name: null,
              status: "completed",
              input: {
                model: "openai-default",
                canonicalModelRef: "platform/openai-default",
                messages: [
                  {
                    role: "tool",
                    content: [
                      {
                        type: "tool-result",
                        toolCallId: "call_done",
                        toolName: "Bash",
                        output: "/tmp/demo"
                      }
                    ]
                  }
                ],
                messageCount: 1
              },
              output: {
                finishReason: "tool-calls",
                toolResults: [
                  {
                    toolCallId: "call_done",
                    toolName: "Bash",
                    output: "/tmp/demo"
                  }
                ],
                toolCallsCount: 1,
                toolResultsCount: 1,
                toolErrorsCount: 1
              },
              started_at: "2026-01-01T00:00:03.000Z",
              ended_at: "2026-01-01T00:00:04.000Z"
            }
          ]
        };
      }

      if (sql.startsWith("select id, entity_type, payload from history_events")) {
        return {
          rows: [
            {
              id: 1,
              entity_type: "message",
              payload: {
                id: "msg_tool_1",
                sessionId: "ses_dirty",
                runId: "run_dirty",
                role: "tool",
                content: [
                  {
                    type: "tool-result",
                    toolCallId: "call_done",
                    toolName: "Bash",
                    output: "/tmp/demo"
                  }
                ],
                createdAt: "2026-01-01T00:00:04.000Z"
              }
            }
          ]
        };
      }

      return { rows: [] };
    });

    await ensurePostgresSchema({
      query
    } as unknown as import("pg").Pool);

    expect(
      query.mock.calls.some(
        ([statement, values]) =>
          String(statement) === "delete from messages where session_id = $1" && Array.isArray(values) && values[0] === "ses_dirty"
      )
    ).toBe(true);
    expect(
      query.mock.calls.some(
        ([statement, values]) =>
          String(statement).startsWith("insert into messages") &&
          Array.isArray(values) &&
          values[0] === "msg_assistant_1~missing-tool-result"
      )
    ).toBe(true);
    expect(
      query.mock.calls.some(
        ([statement, values]) =>
          String(statement) === "update run_steps set input = $2::jsonb, output = $3::jsonb where id = $1" &&
          Array.isArray(values) &&
          values[0] === "step_dirty" &&
          typeof values[1] === "object" &&
          values[1] !== null &&
          "request" in (values[1] as Record<string, unknown>) &&
          typeof values[2] === "object" &&
          values[2] !== null &&
          "response" in (values[2] as Record<string, unknown>) &&
          typeof (values[2] as Record<string, unknown>).runtime === "object" &&
          (values[2] as { runtime?: { toolErrorsCount?: unknown } }).runtime?.toolErrorsCount === 1
      )
    ).toBe(true);
    expect(
      query.mock.calls.some(
        ([statement, values]) =>
          String(statement) === "update history_events set payload = $2::jsonb where id = $1" &&
          Array.isArray(values) &&
          values[0] === 1
      )
    ).toBe(true);
  });
});
