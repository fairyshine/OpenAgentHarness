import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { HistoryEventRecord } from "@oah/runtime-core";
import { createMemoryRuntimePersistence } from "@oah/storage-memory";

import {
  HistoryEventCleaner,
  HistoryMirrorSyncer,
  historyMirrorDbPath,
  inspectHistoryMirrorStatus
} from "../apps/server/src/history-mirror.ts";

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
        tools: [],
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
    const workspaceRow = db.prepare("select name, root_path as rootPath from workspaces where id = ?").get("ws_history_enabled") as
      | { name: string; rootPath: string }
      | undefined;
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

    expect(workspaceRow).toEqual({
      name: "history-enabled",
      rootPath: workspaceRoot
    });
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
        tools: [],
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
        tools: [],
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

  it("reports disabled state for project workspaces with history mirror turned off", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "oah-history-mirror-disabled-"));
    tempRoots.push(workspaceRoot);

    const workspace = {
      id: "ws_history_disabled_project",
      name: "history-disabled-project",
      rootPath: workspaceRoot,
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project" as const,
      readOnly: false,
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
        workspaceId: "ws_history_disabled_project",
        agents: [],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    };

    await expect(inspectHistoryMirrorStatus(workspace)).resolves.toMatchObject({
      workspaceId: "ws_history_disabled_project",
      supported: true,
      enabled: false,
      state: "disabled",
      dbPath: historyMirrorDbPath(workspaceRoot)
    });

    const persistence = createMemoryRuntimePersistence();
    await persistence.workspaceRepository.upsert(workspace);
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

    await expect(syncer.rebuildWorkspace(workspace)).resolves.toMatchObject({
      workspaceId: "ws_history_disabled_project",
      supported: true,
      enabled: false,
      state: "disabled"
    });
    await syncer.close();

    await expect(access(historyMirrorDbPath(workspaceRoot))).rejects.toBeDefined();
  });

  it("skips workspaces whose root path is unavailable on this machine", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "oah-history-mirror-bad-root-"));
    tempRoots.push(tempRoot);

    const blockingFile = path.join(tempRoot, "not-a-directory");
    await writeFile(blockingFile, "block", "utf8");

    const persistence = createMemoryRuntimePersistence();
    await persistence.workspaceRepository.upsert({
      id: "ws_history_unopenable",
      name: "history-unopenable",
      rootPath: path.join(blockingFile, "workspace"),
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
        workspaceId: "ws_history_unopenable",
        agents: [],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    const warnings: string[] = [];
    const syncer = new HistoryMirrorSyncer({
      workspaceRepository: persistence.workspaceRepository,
      historyEventRepository: {
        async append() {
          throw new Error("append should not be called in sync tests");
        },
        async listByWorkspaceId() {
          return [];
        }
      },
      logger: {
        warn(message) {
          warnings.push(message);
        }
      }
    });

    await expect(syncer.syncOnce()).resolves.toBeUndefined();
    await expect(syncer.syncOnce()).resolves.toBeUndefined();
    await syncer.close();

    expect(warnings).toEqual([
      `History mirror skipped for workspace ws_history_unopenable; root path is unavailable on this machine: ${path.join(blockingFile, "workspace")}`
    ]);
  });

  it("syncs workspace pages with bounded concurrency", async () => {
    const workspaceRootA = await mkdtemp(path.join(tmpdir(), "oah-history-concurrency-a-"));
    const workspaceRootB = await mkdtemp(path.join(tmpdir(), "oah-history-concurrency-b-"));
    tempRoots.push(workspaceRootA, workspaceRootB);

    const persistence = createMemoryRuntimePersistence();
    await persistence.workspaceRepository.upsert({
      id: "ws_history_concurrency_a",
      name: "history-concurrency-a",
      rootPath: workspaceRootA,
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
        workspaceId: "ws_history_concurrency_a",
        agents: [],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });
    await persistence.workspaceRepository.upsert({
      id: "ws_history_concurrency_b",
      name: "history-concurrency-b",
      rootPath: workspaceRootB,
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
        workspaceId: "ws_history_concurrency_b",
        agents: [],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    const startedWorkspaceIds: string[] = [];
    let releaseBlockedReads: (() => void) | undefined;
    const blockedReads = new Promise<void>((resolve) => {
      releaseBlockedReads = resolve;
    });
    const syncer = new HistoryMirrorSyncer({
      workspaceRepository: persistence.workspaceRepository,
      historyEventRepository: {
        async append() {
          throw new Error("append should not be called in sync tests");
        },
        async listByWorkspaceId(workspaceId) {
          startedWorkspaceIds.push(workspaceId);
          await blockedReads;
          return [];
        }
      },
      maxConcurrentWorkspaces: 2
    });

    const syncPromise = syncer.syncOnce();
    await expect
      .poll(() => startedWorkspaceIds.length, {
        timeout: 1_000
      })
      .toBe(2);
    releaseBlockedReads?.();
    await syncPromise;
    await syncer.close();

    expect(startedWorkspaceIds).toEqual(expect.arrayContaining(["ws_history_concurrency_a", "ws_history_concurrency_b"]));
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
        tools: [],
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

  it("rebuilds a corrupted local history.db mirror from a primary snapshot before replaying tail history events", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "oah-history-mirror-snapshot-"));
    tempRoots.push(workspaceRoot);

    const persistence = createMemoryRuntimePersistence();
    const workspace = await persistence.workspaceRepository.upsert({
      id: "ws_history_snapshot",
      name: "history-snapshot",
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
        workspaceId: "ws_history_snapshot",
        agents: [],
        models: [],
        actions: [],
        skills: [],
        tools: [],
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
              id: 5,
              workspaceId,
              entityType: "message",
              entityId: "msg_tail",
              op: "upsert",
              payload: {
                id: "msg_tail",
                sessionId: "ses_snap",
                runId: "run_snap",
                role: "assistant",
                content: "tail event",
                createdAt: "2026-04-01T00:00:02.000Z"
              },
              occurredAt: "2026-04-01T00:00:02.000Z"
            }
          ].filter((event) => afterId === undefined || event.id > afterId).slice(0, limit);
        }
      },
      snapshotSource: {
        async readWorkspaceSnapshot(workspaceId) {
          return {
            watermarkEventId: 4,
            sessions: [
              {
                id: "ses_snap",
                workspaceId,
                subjectRef: "dev:test",
                activeAgentName: "builder",
                status: "active",
                createdAt: "2026-04-01T00:00:00.000Z",
                updatedAt: "2026-04-01T00:00:00.000Z"
              }
            ],
            messages: [],
            runtimeMessages: [
              {
                id: "rtm_snap",
                sessionId: "ses_snap",
                runId: "run_snap",
                role: "assistant",
                kind: "tool-call",
                content: [{ type: "tool-call", toolCallId: "call_1", toolName: "Read", input: { path: "README.md" } }],
                createdAt: "2026-04-01T00:00:01.500Z"
              }
            ],
            runs: [
              {
                id: "run_snap",
                workspaceId,
                sessionId: "ses_snap",
                triggerType: "message",
                effectiveAgentName: "builder",
                status: "completed",
                createdAt: "2026-04-01T00:00:01.000Z"
              }
            ],
            runSteps: [],
            toolCalls: [],
            hookRuns: [],
            artifacts: []
          };
        },
        async readWorkspaceRuntimeMessages() {
          return [
            {
              id: "rtm_snap",
              sessionId: "ses_snap",
              runId: "run_snap",
              role: "assistant",
              kind: "tool-call",
              content: [{ type: "tool-call", toolCallId: "call_1", toolName: "Read", input: { path: "README.md" } }],
              createdAt: "2026-04-01T00:00:01.500Z"
            }
          ];
        }
      }
    });

    const status = await syncer.rebuildWorkspace(workspace);
    await syncer.close();

    const db = new DatabaseSync(dbPath);
    const sessionRow = db
      .prepare("select id, subject_ref as subjectRef from sessions where id = ?")
      .get("ses_snap") as { id: string; subjectRef: string } | undefined;
    const messageRow = db
      .prepare("select id, content from messages where id = ?")
      .get("msg_tail") as { id: string; content: string } | undefined;
    const runtimeMessageRow = db
      .prepare("select id, kind, content from runtime_messages where id = ?")
      .get("rtm_snap") as { id: string; kind: string; content: string } | undefined;
    db.close();

    expect(status).toMatchObject({
      workspaceId: "ws_history_snapshot",
      enabled: true,
      state: "idle",
      lastEventId: 5
    });
    expect(sessionRow).toEqual({
      id: "ses_snap",
      subjectRef: "dev:test"
    });
    expect(messageRow?.id).toBe("msg_tail");
    expect(messageRow?.content).toContain("tail event");
    expect(runtimeMessageRow).toMatchObject({
      id: "rtm_snap",
      kind: "tool-call"
    });
    expect(runtimeMessageRow?.content).toContain("\"toolName\":\"Read\"");
  });

  it("does not refresh runtime messages on idle sync passes without new events", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "oah-history-idle-runtime-refresh-"));
    tempRoots.push(workspaceRoot);

    const persistence = createMemoryRuntimePersistence();
    await persistence.workspaceRepository.upsert({
      id: "ws_history_idle_runtime",
      name: "history-idle-runtime",
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
        workspaceId: "ws_history_idle_runtime",
        agents: [],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    let runtimeRefreshReads = 0;
    const syncer = new HistoryMirrorSyncer({
      workspaceRepository: persistence.workspaceRepository,
      historyEventRepository: {
        async append() {
          throw new Error("append should not be called in sync tests");
        },
        async listByWorkspaceId() {
          return [];
        }
      },
      snapshotSource: {
        async readWorkspaceSnapshot(workspaceId) {
          return {
            watermarkEventId: 0,
            sessions: [
              {
                id: "ses_idle_runtime",
                workspaceId,
                subjectRef: "dev:test",
                activeAgentName: "builder",
                status: "active",
                createdAt: "2026-04-01T00:00:00.000Z",
                updatedAt: "2026-04-01T00:00:00.000Z"
              }
            ],
            messages: [],
            runtimeMessages: [
              {
                id: "rtm_idle_runtime",
                sessionId: "ses_idle_runtime",
                role: "assistant",
                kind: "assistant_text",
                content: "snapshot runtime",
                createdAt: "2026-04-01T00:00:01.000Z"
              }
            ],
            runs: [
              {
                id: "run_idle_runtime",
                workspaceId,
                sessionId: "ses_idle_runtime",
                triggerType: "message",
                effectiveAgentName: "builder",
                status: "completed",
                createdAt: "2026-04-01T00:00:01.000Z"
              }
            ],
            runSteps: [],
            toolCalls: [],
            hookRuns: [],
            artifacts: []
          };
        },
        async readWorkspaceRuntimeMessages() {
          runtimeRefreshReads += 1;
          return [
            {
              id: "rtm_idle_runtime",
              sessionId: "ses_idle_runtime",
              role: "assistant",
              kind: "assistant_text",
              content: "snapshot runtime",
              createdAt: "2026-04-01T00:00:01.000Z"
            }
          ];
        }
      }
    });

    await syncer.syncOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const firstStatus = await inspectHistoryMirrorStatus(
      (await persistence.workspaceRepository.getById("ws_history_idle_runtime"))!
    );
    await syncer.syncOnce();
    const secondStatus = await inspectHistoryMirrorStatus(
      (await persistence.workspaceRepository.getById("ws_history_idle_runtime"))!
    );
    await syncer.close();

    expect(runtimeRefreshReads).toBe(0);
    expect(firstStatus.lastSyncedAt).toBeTruthy();
    expect(secondStatus.lastSyncedAt).toBe(firstStatus.lastSyncedAt);
  });

  it("keeps refreshing runtime messages while a mirrored run is still active", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "oah-history-active-runtime-refresh-"));
    tempRoots.push(workspaceRoot);

    const persistence = createMemoryRuntimePersistence();
    await persistence.workspaceRepository.upsert({
      id: "ws_history_active_runtime",
      name: "history-active-runtime",
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
        workspaceId: "ws_history_active_runtime",
        agents: [],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    let runtimeRefreshReads = 0;
    const syncer = new HistoryMirrorSyncer({
      workspaceRepository: persistence.workspaceRepository,
      historyEventRepository: {
        async append() {
          throw new Error("append should not be called in sync tests");
        },
        async listByWorkspaceId() {
          return [];
        }
      },
      snapshotSource: {
        async readWorkspaceSnapshot(workspaceId) {
          return {
            watermarkEventId: 0,
            sessions: [
              {
                id: "ses_active_runtime",
                workspaceId,
                subjectRef: "dev:test",
                activeAgentName: "builder",
                status: "active",
                createdAt: "2026-04-01T00:00:00.000Z",
                updatedAt: "2026-04-01T00:00:00.000Z"
              }
            ],
            messages: [],
            runtimeMessages: [],
            runs: [
              {
                id: "run_active_runtime",
                workspaceId,
                sessionId: "ses_active_runtime",
                triggerType: "message",
                effectiveAgentName: "builder",
                status: "running",
                createdAt: "2026-04-01T00:00:01.000Z"
              }
            ],
            runSteps: [],
            toolCalls: [],
            hookRuns: [],
            artifacts: []
          };
        },
        async readWorkspaceRuntimeMessages() {
          runtimeRefreshReads += 1;
          return [
            {
              id: `rtm_active_runtime_${runtimeRefreshReads}`,
              sessionId: "ses_active_runtime",
              role: "assistant",
              kind: "assistant_text",
              content: `refresh ${runtimeRefreshReads}`,
              createdAt: `2026-04-01T00:00:0${runtimeRefreshReads}.000Z`
            }
          ];
        }
      }
    });

    await syncer.syncOnce();
    await syncer.syncOnce();
    await syncer.close();

    expect(runtimeRefreshReads).toBe(2);
  });

  it("prunes mirrored history events older than the retention window", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "oah-history-prune-"));
    tempRoots.push(workspaceRoot);

    const persistence = createMemoryRuntimePersistence();
    await persistence.workspaceRepository.upsert({
      id: "ws_history_prune",
      name: "history-prune",
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
        workspaceId: "ws_history_prune",
        agents: [],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      }
    });

    const dbPath = historyMirrorDbPath(workspaceRoot);
    await mkdir(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(`
      create table if not exists mirror_state (
        workspace_id text primary key,
        last_event_id integer not null,
        last_synced_at text not null,
        status text not null,
        error_message text
      )
    `);
    db.prepare(
      "insert into mirror_state (workspace_id, last_event_id, last_synced_at, status, error_message) values (?, ?, ?, ?, ?)"
    ).run("ws_history_prune", 42, "2026-04-01T00:00:00.000Z", "idle", null);
    db.close();

    const pruneCalls: Array<{ workspaceId: string; maxEventId: number; occurredBefore: string }> = [];
    const cleaner = new HistoryEventCleaner({
      workspaceRepository: persistence.workspaceRepository,
      historyEventRepository: {
        async append() {
          throw new Error("append should not be called in cleanup tests");
        },
        async listByWorkspaceId() {
          return [];
        },
        async pruneByWorkspace(workspaceId, maxEventId, occurredBefore) {
          pruneCalls.push({ workspaceId, maxEventId, occurredBefore });
          return 3;
        }
      },
      retentionMs: 60_000
    });

    await cleaner.cleanupOnce();
    await cleaner.close();

    expect(pruneCalls).toHaveLength(1);
    expect(pruneCalls[0]).toMatchObject({
      workspaceId: "ws_history_prune",
      maxEventId: 42
    });
    expect(pruneCalls[0]?.occurredBefore).toMatch(/T/);
  });
});
