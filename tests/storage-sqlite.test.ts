import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { WorkspaceRecord } from "@oah/runtime-core";
import { createSQLiteRuntimePersistence } from "../packages/storage-sqlite/src/index.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    })
  );
});

function createWorkspace(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  const rootPath = overrides.rootPath ?? "/tmp/workspace";
  const id = overrides.id ?? "ws_demo";
  return {
    id,
    name: overrides.name ?? "demo",
    rootPath,
    executionPolicy: overrides.executionPolicy ?? "local",
    status: overrides.status ?? "active",
    kind: overrides.kind ?? "project",
    readOnly: overrides.readOnly ?? false,
    historyMirrorEnabled: overrides.historyMirrorEnabled ?? false,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    settings: overrides.settings ?? {
      defaultAgent: "assistant",
      skillDirs: []
    },
    defaultAgent: overrides.defaultAgent ?? "assistant",
    projectAgentsMd: overrides.projectAgentsMd,
    workspaceModels: overrides.workspaceModels ?? {},
    agents: overrides.agents ?? {},
    actions: overrides.actions ?? {},
    skills: overrides.skills ?? {},
    toolServers: overrides.toolServers ?? {},
    hooks: overrides.hooks ?? {},
    catalog: overrides.catalog ?? {
      workspaceId: id,
      agents: [],
      models: [],
      actions: [],
      skills: [],
      tools: [],
      hooks: [],
      nativeTools: []
    },
    ...(overrides.externalRef ? { externalRef: overrides.externalRef } : {})
  };
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function seedLegacyMirrorDatabase(dbPath: string, workspaceId: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      create table if not exists sessions (
        id text primary key,
        workspace_id text not null,
        subject_ref text not null,
        agent_name text,
        active_agent_name text not null,
        title text,
        status text not null,
        last_run_at text,
        created_at text not null,
        updated_at text not null
      );
      create table if not exists messages (
        id text primary key,
        session_id text not null,
        run_id text,
        role text not null,
        content text not null,
        metadata text,
        created_at text not null
      );
      create table if not exists runs (
        id text primary key,
        workspace_id text not null,
        session_id text,
        initiator_ref text,
        trigger_type text not null,
        trigger_ref text,
        agent_name text,
        effective_agent_name text not null,
        switch_count integer,
        status text not null,
        cancel_requested_at text,
        started_at text,
        ended_at text,
        error_code text,
        error_message text,
        metadata text,
        created_at text not null
      );
    `);

    db.prepare(
      `insert into sessions
       (id, workspace_id, subject_ref, agent_name, active_agent_name, title, status, last_run_at, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "ses_legacy",
      workspaceId,
      "dev:test",
      "assistant",
      "assistant",
      "legacy session",
      "active",
      null,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z"
    );

    db.prepare(
      `insert into runs
       (id, workspace_id, session_id, initiator_ref, trigger_type, trigger_ref, agent_name, effective_agent_name, switch_count, status, cancel_requested_at, started_at, ended_at, error_code, error_message, metadata, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "run_legacy",
      workspaceId,
      "ses_legacy",
      "dev:test",
      "user_message",
      null,
      "assistant",
      "assistant",
      0,
      "completed",
      null,
      "2026-01-01T00:00:01.000Z",
      "2026-01-01T00:00:02.000Z",
      null,
      null,
      JSON.stringify({ source: "legacy" }),
      "2026-01-01T00:00:01.000Z"
    );

    db.prepare(
      `insert into messages
       (id, session_id, run_id, role, content, metadata, created_at)
       values (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "msg_legacy",
      "ses_legacy",
      "run_legacy",
      "assistant",
      JSON.stringify("legacy migrated message"),
      JSON.stringify({ source: "legacy" }),
      "2026-01-01T00:00:03.000Z"
    );
  } finally {
    db.close();
  }
}

function seedCurrentSchemaWithLegacyPayloads(dbPath: string, workspaceId: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      create table if not exists sessions (
        id text primary key,
        workspace_id text not null,
        created_at text not null,
        updated_at text not null,
        payload text not null
      );
      create table if not exists runs (
        id text primary key,
        workspace_id text not null,
        session_id text,
        status text not null,
        heartbeat_at text,
        started_at text,
        created_at text not null,
        payload text not null
      );
      create table if not exists messages (
        id text primary key,
        session_id text not null,
        run_id text,
        created_at text not null,
        payload text not null
      );
      create table if not exists run_steps (
        id text primary key,
        run_id text not null,
        seq integer not null,
        payload text not null
      );
      create table if not exists history_events (
        id integer primary key autoincrement,
        workspace_id text not null,
        entity_type text not null,
        entity_id text not null,
        op text not null,
        payload text not null,
        occurred_at text not null
      );
    `);

    db.prepare("insert into sessions (id, workspace_id, created_at, updated_at, payload) values (?, ?, ?, ?, ?)").run(
      "ses_dirty",
      workspaceId,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      JSON.stringify({
        id: "ses_dirty",
        workspaceId,
        subjectRef: "dev:test",
        activeAgentName: "assistant",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      })
    );

    db.prepare(
      "insert into runs (id, workspace_id, session_id, status, heartbeat_at, started_at, created_at, payload) values (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "run_dirty",
      workspaceId,
      "ses_dirty",
      "completed",
      null,
      "2026-01-01T00:00:01.000Z",
      "2026-01-01T00:00:01.000Z",
      JSON.stringify({
        id: "run_dirty",
        workspaceId,
        sessionId: "ses_dirty",
        triggerType: "user_message",
        effectiveAgentName: "assistant",
        status: "completed",
        createdAt: "2026-01-01T00:00:01.000Z",
        startedAt: "2026-01-01T00:00:01.000Z",
        endedAt: "2026-01-01T00:00:02.000Z"
      })
    );

    const messages = [
      {
        id: "msg_user_1",
        sessionId: "ses_dirty",
        runId: "run_dirty",
        role: "user",
        content: "run the tools",
        createdAt: "2026-01-01T00:00:02.000Z"
      },
      {
        id: "msg_assistant_1",
        sessionId: "ses_dirty",
        runId: "run_dirty",
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
        createdAt: "2026-01-01T00:00:03.000Z"
      },
      {
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
      },
      {
        id: "msg_user_2",
        sessionId: "ses_dirty",
        runId: "run_dirty",
        role: "user",
        content: "thanks",
        createdAt: "2026-01-01T00:00:05.000Z"
      }
    ];

    const insertMessage = db.prepare("insert into messages (id, session_id, run_id, created_at, payload) values (?, ?, ?, ?, ?)");
    for (const message of messages) {
      insertMessage.run(message.id, message.sessionId, message.runId, message.createdAt, JSON.stringify(message));
    }

    const step = {
      id: "step_dirty",
      runId: "run_dirty",
      seq: 1,
      stepType: "model_call",
      status: "completed",
      input: {
        model: "openai-default",
        canonicalModelRef: "platform/openai-default",
        messages: [
          { role: "user", content: "run the tools" },
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
        messageCount: 2,
        runtimeToolNames: ["Bash"],
        activeToolNames: ["Bash"]
      },
      output: {
        finishReason: "tool-calls",
        toolCalls: [
          {
            toolCallId: "call_done",
            toolName: "Bash",
            input: { command: "pwd" }
          }
        ],
        toolResults: [
          {
            toolCallId: "call_done",
            toolName: "Bash",
            output: "/tmp/demo"
          }
        ],
        toolCallsCount: 1,
        toolResultsCount: 1
      },
      startedAt: "2026-01-01T00:00:03.000Z",
      endedAt: "2026-01-01T00:00:04.000Z"
    };

    db.prepare("insert into run_steps (id, run_id, seq, payload) values (?, ?, ?, ?)").run(
      step.id,
      step.runId,
      step.seq,
      JSON.stringify(step)
    );

    db.prepare(
      "insert into history_events (workspace_id, entity_type, entity_id, op, payload, occurred_at) values (?, ?, ?, ?, ?, ?)"
    ).run(
      workspaceId,
      "message",
      "msg_tool_1",
      "upsert",
      JSON.stringify(messages[2]),
      "2026-01-01T00:00:04.000Z"
    );
  } finally {
    db.close();
  }
}

describe("storage sqlite", () => {
  it("does not retain a workspace in memory when SQLite upsert fails", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "oah-sqlite-upsert-fail-"));
    tempDirs.push(tempRoot);
    const shadowRootFile = path.join(tempRoot, "shadow-root-file");
    await writeFile(shadowRootFile, "blocked", "utf8");

    const persistence = await createSQLiteRuntimePersistence({ shadowRoot: shadowRootFile });
    const workspace = createWorkspace({
      id: "ws_upsert_fail",
      kind: "chat",
      rootPath: "/tmp/ws-upsert-fail"
    });

    await expect(persistence.workspaceRepository.upsert(workspace)).rejects.toBeInstanceOf(Error);

    await expect(persistence.workspaceRepository.getById(workspace.id)).resolves.toBeNull();
    await expect(persistence.workspaceRepository.list(20)).resolves.toEqual([]);

    await persistence.close();
  });

  it("persists runtime data in a workspace history.db across restarts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-sqlite-project-"));
    tempDirs.push(tempDir);

    const workspaceRoot = path.join(tempDir, "workspace");
    const shadowRoot = path.join(tempDir, "shadow");
    await mkdir(workspaceRoot, { recursive: true });

    const workspace = createWorkspace({
      id: "ws_sqlite_project",
      rootPath: workspaceRoot
    });

    const persistenceA = await createSQLiteRuntimePersistence({ shadowRoot });
    const session = {
      id: "ses_demo",
      workspaceId: workspace.id,
      subjectRef: "dev:test",
      agentName: "assistant",
      activeAgentName: "assistant",
      title: "hello",
      status: "active" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const run = {
      id: "run_demo",
      workspaceId: workspace.id,
      sessionId: session.id,
      initiatorRef: "dev:test",
      triggerType: "user_message" as const,
      effectiveAgentName: "assistant",
      status: "completed" as const,
      createdAt: "2026-01-01T00:00:01.000Z",
      startedAt: "2026-01-01T00:00:01.000Z",
      endedAt: "2026-01-01T00:00:02.000Z"
    };
    const message = {
      id: "msg_demo",
      sessionId: session.id,
      runId: run.id,
      role: "user" as const,
      content: "hello",
      createdAt: "2026-01-01T00:00:00.500Z"
    };

    await persistenceA.workspaceRepository.upsert(workspace);
    await persistenceA.sessionRepository.create(session);
    await persistenceA.runRepository.create(run);
    await persistenceA.messageRepository.create(message);
    await persistenceA.sessionEventStore.append({
      sessionId: session.id,
      runId: run.id,
      event: "run.completed",
      data: {
        runId: run.id
      }
    });
    await persistenceA.close();

    const registryDb = new DatabaseSync(path.join(shadowRoot, "workspace-registry.db"));
    try {
      const sessionRegistryRow = registryDb
        .prepare("select workspace_id as workspaceId from session_registry where id = ?")
        .get(session.id) as { workspaceId: string } | undefined;
      const messageRegistryRow = registryDb
        .prepare("select workspace_id as workspaceId from message_registry where id = ?")
        .get(message.id) as { workspaceId: string } | undefined;
      const sessionEventRegistryRow = registryDb
        .prepare("select workspace_id as workspaceId from session_event_registry where id in (select id from session_event_registry limit 1)")
        .get() as { workspaceId: string } | undefined;
      const runRegistryRow = registryDb
        .prepare("select workspace_id as workspaceId from run_registry where id = ?")
        .get(run.id) as { workspaceId: string } | undefined;
      expect(sessionRegistryRow).toEqual({
        workspaceId: workspace.id
      });
      expect(messageRegistryRow).toEqual({
        workspaceId: workspace.id
      });
      expect(sessionEventRegistryRow).toEqual({
        workspaceId: workspace.id
      });
      expect(runRegistryRow).toEqual({
        workspaceId: workspace.id
      });
    } finally {
      registryDb.close();
    }

    const persistenceB = await createSQLiteRuntimePersistence({ shadowRoot });
    const restoredSnapshots = await persistenceB.listWorkspaceSnapshots([workspace]);
    expect(restoredSnapshots).toEqual([
      expect.objectContaining({
        id: workspace.id,
        rootPath: workspace.rootPath
      })
    ]);

    await persistenceB.workspaceRepository.upsert(workspace);
    await expect(persistenceB.sessionRepository.getById(session.id)).resolves.toEqual(session);
    await expect(persistenceB.runRepository.getById(run.id)).resolves.toEqual(run);
    await expect(persistenceB.messageRepository.getById(message.id)).resolves.toEqual(message);
    await expect(persistenceB.messageRepository.listBySessionId(session.id)).resolves.toEqual([message]);
    await expect(persistenceB.sessionEventStore.listSince(session.id)).resolves.toEqual([
      expect.objectContaining({
        sessionId: session.id,
        runId: run.id,
        event: "run.completed"
      })
    ]);
    expect(await exists(path.join(workspaceRoot, ".openharness", "data", "history.db"))).toBe(true);
    await persistenceB.close();
  });

  it("deletes session-scoped runtime data and records mirror delete events", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-sqlite-delete-session-"));
    tempDirs.push(tempDir);

    const workspaceRoot = path.join(tempDir, "workspace");
    const shadowRoot = path.join(tempDir, "shadow");
    await mkdir(workspaceRoot, { recursive: true });

    const workspace = createWorkspace({
      id: "ws_delete_session",
      rootPath: workspaceRoot
    });

    const persistence = await createSQLiteRuntimePersistence({ shadowRoot });
    await persistence.workspaceRepository.upsert(workspace);

    const session = {
      id: "ses_delete",
      workspaceId: workspace.id,
      subjectRef: "dev:test",
      activeAgentName: "assistant",
      status: "active" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const run = {
      id: "run_delete",
      workspaceId: workspace.id,
      sessionId: session.id,
      triggerType: "message" as const,
      effectiveAgentName: "assistant",
      status: "completed" as const,
      createdAt: "2026-01-01T00:00:01.000Z"
    };
    const message = {
      id: "msg_delete",
      sessionId: session.id,
      runId: run.id,
      role: "user" as const,
      content: "delete me",
      createdAt: "2026-01-01T00:00:02.000Z"
    };
    const step = {
      id: "step_delete",
      runId: run.id,
      seq: 1,
      stepType: "model_call" as const,
      status: "completed" as const,
      createdAt: "2026-01-01T00:00:03.000Z"
    };
    const toolCall = {
      id: "tool_delete",
      runId: run.id,
      sourceType: "tool" as const,
      toolName: "Read",
      status: "completed" as const,
      startedAt: "2026-01-01T00:00:04.000Z",
      endedAt: "2026-01-01T00:00:04.500Z"
    };
    const hookRun = {
      id: "hook_delete",
      runId: run.id,
      hookName: "before_model_call",
      eventName: "before_model_call",
      capabilities: {},
      status: "completed" as const,
      startedAt: "2026-01-01T00:00:05.000Z",
      endedAt: "2026-01-01T00:00:05.500Z"
    };
    const artifact = {
      id: "artifact_delete",
      runId: run.id,
      type: "file",
      createdAt: "2026-01-01T00:00:06.000Z"
    };

    await persistence.sessionRepository.create(session);
    await persistence.runRepository.create(run);
    await persistence.messageRepository.create(message);
    await persistence.runStepRepository.create(step);
    await persistence.toolCallAuditRepository.create(toolCall);
    await persistence.hookRunAuditRepository.create(hookRun);
    await persistence.artifactRepository.create(artifact);
    await persistence.runtimeMessageRepository.replaceBySessionId(session.id, [
      {
        id: "rtm_delete",
        sessionId: session.id,
        runId: run.id,
        role: "assistant",
        kind: "assistant_text",
        content: "derived row",
        createdAt: "2026-01-01T00:00:06.500Z"
      }
    ]);
    await persistence.sessionEventStore.append({
      sessionId: session.id,
      runId: run.id,
      event: "run.completed",
      data: {
        runId: run.id
      }
    });

    await persistence.sessionRepository.delete(session.id);

    await expect(persistence.sessionRepository.getById(session.id)).resolves.toBeNull();
    await expect(persistence.runRepository.getById(run.id)).resolves.toBeNull();

    const registryDb = new DatabaseSync(path.join(shadowRoot, "workspace-registry.db"));
    try {
      const sessionRegistryCount = registryDb
        .prepare("select count(*) as count from session_registry where workspace_id = ?")
        .get(workspace.id) as { count: number };
      const messageRegistryCount = registryDb
        .prepare("select count(*) as count from message_registry where workspace_id = ?")
        .get(workspace.id) as { count: number };
      const sessionEventRegistryCount = registryDb
        .prepare("select count(*) as count from session_event_registry where workspace_id = ?")
        .get(workspace.id) as { count: number };
      const runRegistryCount = registryDb
        .prepare("select count(*) as count from run_registry where workspace_id = ?")
        .get(workspace.id) as { count: number };
      expect(sessionRegistryCount.count).toBe(0);
      expect(messageRegistryCount.count).toBe(0);
      expect(sessionEventRegistryCount.count).toBe(0);
      expect(runRegistryCount.count).toBe(0);
    } finally {
      registryDb.close();
    }

    const historyEvents = await persistence.historyEventRepository.listByWorkspaceId(workspace.id, 50);
    expect(
      historyEvents
        .filter((event) => event.op === "delete")
        .map((event) => `${event.entityType}:${event.entityId}`)
    ).toEqual(
      expect.arrayContaining([
        "artifact:artifact_delete",
        "hook_run:hook_delete",
        "tool_call:tool_delete",
        "run_step:step_delete",
        "run:run_delete",
        "message:msg_delete",
        "session:ses_delete"
      ])
    );

    const db = new DatabaseSync(path.join(workspaceRoot, ".openharness", "data", "history.db"));
    try {
      for (const tableName of [
        "sessions",
        "messages",
        "runtime_messages",
        "runs",
        "run_steps",
        "tool_calls",
        "hook_runs",
        "artifacts",
        "session_events"
      ]) {
        const row = db.prepare(`select count(*) as count from ${tableName}`).get() as { count: number };
        expect(row.count).toBe(0);
      }
    } finally {
      db.close();
    }

    await persistence.close();
  });

  it("tracks recoverable runs in the registry across restarts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-sqlite-recoverable-runs-"));
    tempDirs.push(tempDir);

    const workspaceRoot = path.join(tempDir, "workspace");
    const shadowRoot = path.join(tempDir, "shadow");
    await mkdir(workspaceRoot, { recursive: true });

    const workspace = createWorkspace({
      id: "ws_recoverable_runs",
      rootPath: workspaceRoot
    });

    const persistenceA = await createSQLiteRuntimePersistence({ shadowRoot });
    await persistenceA.workspaceRepository.upsert(workspace);
    await persistenceA.sessionRepository.create({
      id: "ses_recoverable",
      workspaceId: workspace.id,
      subjectRef: "dev:test",
      activeAgentName: "assistant",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });

    await persistenceA.runRepository.create({
      id: "run_recoverable_stale",
      workspaceId: workspace.id,
      sessionId: "ses_recoverable",
      triggerType: "message",
      effectiveAgentName: "assistant",
      status: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:10.000Z",
      heartbeatAt: "2026-01-01T00:00:20.000Z"
    });
    await persistenceA.runRepository.create({
      id: "run_recoverable_recent",
      workspaceId: workspace.id,
      sessionId: "ses_recoverable",
      triggerType: "message",
      effectiveAgentName: "assistant",
      status: "waiting_tool",
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:30.000Z",
      heartbeatAt: "2026-01-01T00:00:55.000Z"
    });
    await persistenceA.close();

    const persistenceB = await createSQLiteRuntimePersistence({ shadowRoot });
    await persistenceB.workspaceRepository.upsert(workspace);

    await expect(
      persistenceB.runRepository.listRecoverableActiveRuns("2026-01-01T00:00:40.000Z", 10)
    ).resolves.toEqual([
      expect.objectContaining({
        id: "run_recoverable_stale",
        status: "running"
      })
    ]);

    await persistenceB.runRepository.update({
      id: "run_recoverable_stale",
      workspaceId: workspace.id,
      sessionId: "ses_recoverable",
      triggerType: "message",
      effectiveAgentName: "assistant",
      status: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:10.000Z",
      heartbeatAt: "2026-01-01T00:00:20.000Z",
      endedAt: "2026-01-01T00:00:45.000Z"
    });

    await expect(
      persistenceB.runRepository.listRecoverableActiveRuns("2026-01-01T00:00:40.000Z", 10)
    ).resolves.toEqual([]);

    const registryDb = new DatabaseSync(path.join(shadowRoot, "workspace-registry.db"));
    try {
      const staleRow = registryDb
        .prepare("select status, recover_at as recoverAt from run_registry where id = ?")
        .get("run_recoverable_stale") as { status: string; recoverAt: string } | undefined;
      expect(staleRow).toEqual({
        status: "completed",
        recoverAt: "2026-01-01T00:00:20.000Z"
      });
    } finally {
      registryDb.close();
    }

    await persistenceB.close();
  });

  it("deletes persisted session events by id across restarts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-sqlite-delete-event-"));
    tempDirs.push(tempDir);

    const workspaceRoot = path.join(tempDir, "workspace");
    const shadowRoot = path.join(tempDir, "shadow");
    await mkdir(workspaceRoot, { recursive: true });

    const workspace = createWorkspace({
      id: "ws_delete_event",
      rootPath: workspaceRoot
    });

    const persistenceA = await createSQLiteRuntimePersistence({ shadowRoot });
    await persistenceA.workspaceRepository.upsert(workspace);
    await persistenceA.sessionRepository.create({
      id: "ses_delete_event",
      workspaceId: workspace.id,
      subjectRef: "dev:test",
      activeAgentName: "assistant",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });

    const first = await persistenceA.sessionEventStore.append({
      sessionId: "ses_delete_event",
      runId: "run_delete_event",
      event: "run.started",
      data: { step: 1 }
    });
    const second = await persistenceA.sessionEventStore.append({
      sessionId: "ses_delete_event",
      runId: "run_delete_event",
      event: "tool.started",
      data: { toolName: "bash" }
    });
    const third = await persistenceA.sessionEventStore.append({
      sessionId: "ses_delete_event",
      runId: "run_delete_event",
      event: "tool.completed",
      data: { toolName: "bash" }
    });
    await persistenceA.close();

    const persistenceB = await createSQLiteRuntimePersistence({ shadowRoot });
    await persistenceB.workspaceRepository.upsert(workspace);
    await persistenceB.sessionEventStore.deleteById(second.id);

    const registryDb = new DatabaseSync(path.join(shadowRoot, "workspace-registry.db"));
    try {
      const deletedRegistryRow = registryDb
        .prepare("select count(*) as count from session_event_registry where id = ?")
        .get(second.id) as { count: number };
      expect(deletedRegistryRow.count).toBe(0);
    } finally {
      registryDb.close();
    }

    await expect(persistenceB.sessionEventStore.listSince("ses_delete_event")).resolves.toEqual([
      expect.objectContaining({ id: first.id, cursor: "0" }),
      expect.objectContaining({ id: third.id, cursor: "2" })
    ]);

    await persistenceB.close();
  });

  it("stores read-only chat workspace data under the shadow root", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-sqlite-chat-"));
    tempDirs.push(tempDir);

    const chatRoot = path.join(tempDir, "chat-workspace");
    const shadowRoot = path.join(tempDir, "shadow");
    await mkdir(chatRoot, { recursive: true });

    const workspace = createWorkspace({
      id: "ws_sqlite_chat",
      rootPath: chatRoot,
      kind: "chat",
      readOnly: true
    });

    const persistence = await createSQLiteRuntimePersistence({ shadowRoot });
    await persistence.workspaceRepository.upsert(workspace);
    await persistence.sessionRepository.create({
      id: "ses_chat",
      workspaceId: workspace.id,
      subjectRef: "dev:test",
      activeAgentName: "assistant",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });
    await persistence.close();

    expect(await exists(path.join(chatRoot, ".openharness", "data", "history.db"))).toBe(false);
    expect(await exists(path.join(shadowRoot, workspace.id, "history.db"))).toBe(true);
  });

  it("migrates legacy mirror databases copied into workspace_dir", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-sqlite-legacy-"));
    tempDirs.push(tempDir);

    const workspaceRoot = path.join(tempDir, "legacy-workspace");
    const shadowRoot = path.join(tempDir, "shadow");
    const dbPath = path.join(workspaceRoot, ".openharness", "data", "history.db");
    await mkdir(path.dirname(dbPath), { recursive: true });

    const workspace = createWorkspace({
      id: "ws_legacy_copy",
      rootPath: workspaceRoot
    });

    seedLegacyMirrorDatabase(dbPath, workspace.id);

    const persistence = await createSQLiteRuntimePersistence({ shadowRoot });
    await persistence.workspaceRepository.upsert(workspace);

    await expect(persistence.sessionRepository.getById("ses_legacy")).resolves.toEqual(
      expect.objectContaining({
        id: "ses_legacy",
        workspaceId: workspace.id,
        title: "legacy session"
      })
    );
    await expect(persistence.runRepository.getById("run_legacy")).resolves.toEqual(
      expect.objectContaining({
        id: "run_legacy",
        workspaceId: workspace.id,
        status: "completed"
      })
    );
    await expect(persistence.messageRepository.listBySessionId("ses_legacy")).resolves.toEqual([
      expect.objectContaining({
        id: "msg_legacy",
        content: "legacy migrated message"
      })
    ]);
    await expect(persistence.sessionRepository.listByWorkspaceId(workspace.id, 10)).resolves.toEqual([
      expect.objectContaining({
        id: "ses_legacy",
        workspaceId: workspace.id
      })
    ]);
    await persistence.close();
  });

  it("rebinds copied workspace records to the current workspace id on startup", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-sqlite-copied-workspace-"));
    tempDirs.push(tempDir);

    const workspaceRoot = path.join(tempDir, "copied-workspace");
    const shadowRoot = path.join(tempDir, "shadow");
    const dbPath = path.join(workspaceRoot, ".openharness", "data", "history.db");
    await mkdir(path.dirname(dbPath), { recursive: true });

    const sourceWorkspaceId = "ws_source_workspace";
    const workspace = createWorkspace({
      id: "ws_copied_workspace",
      rootPath: workspaceRoot
    });

    seedCurrentSchemaWithLegacyPayloads(dbPath, sourceWorkspaceId);

    const persistence = await createSQLiteRuntimePersistence({ shadowRoot });
    await persistence.workspaceRepository.upsert(workspace);

    await expect(persistence.sessionRepository.listByWorkspaceId(workspace.id, 10)).resolves.toEqual([
      expect.objectContaining({
        id: "ses_dirty",
        workspaceId: workspace.id
      })
    ]);
    await expect(persistence.runRepository.getById("run_dirty")).resolves.toEqual(
      expect.objectContaining({
        id: "run_dirty",
        workspaceId: workspace.id
      })
    );
    await expect(persistence.historyEventRepository.listByWorkspaceId(workspace.id, 10)).resolves.toEqual([
      expect.objectContaining({
        workspaceId: workspace.id
      })
    ]);

    const db = new DatabaseSync(dbPath);
    try {
      const sourceRows = db.prepare("select count(*) as count from history_events where workspace_id = ?").get(sourceWorkspaceId) as {
        count: number;
      };
      expect(sourceRows.count).toBe(0);
    } finally {
      db.close();
    }

    await persistence.close();
  });

  it("normalizes persisted message and model_call payloads on startup", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-sqlite-normalize-"));
    tempDirs.push(tempDir);

    const workspaceRoot = path.join(tempDir, "normalize-workspace");
    const shadowRoot = path.join(tempDir, "shadow");
    const dbPath = path.join(workspaceRoot, ".openharness", "data", "history.db");
    await mkdir(path.dirname(dbPath), { recursive: true });

    const workspace = createWorkspace({
      id: "ws_normalize",
      rootPath: workspaceRoot
    });

    seedCurrentSchemaWithLegacyPayloads(dbPath, workspace.id);

    const persistence = await createSQLiteRuntimePersistence({ shadowRoot });
    await persistence.workspaceRepository.upsert(workspace);

    const messages = await persistence.messageRepository.listBySessionId("ses_dirty");
    expect(messages).toHaveLength(5);
    expect(messages.find((message) => message.id === "msg_tool_1")).toEqual(
      expect.objectContaining({
        id: "msg_tool_1",
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_done",
            toolName: "Bash",
            output: {
              type: "text",
              value: "/tmp/demo"
            }
          }
        ]
      })
    );
    expect(messages.find((message) => message.id === "msg_assistant_1~missing-tool-result")).toEqual(
      expect.objectContaining({
        id: "msg_assistant_1~missing-tool-result",
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_missing",
            toolName: "Read",
            output: {
              type: "text",
              value: "Tool result unavailable because the original run ended before this tool call result was recorded."
            }
          }
        ]
      })
    );

    const [step] = await persistence.runStepRepository.listByRunId("run_dirty");
    expect(step?.input).toEqual({
      request: {
        model: "openai-default",
        canonicalModelRef: "platform/openai-default",
        messages: [
          { role: "user", content: "run the tools" },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call_done",
                toolName: "Bash",
                output: {
                  type: "text",
                  value: "/tmp/demo"
                }
              }
            ]
          }
        ]
      },
      runtime: {
        messageCount: 2,
        runtimeToolNames: ["Bash"],
        activeToolNames: ["Bash"]
      }
    });
    expect(step?.output).toEqual({
      response: {
        finishReason: "tool-calls",
        toolCalls: [
          {
            toolCallId: "call_done",
            toolName: "Bash",
            input: { command: "pwd" }
          }
        ],
        toolResults: [
          {
            toolCallId: "call_done",
            toolName: "Bash",
            output: {
              type: "text",
              value: "/tmp/demo"
            }
          }
        ]
      },
      runtime: {
        toolCallsCount: 1,
        toolResultsCount: 1
      }
    });

    await persistence.close();
  });
});
