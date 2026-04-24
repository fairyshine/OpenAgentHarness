import { describe, expect, it, vi } from "vitest";

import type {
  ArtifactRecord,
  HookRunAuditRecord,
  Message,
  Run,
  RunStep,
  EngineMessage,
  Session,
  SessionEvent,
  ToolCallAuditRecord,
  WorkspaceArchiveRecord,
  WorkspaceRecord
} from "@oah/engine-core";
import {
  buildServiceDatabaseConnectionString,
  createServiceRoutedPostgresRuntimePersistence
} from "../apps/server/src/bootstrap/service-routed-postgres.ts";

function sortIsoAscending<T extends { createdAt: string; id: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    if (left.createdAt !== right.createdAt) {
      return left.createdAt.localeCompare(right.createdAt);
    }

    return left.id.localeCompare(right.id);
  });
}

function createInMemoryPostgresPersistence(label: string, options?: { supportRoutingRegistry?: boolean | undefined }) {
  const workspaces = new Map<string, WorkspaceRecord>();
  const sessions = new Map<string, Session>();
  const runs = new Map<string, Run>();
  const messages = new Map<string, Message>();
  const engineMessages = new Map<string, EngineMessage[]>();
  const runSteps = new Map<string, RunStep>();
  const sessionEvents = new Map<string, SessionEvent[]>();
  const artifacts = new Map<string, ArtifactRecord>();
  const archives = new Map<string, WorkspaceArchiveRecord>();
  const workspaceRegistry = new Map<string, { serviceName?: string; createdAt: string; updatedAt: string }>();
  const sessionRegistry = new Map<string, Session & { serviceName?: string }>();
  const runRegistry = new Map<string, Run & { serviceName?: string }>();
  let eventSeq = 0;

  const query = vi.fn(async (statement: unknown, values?: unknown[]) => {
    const sql = String(statement).trim().toLowerCase();
    if (!options?.supportRoutingRegistry) {
      return { rows: [] };
    }

    if (sql.startsWith("create table if not exists") || sql.startsWith("create index if not exists")) {
      return { rows: [] };
    }

    if (sql.startsWith("insert into workspace_registry") && sql.includes("select")) {
      for (const workspace of workspaces.values()) {
        workspaceRegistry.set(workspace.id, {
          ...(workspace.serviceName ? { serviceName: workspace.serviceName } : {}),
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt
        });
      }
      return { rows: [] };
    }

    if (sql.startsWith("insert into session_registry") && sql.includes("select")) {
      for (const session of sessions.values()) {
        const workspace = workspaces.get(session.workspaceId);
        sessionRegistry.set(session.id, {
          ...session,
          ...(workspace?.serviceName ? { serviceName: workspace.serviceName } : {})
        });
      }
      return { rows: [] };
    }

    if (sql.startsWith("insert into run_registry") && sql.includes("select")) {
      for (const run of runs.values()) {
        const workspace = workspaces.get(run.workspaceId);
        runRegistry.set(run.id, {
          ...run,
          ...(workspace?.serviceName ? { serviceName: workspace.serviceName } : {})
        });
      }
      return { rows: [] };
    }

    if (sql.startsWith("delete from workspaces where")) {
      for (const [workspaceId, workspace] of [...workspaces.entries()]) {
        if (!workspace.serviceName) {
          continue;
        }

        workspaces.delete(workspaceId);
        for (const [sessionId, session] of [...sessions.entries()]) {
          if (session.workspaceId !== workspaceId) {
            continue;
          }

          sessions.delete(sessionId);
        }
        for (const [runId, run] of [...runs.entries()]) {
          if (run.workspaceId !== workspaceId) {
            continue;
          }

          runs.delete(runId);
        }
      }
      return { rows: [] };
    }

    if (sql.includes("from workspace_registry") && sql.includes("where workspace_id = $1")) {
      const entry = workspaceRegistry.get(String(values?.[0] ?? ""));
      return {
        rows: entry
          ? [
              {
                workspace_id: String(values?.[0] ?? ""),
                service_name: entry.serviceName ?? null,
                created_at: entry.createdAt,
                updated_at: entry.updatedAt
              }
            ]
          : []
      };
    }

    if (sql.includes("from workspace_registry") && sql.includes("order by updated_at desc")) {
      const limit = Number(values?.[0] ?? 50);
      const offset = Number(values?.[1] ?? 0);
      const rows = [...workspaceRegistry.entries()]
        .map(([workspaceId, entry]) => ({
          workspace_id: workspaceId,
          service_name: entry.serviceName ?? null,
          created_at: entry.createdAt,
          updated_at: entry.updatedAt
        }))
        .sort((left, right) => {
          if (left.updated_at !== right.updated_at) {
            return right.updated_at.localeCompare(left.updated_at);
          }
          if (left.created_at !== right.created_at) {
            return right.created_at.localeCompare(left.created_at);
          }
          return left.workspace_id.localeCompare(right.workspace_id);
        })
        .slice(offset, offset + limit);
      return { rows };
    }

    if (sql.startsWith("insert into workspace_registry")) {
      workspaceRegistry.set(String(values?.[0] ?? ""), {
        ...(typeof values?.[1] === "string" ? { serviceName: String(values[1]) } : {}),
        createdAt: String(values?.[2] ?? ""),
        updatedAt: String(values?.[3] ?? "")
      });
      return { rows: [] };
    }

    if (sql.startsWith("delete from workspace_registry")) {
      workspaceRegistry.delete(String(values?.[0] ?? ""));
      return { rows: [] };
    }

    if (sql.startsWith("select distinct service_name")) {
      const rows = [...new Set([...workspaceRegistry.values()].map((entry) => entry.serviceName).filter(Boolean))]
        .sort()
        .map((serviceName) => ({ service_name: serviceName }));
      return { rows };
    }

    if (sql.includes("from session_registry") && sql.includes("where id = $1")) {
      const entry = sessionRegistry.get(String(values?.[0] ?? ""));
      return {
        rows: entry
          ? [
              {
                id: entry.id,
                workspace_id: entry.workspaceId,
                service_name: entry.serviceName ?? null,
                subject_ref: entry.subjectRef,
                model_ref: entry.modelRef ?? null,
                agent_name: entry.agentName ?? null,
                active_agent_name: entry.activeAgentName,
                title: entry.title ?? null,
                status: entry.status,
                last_run_at: entry.lastRunAt ?? null,
                created_at: entry.createdAt,
                updated_at: entry.updatedAt
              }
            ]
          : []
      };
    }

    if (sql.includes("from session_registry") && sql.includes("where workspace_id = $1")) {
      const workspaceId = String(values?.[0] ?? "");
      const limit = Number(values?.[1] ?? 50);
      const offset = Number(values?.[2] ?? 0);
      const rows = [...sessionRegistry.values()]
        .filter((entry) => entry.workspaceId === workspaceId)
        .sort((left, right) => {
          if (left.updatedAt !== right.updatedAt) {
            return right.updatedAt.localeCompare(left.updatedAt);
          }
          if (left.createdAt !== right.createdAt) {
            return right.createdAt.localeCompare(left.createdAt);
          }
          return left.id.localeCompare(right.id);
        })
        .slice(offset, offset + limit)
        .map((entry) => ({
          id: entry.id,
          workspace_id: entry.workspaceId,
          subject_ref: entry.subjectRef,
          model_ref: entry.modelRef ?? null,
          agent_name: entry.agentName ?? null,
          active_agent_name: entry.activeAgentName,
          title: entry.title ?? null,
          status: entry.status,
          last_run_at: entry.lastRunAt ?? null,
          created_at: entry.createdAt,
          updated_at: entry.updatedAt
        }));
      return { rows };
    }

    if (sql.startsWith("insert into session_registry")) {
      sessionRegistry.set(String(values?.[0] ?? ""), {
        id: String(values?.[0] ?? ""),
        workspaceId: String(values?.[1] ?? ""),
        ...(typeof values?.[2] === "string" ? { serviceName: String(values[2]) } : {}),
        subjectRef: String(values?.[3] ?? ""),
        ...(typeof values?.[4] === "string" ? { modelRef: String(values[4]) } : {}),
        ...(typeof values?.[5] === "string" ? { agentName: String(values[5]) } : {}),
        activeAgentName: String(values?.[6] ?? ""),
        ...(typeof values?.[7] === "string" ? { title: String(values[7]) } : {}),
        status: String(values?.[8] ?? "") as Session["status"],
        ...(typeof values?.[9] === "string" ? { lastRunAt: String(values[9]) } : {}),
        createdAt: String(values?.[10] ?? ""),
        updatedAt: String(values?.[11] ?? "")
      });
      return { rows: [] };
    }

    if (sql.startsWith("delete from session_registry")) {
      sessionRegistry.delete(String(values?.[0] ?? ""));
      return { rows: [] };
    }

    if (sql.startsWith("delete from run_registry where session_id")) {
      const sessionId = String(values?.[0] ?? "");
      for (const [runId, run] of [...runRegistry.entries()]) {
        if (run.sessionId === sessionId) {
          runRegistry.delete(runId);
        }
      }
      return { rows: [] };
    }

    if (sql.startsWith("delete from run_registry where workspace_id")) {
      const workspaceId = String(values?.[0] ?? "");
      for (const [runId, run] of [...runRegistry.entries()]) {
        if (run.workspaceId === workspaceId) {
          runRegistry.delete(runId);
        }
      }
      return { rows: [] };
    }

    if (sql.includes("from run_registry") && sql.includes("where id = $1")) {
      const entry = runRegistry.get(String(values?.[0] ?? ""));
      return {
        rows: entry
          ? [
              {
                id: entry.id,
                workspace_id: entry.workspaceId,
                session_id: entry.sessionId ?? null,
                service_name: entry.serviceName ?? null,
                parent_run_id: entry.parentRunId ?? null,
                initiator_ref: entry.initiatorRef ?? null,
                trigger_type: entry.triggerType,
                trigger_ref: entry.triggerRef ?? null,
                agent_name: entry.agentName ?? null,
                effective_agent_name: entry.effectiveAgentName,
                switch_count: entry.switchCount ?? null,
                status: entry.status,
                cancel_requested_at: entry.cancelRequestedAt ?? null,
                started_at: entry.startedAt ?? null,
                heartbeat_at: entry.heartbeatAt ?? null,
                ended_at: entry.endedAt ?? null,
                error_code: entry.errorCode ?? null,
                error_message: entry.errorMessage ?? null,
                metadata: entry.metadata ?? null,
                created_at: entry.createdAt
              }
            ]
          : []
      };
    }

    if (sql.includes("from run_registry") && sql.includes("where session_id = $1")) {
      const sessionId = String(values?.[0] ?? "");
      const rows = [...runRegistry.values()]
        .filter((entry) => entry.sessionId === sessionId)
        .sort((left, right) => {
          if (left.createdAt !== right.createdAt) {
            return right.createdAt.localeCompare(left.createdAt);
          }
          return right.id.localeCompare(left.id);
        })
        .map((entry) => ({
          id: entry.id,
          workspace_id: entry.workspaceId,
          session_id: entry.sessionId ?? null,
          parent_run_id: entry.parentRunId ?? null,
          initiator_ref: entry.initiatorRef ?? null,
          trigger_type: entry.triggerType,
          trigger_ref: entry.triggerRef ?? null,
          agent_name: entry.agentName ?? null,
          effective_agent_name: entry.effectiveAgentName,
          switch_count: entry.switchCount ?? null,
          status: entry.status,
          cancel_requested_at: entry.cancelRequestedAt ?? null,
          started_at: entry.startedAt ?? null,
          heartbeat_at: entry.heartbeatAt ?? null,
          ended_at: entry.endedAt ?? null,
          error_code: entry.errorCode ?? null,
          error_message: entry.errorMessage ?? null,
          metadata: entry.metadata ?? null,
          created_at: entry.createdAt
        }));
      return { rows };
    }

    if (sql.includes("from run_registry") && sql.includes("where status = any")) {
      return { rows: [] };
    }

    if (sql.startsWith("insert into run_registry")) {
      runRegistry.set(String(values?.[0] ?? ""), {
        id: String(values?.[0] ?? ""),
        workspaceId: String(values?.[1] ?? ""),
        ...(typeof values?.[2] === "string" ? { sessionId: String(values[2]) } : {}),
        ...(typeof values?.[3] === "string" ? { serviceName: String(values[3]) } : {}),
        ...(typeof values?.[4] === "string" ? { parentRunId: String(values[4]) } : {}),
        ...(typeof values?.[5] === "string" ? { initiatorRef: String(values[5]) } : {}),
        triggerType: String(values?.[6] ?? "") as Run["triggerType"],
        ...(typeof values?.[7] === "string" ? { triggerRef: String(values[7]) } : {}),
        ...(typeof values?.[8] === "string" ? { agentName: String(values[8]) } : {}),
        effectiveAgentName: String(values?.[9] ?? ""),
        ...(typeof values?.[10] === "number" ? { switchCount: Number(values[10]) } : {}),
        status: String(values?.[11] ?? "") as Run["status"],
        ...(typeof values?.[12] === "string" ? { cancelRequestedAt: String(values[12]) } : {}),
        ...(typeof values?.[13] === "string" ? { startedAt: String(values[13]) } : {}),
        ...(typeof values?.[14] === "string" ? { heartbeatAt: String(values[14]) } : {}),
        ...(typeof values?.[15] === "string" ? { endedAt: String(values[15]) } : {}),
        ...(typeof values?.[16] === "string" ? { errorCode: String(values[16]) } : {}),
        ...(typeof values?.[17] === "string" ? { errorMessage: String(values[17]) } : {}),
        ...(values?.[18] !== null && values?.[18] !== undefined ? { metadata: values[18] as Run["metadata"] } : {}),
        createdAt: String(values?.[19] ?? "")
      });
      return { rows: [] };
    }

    throw new Error(`Unhandled fake query for ${label}: ${String(statement)}`);
  });

  return {
    pool: {
      query,
      end: vi.fn(async () => undefined)
    } as unknown as import("pg").Pool,
    db: {} as never,
    workspaceRepository: {
      async create(input: WorkspaceRecord) {
        workspaces.set(input.id, input);
        return input;
      },
      async upsert(input: WorkspaceRecord) {
        workspaces.set(input.id, input);
        return input;
      },
      async getById(id: string) {
        return workspaces.get(id) ?? null;
      },
      async list(pageSize: number, cursor?: string) {
        const offset = cursor ? Number.parseInt(cursor, 10) : 0;
        return [...workspaces.values()].slice(offset, offset + pageSize);
      },
      async delete(id: string) {
        workspaces.delete(id);
      }
    },
    sessionRepository: {
      async create(input: Session) {
        sessions.set(input.id, input);
        return input;
      },
      async getById(id: string) {
        return sessions.get(id) ?? null;
      },
      async update(input: Session) {
        sessions.set(input.id, input);
        return input;
      },
      async listByWorkspaceId(workspaceId: string, pageSize: number, cursor?: string) {
        const offset = cursor ? Number.parseInt(cursor, 10) : 0;
        return [...sessions.values()].filter((session) => session.workspaceId === workspaceId).slice(offset, offset + pageSize);
      },
      async delete(id: string) {
        sessions.delete(id);
      }
    },
    messageRepository: {
      async create(input: Message) {
        messages.set(input.id, input);
        return input;
      },
      async getById(id: string) {
        return messages.get(id) ?? null;
      },
      async update(input: Message) {
        messages.set(input.id, input);
        return input;
      },
      async listBySessionId(sessionId: string) {
        return sortIsoAscending([...messages.values()].filter((message) => message.sessionId === sessionId));
      }
    },
    engineMessageRepository: {
      async replaceBySessionId(sessionId: string, items: EngineMessage[]) {
        engineMessages.set(sessionId, items);
      },
      async listBySessionId(sessionId: string) {
        return engineMessages.get(sessionId) ?? [];
      }
    },
    runRepository: {
      async create(input: Run) {
        runs.set(input.id, input);
        return input;
      },
      async getById(id: string) {
        return runs.get(id) ?? null;
      },
      async update(input: Run) {
        runs.set(input.id, input);
        return input;
      },
      async listBySessionId(sessionId: string) {
        return [...runs.values()].filter((run) => run.sessionId === sessionId);
      },
      async listRecoverableActiveRuns() {
        return [];
      }
    },
    runStepRepository: {
      async create(input: RunStep) {
        runSteps.set(input.id, input);
        return input;
      },
      async update(input: RunStep) {
        runSteps.set(input.id, input);
        return input;
      },
      async listByRunId(runId: string) {
        return [...runSteps.values()].filter((step) => step.runId === runId);
      }
    },
    sessionEventStore: {
      async append(input: Omit<SessionEvent, "id" | "cursor" | "createdAt">) {
        const created: SessionEvent = {
          ...input,
          id: `${label}-evt-${++eventSeq}`,
          cursor: String(eventSeq),
          createdAt: `2026-01-01T00:00:${String(eventSeq).padStart(2, "0")}.000Z`
        };
        const items = sessionEvents.get(input.sessionId) ?? [];
        items.push(created);
        sessionEvents.set(input.sessionId, items);
        return created;
      },
      async deleteById(eventId: string) {
        for (const [sessionId, items] of sessionEvents.entries()) {
          sessionEvents.set(
            sessionId,
            items.filter((event) => event.id !== eventId)
          );
        }
      },
      async listSince(sessionId: string) {
        return sessionEvents.get(sessionId) ?? [];
      },
      subscribe() {
        return () => undefined;
      }
    },
    toolCallAuditRepository: {
      async create(input: ToolCallAuditRecord) {
        return input;
      }
    },
    hookRunAuditRepository: {
      async create(input: HookRunAuditRecord) {
        return input;
      }
    },
    artifactRepository: {
      async create(input: ArtifactRecord) {
        artifacts.set(input.id, input);
        return input;
      },
      async listByRunId(runId: string) {
        return [...artifacts.values()].filter((artifact) => artifact.runId === runId);
      }
    },
    historyEventRepository: {
      async append(input: Omit<import("@oah/engine-core").HistoryEventRecord, "id">) {
        return {
          id: 1,
          ...input
        };
      },
      async listByWorkspaceId() {
        return [];
      }
    },
    workspaceArchiveRepository: {
      async archiveWorkspace(input: {
        workspace: WorkspaceRecord;
        archiveDate: string;
        archivedAt: string;
        deletedAt: string;
        timezone: string;
      }) {
        const archive: WorkspaceArchiveRecord = {
          id: `${label}-archive-${archives.size + 1}`,
          workspaceId: input.workspace.id,
          scopeType: "workspace",
          scopeId: input.workspace.id,
          archiveDate: input.archiveDate,
          archivedAt: input.archivedAt,
          deletedAt: input.deletedAt,
          timezone: input.timezone,
          workspace: input.workspace,
          sessions: [],
          runs: [],
          messages: [],
          engineMessages: [],
          runSteps: [],
          toolCalls: [],
          hookRuns: [],
          artifacts: []
        };
        archives.set(archive.id, archive);
        return archive;
      },
      async archiveSessionTree(input: {
        workspace: WorkspaceRecord;
        rootSessionId: string;
        sessionIds: string[];
        archiveDate: string;
        archivedAt: string;
        deletedAt: string;
        timezone: string;
      }) {
        const archive: WorkspaceArchiveRecord = {
          id: `${label}-archive-${archives.size + 1}`,
          workspaceId: input.workspace.id,
          scopeType: "session",
          scopeId: input.rootSessionId,
          archiveDate: input.archiveDate,
          archivedAt: input.archivedAt,
          deletedAt: input.deletedAt,
          timezone: input.timezone,
          workspace: input.workspace,
          sessions: [],
          runs: [],
          messages: [],
          engineMessages: [],
          runSteps: [],
          toolCalls: [],
          hookRuns: [],
          artifacts: []
        };
        archives.set(archive.id, archive);
        return archive;
      },
      async listPendingArchiveDates() {
        return [];
      },
      async listByArchiveDate(archiveDate: string) {
        return [...archives.values()].filter((archive) => archive.archiveDate === archiveDate);
      },
      async forEachByArchiveDate(
        archiveDate: string,
        visitor: (archive: WorkspaceArchiveRecord) => Promise<void> | void
      ) {
        const items = [...archives.values()]
          .filter((archive) => archive.archiveDate === archiveDate)
          .sort((left, right) => {
            if (left.archivedAt !== right.archivedAt) {
              return left.archivedAt.localeCompare(right.archivedAt);
            }

            return left.id.localeCompare(right.id);
          });
        for (const archive of items) {
          await visitor(archive);
        }
        return items.length;
      },
      async markExported(ids: string[], input: { exportedAt: string; exportPath: string }) {
        for (const id of ids) {
          const existing = archives.get(id);
          if (!existing) {
            continue;
          }

          archives.set(id, {
            ...existing,
            exportedAt: input.exportedAt,
            exportPath: input.exportPath
          });
        }
      },
      async pruneExportedBefore() {
        return 0;
      }
    },
    close: vi.fn(async () => undefined),
    state: {
      workspaces,
      sessions,
      runs,
      messages,
      workspaceRegistry,
      sessionRegistry,
      runRegistry
    }
  };
}

