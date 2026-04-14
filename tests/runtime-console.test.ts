import { describe, expect, it } from "vitest";

import type { SessionEventContract } from "@oah/api-contracts";
import { createMemoryRuntimePersistence } from "@oah/storage-memory";

import {
  appendRuntimeLogEvent,
  buildRuntimeConsoleLogger
} from "../apps/server/src/runtime-console.ts";
import { buildRuntimeConsoleEntries } from "../apps/web/src/app/support";

describe("runtime console", () => {
  it("appends structured runtime.log events to the shared session event store", async () => {
    const persistence = createMemoryRuntimePersistence();
    const workspace = await persistence.workspaceRepository.upsert({
      id: "ws_console",
      name: "console",
      rootPath: "/tmp/console",
      executionPolicy: "local",
      status: "active",
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: { defaultAgent: "builder", skillDirs: [] },
      workspaceModels: {},
      agents: {},
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "ws_console",
        agents: [],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      },
      createdAt: "2026-04-09T00:00:00.000Z",
      updatedAt: "2026-04-09T00:00:00.000Z"
    });
    const session = await persistence.sessionRepository.create({
      id: "ses_console",
      workspaceId: workspace.id,
      subjectRef: "dev:test",
      activeAgentName: "builder",
      status: "active",
      createdAt: "2026-04-09T00:00:00.000Z",
      updatedAt: "2026-04-09T00:00:00.000Z"
    });

    await appendRuntimeLogEvent(persistence.sessionEventStore, {
      sessionId: session.id,
      runId: "run_console",
      level: "error",
      category: "tool",
      message: "Runtime tool call failed.",
      details: {
        sessionId: session.id,
        runId: "run_console",
        toolName: "Bash",
        token: "secret-token"
      },
      context: {
        sessionId: session.id,
        runId: "run_console",
        toolCallId: "call_1"
      },
      timestamp: "2026-04-09T00:00:01.000Z"
    });

    const events = await persistence.sessionEventStore.listSince(session.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "runtime.log",
      data: {
        level: "error",
        category: "tool",
        message: "Runtime tool call failed.",
        source: "server",
        context: {
          sessionId: session.id,
          runId: "run_console",
          toolCallId: "call_1"
        }
      }
    });
    expect((events[0]?.data as { details?: Record<string, unknown> }).details?.token).toBe("[redacted]");
  });

  it("bridges runtime logger entries into runtime.log session events", async () => {
    const persistence = createMemoryRuntimePersistence();
    const logger = buildRuntimeConsoleLogger({
      enabled: true,
      echoToStdout: false,
      sessionEventStore: persistence.sessionEventStore,
      now: () => "2026-04-09T00:00:01.000Z"
    });

    logger?.error?.("Runtime tool call failed.", {
      sessionId: "ses_logger",
      runId: "run_logger",
      toolName: "Read",
      errorCode: "tool_failed"
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const events = await persistence.sessionEventStore.listSince("ses_logger");
    expect(events[0]).toMatchObject({
      event: "runtime.log",
      data: {
        level: "error",
        category: "tool",
        message: "Runtime tool call failed."
      }
    });
  });

  it("projects lifecycle events and runtime.log entries into console rows", () => {
    const entries = buildRuntimeConsoleEntries(
      [
        {
          id: "evt_runtime",
          cursor: "2",
          sessionId: "ses_console",
          runId: "run_console",
          event: "runtime.log",
          data: {
            level: "error",
            category: "tool",
            message: "Detailed tool failure",
            details: { errorCode: "tool_failed" },
            source: "server",
            timestamp: "2026-04-09T00:00:02.000Z"
          },
          createdAt: "2026-04-09T00:00:02.000Z"
        } satisfies SessionEventContract,
        {
          id: "evt_tool",
          cursor: "1",
          sessionId: "ses_console",
          runId: "run_console",
          event: "tool.failed",
          data: {
            toolName: "Bash",
            errorMessage: "Bash timed out."
          },
          createdAt: "2026-04-09T00:00:01.000Z"
        } satisfies SessionEventContract
      ],
      {
        message: "http: Request failed",
        code: "internal_error",
        timestamp: "2026-04-09T00:00:03.000Z"
      }
    );

    expect(entries.map((entry) => `${entry.category}:${entry.level}:${entry.message}`)).toEqual([
      "tool:error:Bash timed out.",
      "tool:error:Detailed tool failure",
      "http:error:http: Request failed"
    ]);
  });
});
