import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { HistoryEventRecord } from "@oah/runtime-core";
import { createMemoryRuntimePersistence } from "@oah/storage-memory";

import { HistoryMirrorSyncer, historyMirrorDbPath, inspectHistoryMirrorStatus } from "../apps/server/src/history-mirror.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0, tempRoots.length).map((target) =>
      rm(target, {
        recursive: true,
        force: true
      })
    )
  );
});

describe("history mirror syncer", () => {
  it("replays workspace history events into the local history.db mirror", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "oah-history-mirror-"));
    tempRoots.push(workspaceRoot);

    const persistence = createMemoryRuntimePersistence();
    await persistence.workspaceRepository.upsert({
      id: "ws_history_enabled",
      name: "history-enabled",
      rootPath: workspaceRoot,
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: true,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        historyMirrorEnabled: true,
        skillDirs: []
      },
      workspaceModels: {},
      agents: {},
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "ws_history_enabled",
        agents: [],
        models: [],
        actions: [],
        skills: [],
        mcp: [],
        hooks: [],
        nativeTools: []
      }
    });

    const events: HistoryEventRecord[] = [
      {
        id: 1,
        workspaceId: "ws_history_enabled",
        entityType: "session",
        entityId: "ses_1",
        op: "upsert",
        payload: {
          id: "ses_1",
          workspaceId: "ws_history_enabled",
          subjectRef: "dev:test",
          activeAgentName: "builder",
          status: "active",
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z"
        },
        occurredAt: "2026-04-01T00:00:00.000Z"
      },
      {
        id: 2,
        workspaceId: "ws_history_enabled",
        entityType: "run",
        entityId: "run_1",
        op: "upsert",
        payload: {
          id: "run_1",
          workspaceId: "ws_history_enabled",
          sessionId: "ses_1",
          triggerType: "message",
          effectiveAgentName: "builder",
          status: "completed",
          createdAt: "2026-04-01T00:00:01.000Z"
        },
        occurredAt: "2026-04-01T00:00:01.000Z"
      },
      {
        id: 3,
        workspaceId: "ws_history_enabled",
        entityType: "message",
        entityId: "msg_1",
        op: "upsert",
        payload: {
          id: "msg_1",
          sessionId: "ses_1",
          runId: "run_1",
          role: "user",
          content: "hello mirror",
          metadata: {
            source: "test"
          },
          createdAt: "2026-04-01T00:00:02.000Z"
        },
        occurredAt: "2026-04-01T00:00:02.000Z"
      },
      {
        id: 4,
        workspaceId: "ws_history_enabled",
        entityType: "tool_call",
        entityId: "tool_1",
        op: "upsert",
        payload: {
          id: "tool_1",
          runId: "run_1",
          sourceType: "action",
          toolName: "run_action",
          request: {
            input: {
              name: "debug.echo"
            }
          },
          response: {
            output: {
              value: "ok"
            }
          },
          status: "completed",
          startedAt: "2026-04-01T00:00:03.000Z",
          endedAt: "2026-04-01T00:00:04.000Z"
        },
        occurredAt: "2026-04-01T00:00:04.000Z"
      },
      {
        id: 5,
        workspaceId: "ws_history_enabled",
        entityType: "artifact",
        entityId: "art_1",
        op: "upsert",
        payload: {
          id: "art_1",
          runId: "run_1",
          type: "file",
          path: "output/report.txt",
          metadata: {
            size: 10
          },
          createdAt: "2026-04-01T00:00:05.000Z"
        },
        occurredAt: "2026-04-01T00:00:05.000Z"
      },
      {
        id: 6,
        workspaceId: "ws_history_enabled",
        entityType: "message",
        entityId: "msg_1",
        op: "delete",
        payload: {},
        occurredAt: "2026-04-01T00:00:06.000Z"
      }
    ];

    const syncer = new HistoryMirrorSyncer({
      workspaceRepository: persistence.workspaceRepository,
      historyEventRepository: {
        async append() {
          throw new Error("append should not be called in sync tests");
        },
        async listByWorkspaceId(workspaceId, limit, afterId) {
          return events
            .filter((event) => event.workspaceId === workspaceId && (afterId === undefined || event.id > afterId))
            .slice(0, limit);
        }
      },
      batchSize: 2
    });

    await syncer.syncOnce();
    await syncer.close();

    const db = new DatabaseSync(historyMirrorDbPath(workspaceRoot));
    const sessionRow = db.prepare("select workspace_id as workspaceId, subject_ref as subjectRef from sessions where id = ?").get(
      "ses_1"
    ) as { workspaceId: string; subjectRef: string } | undefined;
    const runRow = db.prepare("select effective_agent_name as effectiveAgentName, status from runs where id = ?").get("run_1") as
      | { effectiveAgentName: string; status: string }
      | undefined;
    const messageCount = db.prepare("select count(*) as count from messages").get() as { count: number };
    const toolCallRow = db
      .prepare("select source_type as sourceType, request, response from tool_calls where id = ?")
      .get("tool_1") as { sourceType: string; request: string; response: string } | undefined;
    const artifactRow = db.prepare("select path, metadata from artifacts where id = ?").get("art_1") as
      | { path: string; metadata: string }
      | undefined;
    const mirrorState = db
      .prepare("select last_event_id as lastEventId, status, error_message as errorMessage from mirror_state where workspace_id = ?")
      .get("ws_history_enabled") as { lastEventId: number; status: string; errorMessage: string | null } | undefined;
    db.close();

    expect(sessionRow).toEqual({
      workspaceId: "ws_history_enabled",
      subjectRef: "dev:test"
    });
    expect(runRow).toEqual({
      effectiveAgentName: "builder",
      status: "completed"
    });
    expect(messageCount.count).toBe(0);
    expect(toolCallRow?.sourceType).toBe("action");
    expect(toolCallRow?.request).toContain("\"debug.echo\"");
    expect(toolCallRow?.response).toContain("\"ok\"");
    expect(artifactRow?.path).toBe("output/report.txt");
    expect(artifactRow?.metadata).toContain("\"size\":10");
    expect(mirrorState).toEqual({
      lastEventId: 6,
      status: "idle",
      errorMessage: null
    });
  });

  it("reports local mirror state for an enabled workspace", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "oah-history-mirror-status-"));
    tempRoots.push(workspaceRoot);

    const persistence = createMemoryRuntimePersistence();
    const workspace = await persistence.workspaceRepository.upsert({
      id: "ws_history_status",
      name: "history-status",
      rootPath: workspaceRoot,
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: true,
      settings: {
        historyMirrorEnabled: true,
        skillDirs: []
      },
      workspaceModels: {},
      agents: {},
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "ws_history_status",
        agents: [],
        models: [],
        actions: [],
        skills: [],
        mcp: [],
        hooks: [],
        nativeTools: []
      }
    });

    const syncer = new HistoryMirrorSyncer({
      workspaceRepository: persistence.workspaceRepository,
      historyEventRepository: {
        async append() {
          throw new Error("append should not be called in sync tests");
        },
        async listByWorkspaceId() {
          return [
            {
              id: 1,
              workspaceId: "ws_history_status",
              entityType: "session",
              entityId: "ses_status",
              op: "upsert",
              payload: {
                id: "ses_status",
                workspaceId: "ws_history_status",
                subjectRef: "dev:test",
                activeAgentName: "default",
                status: "active",
                createdAt: "2026-04-01T00:00:00.000Z",
                updatedAt: "2026-04-01T00:00:00.000Z"
              },
              occurredAt: "2026-04-01T00:00:00.000Z"
            }
          ];
        }
      }
    });

    await syncer.syncOnce();
    await syncer.close();

    const status = await inspectHistoryMirrorStatus(workspace);
    expect(status).toMatchObject({
      workspaceId: "ws_history_status",
      supported: true,
      enabled: true,
      state: "idle",
      lastEventId: 1
    });
    expect(status.lastSyncedAt).toBeTruthy();
    expect(status.dbPath).toBe(historyMirrorDbPath(workspaceRoot));
  });

  it("skips chat workspaces and disabled mirrors", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "oah-history-mirror-skip-"));
    tempRoots.push(workspaceRoot);

    const persistence = createMemoryRuntimePersistence();
    await persistence.workspaceRepository.upsert({
      id: "ws_history_disabled",
      name: "history-disabled",
      rootPath: workspaceRoot,
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "chat",
      readOnly: true,
      historyMirrorEnabled: false,
      settings: {
        historyMirrorEnabled: false,
        skillDirs: []
      },
      workspaceModels: {},
      agents: {},
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "ws_history_disabled",
        agents: [],
        models: [],
        actions: [],
        skills: [],
        mcp: [],
        hooks: [],
        nativeTools: []
      }
    });

    const syncer = new HistoryMirrorSyncer({
      workspaceRepository: persistence.workspaceRepository,
      historyEventRepository: {
        async append() {
          throw new Error("append should not be called in sync tests");
        },
        async listByWorkspaceId() {
          return [];
        }
      }
    });

    await syncer.syncOnce();
    await syncer.close();

    await expect(access(historyMirrorDbPath(workspaceRoot))).rejects.toBeDefined();
  });

  it("rebuilds a corrupted local history.db mirror from central history events", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "oah-history-mirror-rebuild-"));
    tempRoots.push(workspaceRoot);

    const persistence = createMemoryRuntimePersistence();
    const workspace = await persistence.workspaceRepository.upsert({
      id: "ws_history_rebuild",
      name: "history-rebuild",
      rootPath: workspaceRoot,
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: true,
      settings: {
        historyMirrorEnabled: true,
        skillDirs: []
      },
      workspaceModels: {},
      agents: {},
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "ws_history_rebuild",
        agents: [],
        models: [],
        actions: [],
        skills: [],
        mcp: [],
        hooks: [],
        nativeTools: []
      }
    });

    const dbPath = historyMirrorDbPath(workspaceRoot);
    await mkdir(path.dirname(dbPath), { recursive: true });
    await writeFile(dbPath, "not-a-sqlite-database", "utf8");

    const syncer = new HistoryMirrorSyncer({
      workspaceRepository: persistence.workspaceRepository,
      historyEventRepository: {
        async append() {
          throw new Error("append should not be called in sync tests");
        },
        async listByWorkspaceId(workspaceId, limit, afterId) {
          return [
            {
              id: 1,
              workspaceId,
              entityType: "session",
              entityId: "ses_rebuilt",
              op: "upsert",
              payload: {
                id: "ses_rebuilt",
                workspaceId,
                subjectRef: "dev:test",
                activeAgentName: "builder",
                status: "active",
                createdAt: "2026-04-01T00:00:00.000Z",
                updatedAt: "2026-04-01T00:00:00.000Z"
              },
              occurredAt: "2026-04-01T00:00:00.000Z"
            }
          ].filter((event) => afterId === undefined || event.id > afterId).slice(0, limit);
        }
      }
    });

    const status = await syncer.rebuildWorkspace(workspace);
    await syncer.close();

    const db = new DatabaseSync(dbPath);
    const sessionRow = db.prepare("select id, subject_ref as subjectRef from sessions where id = ?").get("ses_rebuilt") as
      | { id: string; subjectRef: string }
      | undefined;
    db.close();

    expect(status).toMatchObject({
      workspaceId: "ws_history_rebuild",
      enabled: true,
      state: "idle",
      lastEventId: 1
    });
    expect(sessionRow).toEqual({
      id: "ses_rebuilt",
      subjectRef: "dev:test"
    });
  });
});