describe("service routed postgres persistence", () => {
  it("derives a service database name from the base postgres url", () => {
    expect(buildServiceDatabaseConnectionString("postgres://oah:oah@127.0.0.1:5432/OAH?sslmode=disable", "Acme-App")).toBe(
      "postgres://oah:oah@127.0.0.1:5432/OAH-acme-app?sslmode=disable"
    );
  });

  it("dual writes workspace/session/run while routing message detail into the service database", async () => {
    const defaultBackend = createInMemoryPostgresPersistence("default", { supportRoutingRegistry: true });
    const serviceBackend = createInMemoryPostgresPersistence("svc-acme");
    const connectionStrings: string[] = [];

    const persistence = await createServiceRoutedPostgresRuntimePersistence({
      connectionString: "postgres://oah:oah@127.0.0.1:5432/OAH",
      async persistenceFactory(options) {
        connectionStrings.push(options.connectionString ?? "");
        if (options.connectionString === "postgres://oah:oah@127.0.0.1:5432/OAH") {
          return defaultBackend as never;
        }

        if (options.connectionString === "postgres://oah:oah@127.0.0.1:5432/OAH-acme-app") {
          return serviceBackend as never;
        }

        throw new Error(`Unexpected connection string: ${options.connectionString}`);
      }
    });

    const workspace: WorkspaceRecord = {
      id: "ws_service_demo",
      name: "service demo",
      rootPath: "/tmp/ws_service_demo",
      executionPolicy: "local",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: true,
      serviceName: "acme-app",
      settings: {},
      workspaceModels: {},
      agents: {},
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "ws_service_demo",
        actions: [],
        agents: [],
        hooks: [],
        models: [],
        skills: [],
        tools: []
      }
    };
    const session: Session = {
      id: "ses_service_demo",
      workspaceId: workspace.id,
      subjectRef: "dev:test",
      activeAgentName: "assistant",
      status: "active",
      createdAt: "2026-01-01T00:01:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z"
    };
    const run: Run = {
      id: "run_service_demo",
      workspaceId: workspace.id,
      sessionId: session.id,
      triggerType: "message",
      effectiveAgentName: "assistant",
      status: "queued",
      createdAt: "2026-01-01T00:02:00.000Z"
    };
    const message: Message = {
      id: "msg_service_demo",
      sessionId: session.id,
      runId: run.id,
      role: "user",
      content: "hello",
      createdAt: "2026-01-01T00:03:00.000Z"
    };

    await persistence.workspaceRepository.create(workspace);
    await persistence.sessionRepository.create(session);
    await persistence.runRepository.create(run);
    await persistence.messageRepository.create(message);

    expect(connectionStrings).toEqual([
      "postgres://oah:oah@127.0.0.1:5432/OAH",
      "postgres://oah:oah@127.0.0.1:5432/OAH-acme-app"
    ]);
    expect(defaultBackend.state.workspaces.get(workspace.id)).toBeUndefined();
    expect(serviceBackend.state.workspaces.get(workspace.id)?.serviceName).toBe("acme-app");
    expect(defaultBackend.state.workspaceRegistry.get(workspace.id)?.serviceName).toBe("acme-app");
    expect(defaultBackend.state.sessions.get(session.id)).toBeUndefined();
    expect(serviceBackend.state.sessions.get(session.id)?.workspaceId).toBe(workspace.id);
    expect(defaultBackend.state.sessionRegistry.get(session.id)?.serviceName).toBe("acme-app");
    expect(defaultBackend.state.runs.get(run.id)).toBeUndefined();
    expect(serviceBackend.state.runs.get(run.id)?.workspaceId).toBe(workspace.id);
    expect(defaultBackend.state.runRegistry.get(run.id)?.serviceName).toBe("acme-app");
    expect(defaultBackend.state.messages.has(message.id)).toBe(false);
    expect(serviceBackend.state.messages.get(message.id)?.sessionId).toBe(session.id);
    await expect(persistence.messageRepository.listBySessionId(session.id)).resolves.toEqual([message]);
    await expect(persistence.messageRepository.getById(message.id)).resolves.toEqual(message);

    await persistence.close();
  });

  it("normalizes registry timestamps into ISO strings when listing sessions", async () => {
    const defaultBackend = createInMemoryPostgresPersistence("default", { supportRoutingRegistry: true });

    const persistence = await createServiceRoutedPostgresRuntimePersistence({
      connectionString: "postgres://oah:oah@127.0.0.1:5432/OAH",
      async persistenceFactory(options) {
        if (options.connectionString === "postgres://oah:oah@127.0.0.1:5432/OAH") {
          return defaultBackend as never;
        }

        throw new Error(`Unexpected connection string: ${options.connectionString}`);
      }
    });

    const workspace: WorkspaceRecord = {
      id: "ws_registry_time_demo",
      name: "registry time demo",
      rootPath: "/tmp/ws_registry_time_demo",
      executionPolicy: "local",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: true,
      settings: {},
      workspaceModels: {},
      agents: {},
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "ws_registry_time_demo",
        actions: [],
        agents: [],
        hooks: [],
        models: [],
        skills: [],
        tools: []
      }
    };
    const session: Session = {
      id: "ses_registry_time_demo",
      workspaceId: workspace.id,
      subjectRef: "dev:test",
      activeAgentName: "assistant",
      status: "active",
      createdAt: "2026-01-01T00:01:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z"
    };

    await persistence.workspaceRepository.create(workspace);
    await persistence.sessionRepository.create(session);

    defaultBackend.state.sessionRegistry.set(session.id, {
      ...session,
      createdAt: "2026-01-01 00:01:00+00",
      updatedAt: "2026-01-01 00:02:00+00",
      lastRunAt: "2026-01-01 00:03:00+00"
    });

    await expect(persistence.sessionRepository.getById(session.id)).resolves.toMatchObject({
      id: session.id,
      createdAt: "2026-01-01T00:01:00.000Z",
      updatedAt: "2026-01-01T00:02:00.000Z",
      lastRunAt: "2026-01-01T00:03:00.000Z"
    });
    await expect(persistence.sessionRepository.listByWorkspaceId(workspace.id, 10)).resolves.toEqual([
      expect.objectContaining({
        id: session.id,
        createdAt: "2026-01-01T00:01:00.000Z",
        updatedAt: "2026-01-01T00:02:00.000Z",
        lastRunAt: "2026-01-01T00:03:00.000Z"
      })
    ]);

    await persistence.close();
  });

  it("iterates archives across routed backends when per-archive iteration is available", async () => {
    const defaultBackend = createInMemoryPostgresPersistence("default", { supportRoutingRegistry: true });
    const serviceBackend = createInMemoryPostgresPersistence("svc-acme");

    const persistence = await createServiceRoutedPostgresRuntimePersistence({
      connectionString: "postgres://oah:oah@127.0.0.1:5432/OAH",
      async persistenceFactory(options) {
        if (options.connectionString === "postgres://oah:oah@127.0.0.1:5432/OAH") {
          return defaultBackend as never;
        }

        if (options.connectionString === "postgres://oah:oah@127.0.0.1:5432/OAH-acme-app") {
          return serviceBackend as never;
        }

        throw new Error(`Unexpected connection string: ${options.connectionString}`);
      }
    });

    const defaultWorkspace: WorkspaceRecord = {
      id: "ws_archive_default",
      name: "archive default",
      rootPath: "/tmp/ws_archive_default",
      executionPolicy: "local",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: true,
      settings: {},
      workspaceModels: {},
      agents: {},
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "ws_archive_default",
        actions: [],
        agents: [],
        hooks: [],
        models: [],
        skills: [],
        tools: []
      }
    };
    const serviceWorkspace: WorkspaceRecord = {
      ...defaultWorkspace,
      id: "ws_archive_service",
      name: "archive service",
      rootPath: "/tmp/ws_archive_service",
      serviceName: "acme-app",
      catalog: {
        workspaceId: "ws_archive_service",
        actions: [],
        agents: [],
        hooks: [],
        models: [],
        skills: [],
        tools: []
      }
    };

    await persistence.workspaceRepository.create(serviceWorkspace);

    const archiveA = await persistence.workspaceArchiveRepository.archiveWorkspace({
      workspace: defaultWorkspace,
      archiveDate: "2026-04-08",
      archivedAt: "2026-04-08T10:00:00.000Z",
      deletedAt: "2026-04-08T10:00:00.000Z",
      timezone: "UTC"
    });
    const archiveB = await persistence.workspaceArchiveRepository.archiveWorkspace({
      workspace: serviceWorkspace,
      archiveDate: "2026-04-08",
      archivedAt: "2026-04-08T11:00:00.000Z",
      deletedAt: "2026-04-08T11:00:00.000Z",
      timezone: "UTC"
    });

    const visited: string[] = [];
    const count = await persistence.workspaceArchiveRepository.forEachByArchiveDate?.("2026-04-08", async (archive) => {
      visited.push(archive.id);
    });

    expect(count).toBe(2);
    expect(visited).toEqual([archiveA.id, archiveB.id]);

    await persistence.close();
  });
});
