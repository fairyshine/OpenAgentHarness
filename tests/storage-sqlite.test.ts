import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
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
