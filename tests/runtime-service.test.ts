import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { RuntimeService } from "@oah/runtime-core";
import type { HookRunAuditRecord, ToolCallAuditRecord } from "@oah/runtime-core";
import { createMemoryRuntimePersistence } from "@oah/storage-memory";

import { FakeModelGateway } from "./helpers/fake-model-gateway";

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error("Timed out while waiting for condition.");
}

async function createRuntime(delayMs = 0) {
  const gateway = new FakeModelGateway(delayMs);
  const persistence = createMemoryRuntimePersistence();
  const runtimeService = new RuntimeService({
    defaultModel: "openai-default",
    modelGateway: gateway,
    ...persistence,
    workspaceInitializer: {
      async initialize(input) {
        return {
          rootPath: input.rootPath,
          settings: {
            defaultAgent: "default",
            skillDirs: []
          },
          defaultAgent: "default",
          workspaceModels: {},
          agents: {},
          actions: {},
          skills: {},
          toolServers: {},
          hooks: {},
          catalog: {
            workspaceId: "template",
            agents: [],
            models: [],
            actions: [],
            skills: [],
            mcp: [],
            hooks: [],
            nativeTools: []
          }
        };
      }
    }
  });

  const workspace = await runtimeService.createWorkspace({
    input: {
      name: "demo",
      template: "workspace",
      rootPath: "/tmp/demo",
      executionPolicy: "local"
    }
  });

  return { gateway, runtimeService, workspace };
}

describe("runtime service", () => {
  it("creates workspaces from a template initializer result", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence,
      workspaceInitializer: {
        async initialize(input) {
          return {
            rootPath: input.rootPath,
            defaultAgent: "builder",
            projectAgentsMd: "Template rule: always add tests.",
            settings: {
              defaultAgent: "builder",
              skillDirs: []
            },
            workspaceModels: {},
            agents: {
              builder: {
                name: "builder",
                mode: "primary",
                prompt: "You are builder.",
                tools: {
                  native: [],
                  actions: [],
                  skills: [],
                  mcp: []
                },
                switch: [],
                subagents: []
              }
            },
            actions: {},
            skills: {},
            toolServers: {},
            hooks: {},
            catalog: {
              workspaceId: "template",
              agents: [{ name: "builder", source: "workspace" }],
              models: [],
              actions: [],
              skills: [],
              mcp: [],
              hooks: [],
              nativeTools: []
            }
          };
        }
      }
    });

    const workspace = await runtimeService.createWorkspace({
      input: {
        name: "demo",
        template: "workspace",
        rootPath: "/tmp/demo",
        executionPolicy: "local"
      }
    });

    const stored = await runtimeService.getWorkspaceRecord(workspace.id);
    expect(stored.defaultAgent).toBe("builder");
    expect(stored.projectAgentsMd).toBe("Template rule: always add tests.");
    expect(stored.catalog.workspaceId).toBe(workspace.id);
    expect(stored.settings.defaultAgent).toBe("builder");
    expect(workspace.kind).toBe("project");
    expect(workspace.readOnly).toBe(false);
    expect(workspace.historyMirrorEnabled).toBe(false);
  });

  it("deletes workspace records and cascades in-memory session data", async () => {
    let deletedWorkspaceRoot = "";
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence,
      workspaceDeletionHandler: {
        async deleteWorkspace(workspace) {
          deletedWorkspaceRoot = workspace.rootPath;
        }
      },
      workspaceInitializer: {
        async initialize(input) {
          return {
            rootPath: input.rootPath,
            settings: {
              defaultAgent: "default",
              skillDirs: []
            },
            defaultAgent: "default",
            workspaceModels: {},
            agents: {},
            actions: {},
            skills: {},
            toolServers: {},
            hooks: {},
            catalog: {
              workspaceId: "template",
              agents: [],
              models: [],
              actions: [],
              skills: [],
              mcp: [],
              hooks: [],
              nativeTools: []
            }
          };
        }
      }
    });

    const workspace = await runtimeService.createWorkspace({
      input: {
        name: "demo",
        template: "workspace",
        rootPath: "/tmp/workspace-delete-demo",
        executionPolicy: "local"
      }
    });

    const session = await runtimeService.createSession({
      workspaceId: workspace.id,
      caller: {
        subjectRef: "dev:test",
        authSource: "test",
        scopes: [],
        workspaceAccess: []
      },
      input: {}
    });

    await runtimeService.deleteWorkspace(workspace.id);

    expect(deletedWorkspaceRoot).toBe("/tmp/workspace-delete-demo");
    await expect(runtimeService.getWorkspace(workspace.id)).rejects.toMatchObject({
      code: "workspace_not_found"
    });
    await expect(runtimeService.getSession(session.id)).rejects.toMatchObject({
      code: "session_not_found"
    });
  });

  it("serializes runs inside a session", async () => {
    const { runtimeService, workspace } = await createRuntime(30);
    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: workspace.id,
      caller,
      input: {}
    });

    const first = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "first" }
    });
    const second = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "second" }
    });

    await waitFor(async () => {
      const events = await runtimeService.listSessionEvents(session.id);
      return events.filter((event) => event.event === "run.completed").length === 2;
    });

    const events = await runtimeService.listSessionEvents(session.id);
    const runStarted = events.filter((event) => event.event === "run.started").map((event) => event.runId);
    const runCompleted = events.filter((event) => event.event === "run.completed").map((event) => event.runId);

    expect(runStarted).toEqual([first.runId, second.runId]);
    expect(runCompleted).toEqual([first.runId, second.runId]);
  });

  it("includes the first session event when listing without a cursor", async () => {
    const { runtimeService, workspace } = await createRuntime();
    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: workspace.id,
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "hello" }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    const events = await runtimeService.listSessionEvents(session.id);

    expect(events.at(0)?.event).toBe("run.queued");
    expect(events.at(0)?.runId).toBe(accepted.runId);
  });

  it("allows different sessions to run concurrently", async () => {
    const { runtimeService, workspace, gateway } = await createRuntime(60);
    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const sessionA = await runtimeService.createSession({
      workspaceId: workspace.id,
      caller,
      input: { title: "a" }
    });
    const sessionB = await runtimeService.createSession({
      workspaceId: workspace.id,
      caller,
      input: { title: "b" }
    });

    await Promise.all([
      runtimeService.createSessionMessage({
        sessionId: sessionA.id,
        caller,
        input: { content: "alpha" }
      }),
      runtimeService.createSessionMessage({
        sessionId: sessionB.id,
        caller,
        input: { content: "beta" }
      })
    ]);

    await waitFor(() => gateway.maxConcurrentStreams >= 2);
    expect(gateway.maxConcurrentStreams).toBeGreaterThanOrEqual(2);
  });

  it("cancels queued or running runs", async () => {
    const { runtimeService, workspace } = await createRuntime(80);
    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: workspace.id,
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "cancel me" }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "running";
    });

    await runtimeService.cancelRun(accepted.runId);
    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "cancelled";
    });

    const run = await runtimeService.getRun(accepted.runId);
    expect(run.status).toBe("cancelled");
  });

  it("uses a discovered workspace default agent when session input omits agentName", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_demo",
      name: "demo",
      rootPath: "/tmp/demo",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "You are builder.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            mcp: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_demo",
        agents: [{ name: "builder", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        mcp: [],
        hooks: [],
        nativeTools: []
      }
    });

    const session = await runtimeService.createSession({
      workspaceId: "project_demo",
      caller: {
        subjectRef: "dev:test",
        authSource: "standalone_server",
        scopes: [],
        workspaceAccess: []
      },
      input: {}
    });

    expect(session.activeAgentName).toBe("builder");
  });

  it("injects AGENTS.md, active agent prompt, and system reminder when the session explicitly selects an agent", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_prompt",
      name: "prompt-workspace",
      rootPath: "/tmp/prompt-workspace",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      projectAgentsMd: "Repository rule: always add tests.",
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "You are the builder agent.",
          systemReminder: "Stay focused on implementation.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            mcp: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_prompt",
        agents: [{ name: "builder", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        mcp: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_prompt",
      caller,
      input: {
        agentName: "builder"
      }
    });

    await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "implement feature" }
    });

    await waitFor(() => gateway.invocations.length > 0);

    const systemMessages = gateway.invocations
      .at(0)
      ?.input.messages?.filter((message) => message.role === "system")
      .map((message) => message.content);
    expect(systemMessages).toEqual(
      expect.arrayContaining([
        "Repository rule: always add tests.",
        "You are the builder agent.",
        expect.stringContaining("Stay focused on implementation.")
      ])
    );
  });

  it("does not inject system reminder for default-agent sessions unless the agent was explicitly selected", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_prompt_default_agent",
      name: "prompt-default-agent",
      rootPath: "/tmp/prompt-default-agent",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "You are the builder agent.",
          systemReminder: "Stay focused on implementation.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            mcp: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_prompt_default_agent",
        agents: [{ name: "builder", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        mcp: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_prompt_default_agent",
      caller,
      input: {}
    });

    await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "implement feature" }
    });

    await waitFor(() => gateway.invocations.length > 0);

    const systemMessages = gateway.invocations
      .at(0)
      ?.input.messages?.filter((message) => message.role === "system")
      .map((message) => message.content);
    expect(systemMessages?.some((message) => message.includes("<system_reminder>"))).toBe(false);
  });

  it("switches agents mid-run and uses the switched prompt, model, and reminder on the next step", async () => {
    const gateway = new FakeModelGateway();
    gateway.streamScenarioFactory = () => ({
      text: "Build agent finished the implementation.",
      toolSteps: [
        {
          toolName: "agent.switch",
          input: { agentName: "build" },
          toolCallId: "call_switch"
        }
      ]
    });

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_agent_switch",
      name: "agent-switch",
      rootPath: "/tmp/agent-switch",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "plan",
      settings: {
        defaultAgent: "plan",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        plan: {
          name: "plan",
          mode: "primary",
          prompt: "You are the planning agent.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            mcp: []
          },
          switch: ["build"],
          subagents: []
        },
        build: {
          name: "build",
          mode: "primary",
          prompt: "You are the build agent.",
          systemReminder: "Take over implementation and continue from the planner's handoff.",
          modelRef: "platform/build-model",
          tools: {
            native: [],
            actions: [],
            skills: [],
            mcp: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_agent_switch",
        agents: [
          { name: "plan", source: "workspace" },
          { name: "build", source: "workspace" }
        ],
        models: [],
        actions: [],
        skills: [],
        mcp: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_agent_switch",
      caller,
      input: {
        agentName: "plan"
      }
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Plan first, then hand off to build." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    await waitFor(() => gateway.invocations.length >= 2);

    const run = await runtimeService.getRun(accepted.runId);
    const updatedSession = await runtimeService.getSession(session.id);
    const events = await runtimeService.listSessionEvents(session.id);
    const initialSystemMessages = gateway.invocations
      .at(0)
      ?.input.messages?.filter((message) => message.role === "system")
      .map((message) => message.content);
    const switchedInvocation = gateway.invocations.at(1);
    const switchedSystemMessages = switchedInvocation?.input.messages
      ?.filter((message) => message.role === "system")
      .map((message) => message.content);

    expect(run.effectiveAgentName).toBe("build");
    expect(run.switchCount).toBe(1);
    expect(updatedSession.activeAgentName).toBe("build");
    expect(events.map((event) => event.event)).toEqual(
      expect.arrayContaining(["agent.switch.requested", "agent.switched", "run.completed"])
    );
    expect(initialSystemMessages).toEqual(expect.arrayContaining(["You are the planning agent."]));
    expect(switchedInvocation?.model).toBe("build-model");
    expect(switchedSystemMessages).toEqual(expect.arrayContaining(["You are the build agent."]));
    expect(switchedSystemMessages?.some((message) => message.includes("You are the planning agent."))).toBe(false);
    expect(switchedSystemMessages?.some((message) => message.includes("<system_reminder>"))).toBe(true);
    expect(switchedSystemMessages?.some((message) => message.includes("Take over implementation"))).toBe(true);

    const runSteps = await runtimeService.listRunSteps(accepted.runId);
    expect(runSteps.items.some((step) => step.stepType === "agent_switch" && step.status === "completed")).toBe(true);
    expect(runSteps.items.some((step) => step.stepType === "tool_call" && step.name === "agent.switch")).toBe(true);
  });

  it("delegates to a subagent, awaits the child run, and inherits the parent model when the subagent has no model", async () => {
    const gateway = new FakeModelGateway();
    gateway.streamScenarioFactory = (input) => {
      const systemMessages = input.messages?.filter((message) => message.role === "system").map((message) => message.content) ?? [];

      if (systemMessages.some((message) => message.includes("You are the researcher subagent."))) {
        return {
          text: "Subagent result: repository facts are ready."
        };
      }

      return {
        text: "Parent integrated the subagent result.",
        toolSteps: [
          {
            toolName: "agent.delegate",
            input: {
              agentName: "researcher",
              task: "Inspect the repository and summarize the key facts.",
              handoffSummary: "The parent planner needs a compact fact summary."
            },
            toolCallId: "call_delegate"
          },
          {
            toolName: "agent.await",
            input: {},
            toolCallId: "call_await"
          }
        ]
      };
    };

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      platformModels: {
        "planner-model": {
          provider: "openai",
          name: "gpt-4.1-mini"
        }
      },
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_agent_delegate",
      name: "agent-delegate",
      rootPath: "/tmp/agent-delegate",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "plan",
      settings: {
        defaultAgent: "plan",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        plan: {
          name: "plan",
          mode: "primary",
          prompt: "You are the planner agent.",
          modelRef: "platform/planner-model",
          tools: {
            native: [],
            actions: [],
            skills: [],
            mcp: []
          },
          switch: [],
          subagents: ["researcher"]
        },
        researcher: {
          name: "researcher",
          mode: "subagent",
          prompt: "You are the researcher subagent.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            mcp: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_agent_delegate",
        agents: [
          { name: "plan", source: "workspace" },
          { name: "researcher", source: "workspace" }
        ],
        models: [{ ref: "platform/planner-model", name: "planner-model", source: "platform", provider: "openai" }],
        actions: [],
        skills: [],
        mcp: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_agent_delegate",
      caller,
      input: {
        agentName: "plan"
      }
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Use a subagent to gather the repo facts, then continue." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    const parentRun = await runtimeService.getRun(accepted.runId);
    const delegatedRuns = ((parentRun.metadata?.delegatedRuns as Array<{ childRunId: string }> | undefined) ?? []).map(
      (record) => record.childRunId
    );

    expect(delegatedRuns).toHaveLength(1);

    const childRun = await runtimeService.getRun(delegatedRuns[0]!);
    await waitFor(async () => {
      const run = await runtimeService.getRun(childRun.id);
      return run.status === "completed";
    });

    const parentMessages = await runtimeService.listSessionMessages(session.id, 50);
    const awaitToolMessage = parentMessages.items.find(
      (message) => message.role === "tool" && message.toolName === "agent.await"
    );
    const events = await runtimeService.listSessionEvents(session.id);
    const childInvocation = gateway.invocations.find((invocation) =>
      invocation.input.messages?.some(
        (message) => message.role === "system" && message.content.includes("You are the researcher subagent.")
      )
    );

    expect(childRun.triggerType).toBe("system");
    expect(childRun.parentRunId).toBe(accepted.runId);
    expect(childRun.metadata).toMatchObject({
      parentRunId: accepted.runId,
      parentSessionId: session.id,
      parentAgentName: "plan"
    });
    expect(childInvocation?.model).toBe("planner-model");
    expect(awaitToolMessage?.content).toContain("<agent_await mode=\"all\">");
    expect(awaitToolMessage?.content).toContain("Subagent result: repository facts are ready.");
    expect(events.map((event) => event.event)).toEqual(
      expect.arrayContaining(["agent.delegate.started", "agent.delegate.completed", "run.completed"])
    );

    const parentRunSteps = await runtimeService.listRunSteps(accepted.runId);
    expect(parentRunSteps.items.some((step) => step.stepType === "agent_delegate" && step.status === "completed")).toBe(true);
    expect(parentRunSteps.items.some((step) => step.stepType === "tool_call" && step.name === "agent.delegate")).toBe(true);
    expect(parentRunSteps.items.some((step) => step.stepType === "tool_call" && step.name === "agent.await")).toBe(true);
  });

  it("runs an action command and stores the result on the run", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_action",
      name: "action-workspace",
      rootPath: "/tmp/action-workspace",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {},
      actions: {
        "debug.echo": {
          name: "debug.echo",
          description: "Echo text",
          callableByApi: true,
          callableByUser: true,
          exposeToLlm: false,
          directory: "/tmp",
          entry: {
            command: "printf action-ok"
          }
        }
      },
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_action",
        agents: [],
        models: [],
        actions: [
          {
            name: "debug.echo",
            description: "Echo text",
            callableByApi: true,
            callableByUser: true,
            exposeToLlm: false
          }
        ],
        skills: [],
        mcp: [],
        hooks: [],
        nativeTools: []
      }
    });

    const accepted = await runtimeService.triggerActionRun({
      workspaceId: "project_action",
      actionName: "debug.echo",
      caller: {
        subjectRef: "dev:test",
        authSource: "standalone_server",
        scopes: [],
        workspaceAccess: []
      }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    const run = await runtimeService.getRun(accepted.runId);
    expect(run.metadata).toMatchObject({
      actionName: "debug.echo",
      stdout: "action-ok"
    });

    const runSteps = await runtimeService.listRunSteps(accepted.runId);
    expect(runSteps.items.some((step) => step.stepType === "tool_call" && step.name === "debug.echo")).toBe(true);
    expect(runSteps.items.some((step) => step.stepType === "system" && step.name === "run.completed")).toBe(true);
  });

  it("resolves workspace model refs for agent execution", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_workspace_model",
      name: "workspace-model",
      rootPath: "/tmp/workspace-model",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "writer",
      settings: {
        defaultAgent: "writer",
        skillDirs: []
      },
      workspaceModels: {
        "repo-model": {
          provider: "openai",
          name: "gpt-4.1-mini"
        }
      },
      agents: {
        writer: {
          name: "writer",
          mode: "primary",
          prompt: "Use the repo model.",
          modelRef: "workspace/repo-model",
          tools: {
            native: [],
            actions: [],
            skills: [],
            mcp: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_workspace_model",
        agents: [{ name: "writer", source: "workspace" }],
        models: [
          {
            ref: "workspace/repo-model",
            name: "repo-model",
            source: "workspace",
            provider: "openai",
            modelName: "gpt-4.1-mini"
          }
        ],
        actions: [],
        skills: [],
        mcp: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_workspace_model",
      caller,
      input: {}
    });

    await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "hello" }
    });

    await waitFor(() => gateway.invocations.length > 0);

    expect(gateway.invocations.at(0)?.model).toBe("workspace/repo-model");
    expect(gateway.invocations.at(0)?.input.modelDefinition).toMatchObject({
      provider: "openai",
      name: "gpt-4.1-mini"
    });
  });

  it("times out action runs with a terminal timed_out status", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_timeout_action",
      name: "timeout-action",
      rootPath: "/tmp/timeout-action",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {},
      actions: {
        "debug.sleep": {
          name: "debug.sleep",
          description: "Sleep too long",
          callableByApi: true,
          callableByUser: true,
          exposeToLlm: false,
          directory: "/tmp",
          entry: {
            command: "sleep 1",
            timeoutSeconds: 0.01
          }
        }
      },
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_timeout_action",
        agents: [],
        models: [],
        actions: [
          {
            name: "debug.sleep",
            description: "Sleep too long",
            callableByApi: true,
            callableByUser: true,
            exposeToLlm: false
          }
        ],
        skills: [],
        mcp: [],
        hooks: [],
        nativeTools: []
      }
    });

    const accepted = await runtimeService.triggerActionRun({
      workspaceId: "project_timeout_action",
      actionName: "debug.sleep",
      caller: {
        subjectRef: "dev:test",
        authSource: "standalone_server",
        scopes: [],
        workspaceAccess: []
      }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "timed_out";
    });

    await expect(runtimeService.cancelRun(accepted.runId)).resolves.toEqual({
      runId: accepted.runId,
      status: "cancellation_requested"
    });

    const runSteps = await runtimeService.listRunSteps(accepted.runId);
    expect(runSteps.items.some((step) => step.stepType === "tool_call" && step.name === "debug.sleep")).toBe(true);
    expect(runSteps.items.find((step) => step.name === "debug.sleep")?.status).toBe("failed");
    expect(runSteps.items.some((step) => step.stepType === "system" && step.name === "run.timed_out")).toBe(true);
  });

  it("enforces agent run_timeout_seconds with a terminal timed_out status", async () => {
    const gateway = new FakeModelGateway(40);
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_run_timeout_policy",
      name: "run-timeout-policy",
      rootPath: "/tmp/run-timeout-policy",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Be quick.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            mcp: []
          },
          switch: [],
          subagents: [],
          policy: {
            runTimeoutSeconds: 0.02
          }
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_run_timeout_policy",
        agents: [{ name: "builder", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        mcp: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_run_timeout_policy",
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "This response should time out." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "timed_out";
    });

    await waitFor(async () => {
      const events = await runtimeService.listSessionEvents(session.id, undefined, accepted.runId);
      return events.some((event) => event.event === "run.failed");
    });

    const run = await runtimeService.getRun(accepted.runId);
    expect(run.errorCode).toBe("run_timed_out");

    const events = await runtimeService.listSessionEvents(session.id, undefined, accepted.runId);
    expect(events.find((event) => event.event === "run.failed")?.data).toMatchObject({
      status: "timed_out",
      errorCode: "run_timed_out"
    });

    const runSteps = await runtimeService.listRunSteps(accepted.runId);
    expect(runSteps.items.some((step) => step.stepType === "model_call" && step.status === "failed")).toBe(true);
    expect(runSteps.items.some((step) => step.stepType === "system" && step.name === "run.timed_out")).toBe(true);
  });

  it("enforces agent tool_timeout_seconds for native tools", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "oah-tool-timeout-"));
    const gateway = new FakeModelGateway();
    gateway.streamScenarioFactory = () => ({
      toolSteps: [
        {
          toolName: "shell.exec",
          input: {
            command: "sleep 1"
          },
          toolCallId: "call_shell_timeout"
        }
      ]
    });

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_tool_timeout_policy",
      name: "tool-timeout-policy",
      rootPath: workspaceRoot,
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Use the shell tool when needed.",
          tools: {
            native: ["shell.exec"],
            actions: [],
            skills: [],
            mcp: []
          },
          switch: [],
          subagents: [],
          policy: {
            toolTimeoutSeconds: 0.01
          }
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_tool_timeout_policy",
        agents: [{ name: "builder", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        mcp: [],
        hooks: [],
        nativeTools: ["shell.exec"]
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_tool_timeout_policy",
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Run the shell command." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "failed";
    });

    const events = await runtimeService.listSessionEvents(session.id, undefined, accepted.runId);
    expect(events.map((event) => event.event)).toEqual(expect.arrayContaining(["tool.started", "tool.failed", "run.failed"]));
    expect(events.find((event) => event.event === "tool.failed")?.data).toMatchObject({
      toolCallId: "call_shell_timeout",
      toolName: "shell.exec",
      sourceType: "native",
      errorCode: "tool_timed_out"
    });

    const runSteps = await runtimeService.listRunSteps(accepted.runId);
    expect(runSteps.items.find((step) => step.name === "shell.exec")?.status).toBe("failed");
    expect(runSteps.items.find((step) => step.name === "shell.exec")?.output).toMatchObject({
      errorCode: "tool_timed_out"
    });
  });

  it("persists heartbeatAt while a run is active", async () => {
    const gateway = new FakeModelGateway(120);
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      runHeartbeatIntervalMs: 30,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_run_heartbeat",
      name: "run-heartbeat",
      rootPath: "/tmp/run-heartbeat",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Reply slowly.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            mcp: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_run_heartbeat",
        agents: [{ name: "builder", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        mcp: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_run_heartbeat",
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Please answer." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return typeof run.startedAt === "string" && typeof run.heartbeatAt === "string" && run.heartbeatAt > run.startedAt;
    });

    const activeRun = await runtimeService.getRun(accepted.runId);
    expect(activeRun.heartbeatAt).toBeDefined();

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    const completedRun = await runtimeService.getRun(accepted.runId);
    expect(completedRun.heartbeatAt).toBeDefined();
  });

  it("recovers stale active runs as failed", async () => {
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: new FakeModelGateway(),
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_run_recovery",
      name: "run-recovery",
      rootPath: "/tmp/run-recovery",
      executionPolicy: "local",
      status: "active",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Recover stale runs safely.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            mcp: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_run_recovery",
        agents: [{ name: "builder", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        mcp: [],
        hooks: [],
        nativeTools: []
      }
    });

    await persistence.sessionRepository.create({
      id: "ses_recovery",
      workspaceId: "project_run_recovery",
      subjectRef: "dev:test",
      activeAgentName: "builder",
      status: "active",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z"
    });

    await persistence.runRepository.create({
      id: "run_stale",
      workspaceId: "project_run_recovery",
      sessionId: "ses_recovery",
      initiatorRef: "dev:test",
      triggerType: "message",
      triggerRef: "msg_1",
      agentName: "builder",
      effectiveAgentName: "builder",
      switchCount: 0,
      status: "running",
      createdAt: "2026-04-01T00:00:00.000Z",
      startedAt: "2026-04-01T00:00:10.000Z",
      heartbeatAt: "2026-04-01T00:00:20.000Z"
    });

    await persistence.runRepository.create({
      id: "run_recent",
      workspaceId: "project_run_recovery",
      sessionId: "ses_recovery",
      initiatorRef: "dev:test",
      triggerType: "message",
      triggerRef: "msg_2",
      agentName: "builder",
      effectiveAgentName: "builder",
      switchCount: 0,
      status: "waiting_tool",
      createdAt: "2026-04-01T00:00:00.000Z",
      startedAt: "2026-04-01T00:00:30.000Z",
      heartbeatAt: "2026-04-01T00:00:55.000Z"
    });

    const recovered = await runtimeService.recoverStaleRuns({
      staleBefore: "2026-04-01T00:00:40.000Z"
    });

    expect(recovered.recoveredRunIds).toEqual(["run_stale"]);

    const staleRun = await runtimeService.getRun("run_stale");
    expect(staleRun.status).toBe("failed");
    expect(staleRun.errorCode).toBe("worker_recovery_failed");
    expect(staleRun.endedAt).toBeDefined();

    const recentRun = await runtimeService.getRun("run_recent");
    expect(recentRun.status).toBe("waiting_tool");

    const events = await runtimeService.listSessionEvents("ses_recovery", undefined, "run_stale");
    expect(events.find((event) => event.event === "run.failed")?.data).toMatchObject({
      status: "failed",
      errorCode: "worker_recovery_failed",
      recoveredBy: "worker_startup"
    });

    const runSteps = await runtimeService.listRunSteps("run_stale");
    expect(runSteps.items.some((step) => step.stepType === "system" && step.name === "run.failed")).toBe(true);
  });

  it("keeps runs in waiting_tool until all parallel tool calls finish", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "oah-parallel-tools-"));
    const gateway = new FakeModelGateway();
    gateway.streamScenarioFactory = () => ({
      toolBatches: [
        [
          {
            toolName: "file.list",
            input: {
              path: "."
            },
            toolCallId: "call_list_fast",
            delayMs: 150
          },
          {
            toolName: "file.list",
            input: {
              path: "."
            },
            toolCallId: "call_list_slow",
            delayMs: 450
          }
        ]
      ]
    });

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_parallel_tools",
      name: "parallel-tools",
      rootPath: workspaceRoot,
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Use file.list when needed.",
          tools: {
            native: ["file.list"],
            actions: [],
            skills: [],
            mcp: []
          },
          switch: [],
          subagents: [],
          policy: {
            parallelToolCalls: true
          }
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_parallel_tools",
        agents: [{ name: "builder", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        mcp: [],
        hooks: [],
        nativeTools: ["file.list"]
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_parallel_tools",
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "List the workspace twice." }
    });

    await waitFor(async () => {
      const events = await runtimeService.listSessionEvents(session.id, undefined, accepted.runId);
      return events.filter((event) => event.event === "tool.completed").length === 1;
    });

    const inFlightRun = await runtimeService.getRun(accepted.runId);
    expect(inFlightRun.status).toBe("waiting_tool");

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    expect(gateway.maxConcurrentToolExecutions).toBeGreaterThan(1);
  });

  it("respects agent parallel_tool_calls false by serializing tool batches", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "oah-serial-tools-"));
    const gateway = new FakeModelGateway();
    gateway.streamScenarioFactory = () => ({
      toolBatches: [
        [
          {
            toolName: "file.list",
            input: {
              path: "."
            },
            toolCallId: "call_list_one",
            delayMs: 120
          },
          {
            toolName: "file.list",
            input: {
              path: "."
            },
            toolCallId: "call_list_two",
            delayMs: 120
          }
        ]
      ]
    });

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_serial_tools",
      name: "serial-tools",
      rootPath: workspaceRoot,
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Use file.list when needed.",
          tools: {
            native: ["file.list"],
            actions: [],
            skills: [],
            mcp: []
          },
          switch: [],
          subagents: [],
          policy: {
            parallelToolCalls: false
          }
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_serial_tools",
        agents: [{ name: "builder", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        mcp: [],
        hooks: [],
        nativeTools: ["file.list"]
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_serial_tools",
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "List the workspace twice." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    expect(gateway.maxConcurrentToolExecutions).toBe(1);
  });

  it("composes system prompts with llm-optimized prompt, actions catalog, skills catalog, and environment summary", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      platformModels: {
        "openai-default": {
          provider: "openai",
          name: "gpt-4o-mini"
        }
      },
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_prompt_compose",
      name: "prompt-compose",
      rootPath: "/tmp/prompt-compose",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: [],
        systemPrompt: {
          base: {
            content: "Workspace base prompt."
          },
          llmOptimized: {
            models: {
              "platform/openai-default": {
                content: "Model-specific guidance."
              }
            }
          },
          compose: {
            order: ["base", "llm_optimized", "agent", "actions", "skills", "project_agents_md"],
            includeEnvironment: true
          }
        }
      },
      projectAgentsMd: "Repository conventions live here.",
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "You are the builder.",
          tools: {
            native: [],
            actions: [],
            skills: ["repo-explorer"],
            mcp: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {
        "debug.echo": {
          name: "debug.echo",
          description: "Echo",
          callableByApi: true,
          callableByUser: true,
          exposeToLlm: true,
          directory: "/tmp",
          entry: {
            command: "printf ok"
          }
        }
      },
      skills: {
        "repo-explorer": {
          name: "repo-explorer",
          description: "Explore the repository.",
          exposeToLlm: true,
          directory: "/tmp/repo-explorer",
          sourceRoot: "/tmp",
          content: "# Repo Explorer"
        }
      },
      toolServers: {
        "docs-server": {
          name: "docs-server",
          enabled: true,
          transportType: "stdio"
        }
      },
      hooks: {},
      catalog: {
        workspaceId: "project_prompt_compose",
        agents: [{ name: "builder", source: "workspace" }],
        models: [{ ref: "platform/openai-default", name: "openai-default", source: "platform", provider: "openai" }],
        actions: [{ name: "debug.echo", description: "Echo", callableByApi: true, callableByUser: true, exposeToLlm: true }],
        skills: [{ name: "repo-explorer", description: "Explore the repository.", exposeToLlm: true }],
        mcp: [{ name: "docs-server", transportType: "stdio" }],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_prompt_compose",
      caller,
      input: {}
    });

    await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "ship it" }
    });

    await waitFor(() => gateway.invocations.length > 0);
    const systemMessages = gateway.invocations.at(0)?.input.messages?.filter((message) => message.role === "system") ?? [];

    expect(systemMessages.map((message) => message.content)).toEqual(
      expect.arrayContaining([
        "Workspace base prompt.",
        "Model-specific guidance.",
        "You are the builder.",
        "Repository conventions live here.",
        expect.stringContaining("<available_actions>"),
        expect.stringContaining("call `run_action`"),
        expect.stringContaining("<available_skills>"),
        expect.stringContaining("call `activate_skill`"),
        expect.stringContaining("available_actions: debug.echo"),
        expect.stringContaining("available_skills: repo-explorer"),
        expect.stringContaining("available_tool_servers: docs-server")
      ])
    );

    const actionMessageIndex = systemMessages.findIndex((message) => message.content.includes("<available_actions>"));
    const skillsMessageIndex = systemMessages.findIndex((message) => message.content.includes("<available_skills>"));
    const agentsMessageIndex = systemMessages.findIndex((message) => message.content === "Repository conventions live here.");

    expect(actionMessageIndex).toBeGreaterThan(-1);
    expect(skillsMessageIndex).toBeGreaterThan(-1);
    expect(agentsMessageIndex).toBeGreaterThan(-1);
    expect(actionMessageIndex).toBeLessThan(skillsMessageIndex);
    expect(skillsMessageIndex).toBeLessThan(agentsMessageIndex);
  });

  it("activates skills through tool calls and persists tool messages before the final assistant reply", async () => {
    const skillRoot = await mkdtemp(path.join(tmpdir(), "oah-skill-"));
    const skillDirectory = path.join(skillRoot, "repo-explorer");
    await mkdir(path.join(skillDirectory, "references"), { recursive: true });
    await writeFile(path.join(skillDirectory, "references", "guide.md"), "# Repo Guide\nUse ripgrep first.\n", "utf8");

    const gateway = new FakeModelGateway();
    gateway.streamScenarioFactory = () => ({
      text: "I loaded the repo-explorer skill and its guide.",
      toolSteps: [
        {
          toolName: "activate_skill",
          input: { name: "repo-explorer" },
          toolCallId: "call_activate"
        },
        {
          toolName: "activate_skill",
          input: { name: "repo-explorer", resource_path: "references/guide.md" },
          toolCallId: "call_resource"
        }
      ]
    });

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_skill_activation",
      name: "skill-activation",
      rootPath: skillRoot,
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: [skillRoot]
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Use repo skills when needed.",
          tools: {
            native: [],
            actions: [],
            skills: ["repo-explorer"],
            mcp: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {
        "repo-explorer": {
          name: "repo-explorer",
          description: "Explore repository structure and helper docs.",
          exposeToLlm: true,
          directory: skillDirectory,
          sourceRoot: skillRoot,
          content: "# Repo Explorer\n\nStart with a quick tree and then inspect focused files."
        }
      },
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_skill_activation",
        agents: [{ name: "builder", source: "workspace" }],
        models: [],
        actions: [],
        skills: [{ name: "repo-explorer", description: "Explore repository structure and helper docs.", exposeToLlm: true }],
        mcp: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_skill_activation",
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Figure out how to explore the repo safely." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    const messages = await runtimeService.listSessionMessages(session.id, 20);
    expect(messages.items.map((message) => message.role)).toEqual(["user", "tool", "tool", "assistant"]);

    const activationMessage = messages.items[1];
    expect(activationMessage.toolName).toBe("activate_skill");
    expect(activationMessage.toolCallId).toBe("call_activate");
    expect(activationMessage.content).toContain("<skill_content name=\"repo-explorer\">");
    expect(activationMessage.content).toContain("<skill_resources>");
    expect(activationMessage.content).toContain("references/guide.md");

    const resourceMessage = messages.items[2];
    expect(resourceMessage.toolName).toBe("activate_skill");
    expect(resourceMessage.toolCallId).toBe("call_resource");
    expect(resourceMessage.content).toContain("<skill_resource name=\"repo-explorer\" path=\"references/guide.md\">");
    expect(resourceMessage.content).toContain("Use ripgrep first.");

    const assistantMessage = messages.items[3];
    expect(assistantMessage.content).toBe("I loaded the repo-explorer skill and its guide.");

    const events = await runtimeService.listSessionEvents(session.id, undefined, accepted.runId);
    expect(events.filter((event) => event.event === "tool.started")).toHaveLength(2);
    expect(events.filter((event) => event.event === "tool.completed")).toHaveLength(2);
    expect(events.find((event) => event.event === "tool.started")?.data).toMatchObject({
      toolName: "activate_skill",
      sourceType: "skill"
    });
    expect(events.find((event) => event.event === "tool.completed")?.data).toMatchObject({
      toolName: "activate_skill",
      sourceType: "skill"
    });
    expect(events.filter((event) => event.event === "message.completed")).toHaveLength(3);

    const runSteps = await runtimeService.listRunSteps(accepted.runId);
    const modelCallSteps = runSteps.items.filter((step) => step.stepType === "model_call");
    expect(modelCallSteps).toHaveLength(3);
    expect(modelCallSteps.every((step) => step.status === "completed")).toBe(true);
    expect(modelCallSteps.map((step) => step.name)).toEqual(["openai-default", "openai-default", "openai-default"]);
  });

  it("emits tool.failed when a tool execution throws and then fails the run", async () => {
    const gateway = new FakeModelGateway();
    gateway.streamScenarioFactory = () => ({
      toolSteps: [
        {
          toolName: "agent.await",
          input: {},
          toolCallId: "call_await_missing"
        }
      ]
    });

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_tool_failed",
      name: "tool-failed",
      rootPath: "/tmp/tool-failed",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "planner",
      settings: {
        defaultAgent: "planner",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        planner: {
          name: "planner",
          mode: "primary",
          prompt: "You are the planner.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            mcp: []
          },
          switch: [],
          subagents: ["researcher"]
        },
        researcher: {
          name: "researcher",
          mode: "subagent",
          prompt: "You are the researcher.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            mcp: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_tool_failed",
        agents: [
          { name: "planner", source: "workspace" },
          { name: "researcher", source: "workspace" }
        ],
        models: [],
        actions: [],
        skills: [],
        mcp: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_tool_failed",
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Wait for a child run that does not exist." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "failed";
    });

    const events = await runtimeService.listSessionEvents(session.id, undefined, accepted.runId);
    expect(events.map((event) => event.event)).toEqual(expect.arrayContaining(["tool.started", "tool.failed", "run.failed"]));
    expect(events.find((event) => event.event === "tool.failed")?.data).toMatchObject({
      toolCallId: "call_await_missing",
      toolName: "agent.await",
      sourceType: "agent",
      errorCode: "agent_await_no_children"
    });
  });

  it("runs actions through the built-in run_action tool and persists the tool result", async () => {
    const gateway = new FakeModelGateway();
    gateway.streamScenarioFactory = () => ({
      text: "I ran the debug.echo action.",
      toolSteps: [
        {
          toolName: "run_action",
          input: {
            name: "debug.echo",
            input: {
              mode: "quick"
            }
          },
          toolCallId: "call_action"
        }
      ]
    });

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_action_tool",
      name: "action-tool",
      rootPath: "/tmp/action-tool",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Use actions when helpful.",
          tools: {
            native: [],
            actions: ["debug.echo"],
            skills: [],
            mcp: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {
        "debug.echo": {
          name: "debug.echo",
          description: "Echo the provided mode.",
          callableByApi: true,
          callableByUser: true,
          exposeToLlm: true,
          retryPolicy: "safe",
          directory: "/tmp",
          entry: {
            command:
              "node -e \"const input = JSON.parse(process.env.OPENHARNESS_ACTION_INPUT || 'null'); process.stdout.write('mode:' + (input?.mode ?? 'none'));\""
          }
        }
      },
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_action_tool",
        agents: [{ name: "builder", source: "workspace" }],
        models: [],
        actions: [
          {
            name: "debug.echo",
            description: "Echo the provided mode.",
            callableByApi: true,
            callableByUser: true,
            exposeToLlm: true,
            retryPolicy: "safe"
          }
        ],
        skills: [],
        mcp: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_action_tool",
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Run the debug action." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    const page = await runtimeService.listSessionMessages(session.id, 20);
    expect(page.items.map((message) => message.role)).toEqual(["user", "tool", "assistant"]);
    expect(page.items[1]?.toolName).toBe("run_action");
    expect(page.items[1]?.toolCallId).toBe("call_action");
    expect(page.items[1]?.content).toContain('<action_result name="debug.echo" exit_code="0">');
    expect(page.items[1]?.content).toContain("mode:quick");
    expect(page.items[2]?.content).toBe("I ran the debug.echo action.");

    const events = await runtimeService.listSessionEvents(session.id, undefined, accepted.runId);
    expect(events.find((event) => event.event === "tool.started")?.data).toMatchObject({
      toolCallId: "call_action",
      toolName: "run_action",
      retryPolicy: "safe"
    });
    expect(events.find((event) => event.event === "tool.completed")?.data).toMatchObject({
      toolCallId: "call_action",
      toolName: "run_action",
      retryPolicy: "safe"
    });

    const runSteps = await runtimeService.listRunSteps(accepted.runId);
    expect(runSteps.items.find((step) => step.name === "run_action")?.input).toMatchObject({
      retryPolicy: "safe",
      input: {
        name: "debug.echo",
        input: {
          mode: "quick"
        }
      }
    });
  });

  it("projects native tool visibility per agent and exposes them in the workspace catalog", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_native_catalog",
      name: "native-catalog",
      rootPath: "/tmp/native-catalog",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: [],
        systemPrompt: {
          compose: {
            order: ["agent"],
            includeEnvironment: true
          }
        }
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Use native tools when helpful.",
          tools: {
            native: ["shell.exec", "file.read"],
            actions: [],
            skills: [],
            mcp: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_native_catalog",
        agents: [{ name: "builder", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        mcp: [],
        hooks: [],
        nativeTools: []
      }
    });

    const catalog = await runtimeService.getWorkspaceCatalog("project_native_catalog");
    expect(catalog.nativeTools).toEqual(["shell.exec", "file.read", "file.write", "file.list"]);

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_native_catalog",
      caller,
      input: {}
    });

    await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Inspect the workspace." }
    });

    await waitFor(() => gateway.invocations.length > 0);
    const systemMessages = gateway.invocations.at(0)?.input.messages?.filter((message) => message.role === "system") ?? [];
    const environmentMessage = systemMessages.find((message) => message.content.includes("<environment>"))?.content ?? "";

    expect(environmentMessage).toContain("available_native_tools: shell.exec, file.read");
    expect(environmentMessage).not.toContain("file.write");
    expect(environmentMessage).not.toContain("file.list");
  });

  it("executes native tools and persists their tool results", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "oah-native-tools-"));
    const gateway = new FakeModelGateway();
    gateway.streamScenarioFactory = () => ({
      text: "Native tools completed.",
      toolSteps: [
        {
          toolName: "file.write",
          input: {
            path: "notes/summary.txt",
            content: "hello native tools"
          },
          toolCallId: "call_file_write"
        },
        {
          toolName: "file.read",
          input: {
            path: "notes/summary.txt"
          },
          toolCallId: "call_file_read"
        },
        {
          toolName: "file.list",
          input: {
            path: "notes"
          },
          toolCallId: "call_file_list"
        },
        {
          toolName: "shell.exec",
          input: {
            command: "printf shell-ok"
          },
          toolCallId: "call_shell_exec"
        }
      ]
    });

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_native_tools",
      name: "native-tools",
      rootPath: workspaceRoot,
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Use native tools when useful.",
          tools: {
            native: ["file.write", "file.read", "file.list", "shell.exec"],
            actions: [],
            skills: [],
            mcp: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_native_tools",
        agents: [{ name: "builder", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        mcp: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_native_tools",
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Use the native tools." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    const writtenContent = await readFile(path.join(workspaceRoot, "notes", "summary.txt"), "utf8");
    expect(writtenContent).toBe("hello native tools");

    const page = await runtimeService.listSessionMessages(session.id, 20);
    expect(page.items.map((message) => message.toolName ?? message.role)).toEqual([
      "user",
      "file.write",
      "file.read",
      "file.list",
      "shell.exec",
      "assistant"
    ]);
    expect(page.items[1]?.content).toContain('<file_write path="notes/summary.txt"');
    expect(page.items[2]?.content).toContain("<file_read path=\"notes/summary.txt\">");
    expect(page.items[2]?.content).toContain("hello native tools");
    expect(page.items[3]?.content).toContain('<file_list path="notes" recursive="false">');
    expect(page.items[3]?.content).toContain('<file path="notes/summary.txt" />');
    expect(page.items[4]?.content).toContain("<shell_exec exit_code=\"0\">");
    expect(page.items[4]?.content).toContain("shell-ok");
    expect(page.items[5]?.content).toBe("Native tools completed.");

    const runSteps = await runtimeService.listRunSteps(accepted.runId);
    expect(runSteps.items.find((step) => step.name === "file.write")?.input).toMatchObject({
      retryPolicy: "manual"
    });
    expect(runSteps.items.find((step) => step.name === "file.read")?.input).toMatchObject({
      retryPolicy: "safe"
    });
    expect(runSteps.items.find((step) => step.name === "file.list")?.input).toMatchObject({
      retryPolicy: "safe"
    });
    expect(runSteps.items.find((step) => step.name === "shell.exec")?.input).toMatchObject({
      retryPolicy: "manual"
    });
  });

  it("writes hook and tool call audit records when hooks and actions run", async () => {
    const gateway = new FakeModelGateway();
    gateway.streamScenarioFactory = () => ({
      text: "Audit finished.",
      toolSteps: [
        {
          toolName: "run_action",
          input: {
            name: "debug.echo",
            input: {
              mode: "audit"
            }
          },
          toolCallId: "call_audit_action"
        }
      ]
    });

    const persistence = createMemoryRuntimePersistence();
    const recordedToolCalls: ToolCallAuditRecord[] = [];
    const recordedHookRuns: HookRunAuditRecord[] = [];
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence,
      toolCallAuditRepository: {
        async create(input) {
          recordedToolCalls.push(input);
          return input;
        }
      },
      hookRunAuditRepository: {
        async create(input) {
          recordedHookRuns.push(input);
          return input;
        }
      }
    });

    await persistence.workspaceRepository.upsert({
      id: "project_audit_records",
      name: "audit-records",
      rootPath: "/tmp",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Use the available action.",
          tools: {
            native: [],
            actions: ["debug.echo"],
            skills: [],
            mcp: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {
        "debug.echo": {
          name: "debug.echo",
          description: "Echo the provided mode for auditing.",
          callableByApi: true,
          callableByUser: true,
          exposeToLlm: true,
          retryPolicy: "safe",
          directory: "/tmp",
          entry: {
            command:
              "node -e \"const input = JSON.parse(process.env.OPENHARNESS_ACTION_INPUT || 'null'); process.stdout.write('audit:' + (input?.mode ?? 'none'));\""
          }
        }
      },
      skills: {},
      toolServers: {},
      hooks: {
        "rewrite-request": {
          name: "rewrite-request",
          events: ["before_model_call"],
          handlerType: "command",
          capabilities: ["rewrite_model_request"],
          definition: {
            handler: {
              type: "command",
              command:
                "cat >/dev/null; node -e 'process.stdout.write(JSON.stringify({hookSpecificOutput:{patch:{model_request:{temperature:0.4}}}}))'"
            }
          }
        }
      },
      catalog: {
        workspaceId: "project_audit_records",
        agents: [{ name: "builder", source: "workspace" }],
        models: [],
        actions: [
          {
            name: "debug.echo",
            description: "Echo the provided mode for auditing.",
            callableByApi: true,
            callableByUser: true,
            exposeToLlm: true,
            retryPolicy: "safe"
          }
        ],
        skills: [],
        mcp: [],
        hooks: [{ name: "rewrite-request", handlerType: "command", events: ["before_model_call"] }],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_audit_records",
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Please run the audit action." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    expect(recordedHookRuns.length).toBeGreaterThanOrEqual(1);
    expect(
      recordedHookRuns.find((record) => record.hookName === "rewrite-request" && record.eventName === "before_model_call")
    ).toMatchObject({
      hookName: "rewrite-request",
      eventName: "before_model_call",
      status: "completed",
      capabilities: ["rewrite_model_request"],
      patch: {
        model_request: {
          temperature: 0.4
        }
      }
    });

    expect(recordedToolCalls).toHaveLength(1);
    expect(recordedToolCalls[0]).toMatchObject({
      toolName: "run_action",
      sourceType: "action",
      status: "completed",
      request: {
        toolCallId: "call_audit_action",
        sourceType: "action",
        retryPolicy: "safe",
        input: {
          name: "debug.echo",
          input: {
            mode: "audit"
          }
        }
      }
    });
    expect(recordedToolCalls[0]?.response).toMatchObject({
      sourceType: "action",
      retryPolicy: "safe",
      output: {
        value: expect.stringContaining("audit:audit")
      }
    });
  });

  it("moves runs into waiting_tool while a model tool call is in flight", async () => {
    const skillRoot = await mkdtemp(path.join(tmpdir(), "oah-waiting-tool-"));
    const skillDirectory = path.join(skillRoot, "repo-explorer");
    await mkdir(skillDirectory, { recursive: true });

    const gateway = new FakeModelGateway();
    gateway.streamScenarioFactory = () => ({
      text: "Tool call finished.",
      toolSteps: [
        {
          toolName: "activate_skill",
          input: { name: "repo-explorer" },
          toolCallId: "call_wait",
          delayMs: 150
        }
      ]
    });

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_waiting_tool",
      name: "waiting-tool",
      rootPath: skillRoot,
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: [skillRoot]
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Use skills as needed.",
          tools: {
            native: [],
            actions: [],
            skills: ["repo-explorer"],
            mcp: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {
        "repo-explorer": {
          name: "repo-explorer",
          description: "Repository explorer",
          exposeToLlm: true,
          directory: skillDirectory,
          sourceRoot: skillRoot,
          content: "# Repo Explorer"
        }
      },
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "project_waiting_tool",
        agents: [{ name: "builder", source: "workspace" }],
        models: [],
        actions: [],
        skills: [{ name: "repo-explorer", description: "Repository explorer", exposeToLlm: true }],
        mcp: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "project_waiting_tool",
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Load the skill." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "waiting_tool";
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });
  });

  it("does not inject environment summaries for chat workspaces", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "chat_prompt_compose",
      name: "chat-prompt-compose",
      rootPath: "/tmp/chat-prompt-compose",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "chat",
      readOnly: true,
      historyMirrorEnabled: false,
      defaultAgent: "assistant",
      settings: {
        defaultAgent: "assistant",
        skillDirs: [],
        systemPrompt: {
          compose: {
            order: ["agent"],
            includeEnvironment: true
          }
        }
      },
      workspaceModels: {},
      agents: {
        assistant: {
          name: "assistant",
          mode: "primary",
          prompt: "You are a chat-only assistant.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            mcp: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "chat_prompt_compose",
        agents: [{ name: "assistant", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        mcp: [],
        hooks: [],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };

    const session = await runtimeService.createSession({
      workspaceId: "chat_prompt_compose",
      caller,
      input: {}
    });

    await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "hello" }
    });

    await waitFor(() => gateway.invocations.length > 0);
    const systemMessages = gateway.invocations.at(0)?.input.messages?.filter((message) => message.role === "system") ?? [];

    expect(systemMessages.map((message) => message.content)).toEqual(
      expect.arrayContaining(["You are a chat-only assistant."])
    );
    expect(systemMessages.some((message) => message.content.includes("<environment>"))).toBe(false);
  });

  it("disables execution-only capabilities for chat workspaces even when records are dirty", async () => {
    const gateway = new FakeModelGateway();
    let capturedToolNames: string[] = [];
    let capturedMcpNames: string[] = [];
    gateway.streamScenarioFactory = (_input, options) => {
      capturedToolNames = Object.keys(options?.tools ?? {});
      capturedMcpNames = (options?.toolServers ?? []).map((server) => server.name);
      return {
        text: "chat-only reply"
      };
    };

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "chat_locked_down",
      name: "chat-locked-down",
      rootPath: "/tmp/chat-locked-down",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "chat",
      readOnly: true,
      historyMirrorEnabled: false,
      defaultAgent: "assistant",
      settings: {
        defaultAgent: "assistant",
        skillDirs: [],
        systemPrompt: {
          compose: {
            order: ["agent", "actions", "skills"],
            includeEnvironment: true
          }
        }
      },
      workspaceModels: {},
      agents: {
        assistant: {
          name: "assistant",
          mode: "primary",
          prompt: "You are a chat-only assistant.",
          tools: {
            native: [],
            actions: ["dangerous.run"],
            skills: ["repo-explorer"],
            mcp: ["docs"]
          },
          switch: [],
          subagents: []
        }
      },
      actions: {
        "dangerous.run": {
          name: "dangerous.run",
          description: "Should never run inside chat workspaces.",
          callableByApi: true,
          callableByUser: true,
          exposeToLlm: true,
          directory: "/tmp/chat-locked-down/actions/dangerous.run",
          entry: {
            command: "printf unsafe"
          }
        }
      },
      skills: {
        "repo-explorer": {
          name: "repo-explorer",
          description: "Should never be exposed inside chat workspaces.",
          exposeToLlm: true,
          directory: "/tmp/chat-locked-down/skills/repo-explorer",
          sourceRoot: "/tmp/chat-locked-down/skills/repo-explorer",
          content: "# Repo Explorer"
        }
      },
      toolServers: {
        docs: {
          name: "docs",
          enabled: true,
          transportType: "http",
          url: "http://127.0.0.1:9123"
        }
      },
      hooks: {
        "rewrite-request": {
          name: "rewrite-request",
          events: ["before_model_call"],
          handlerType: "command",
          capabilities: ["rewrite_model_request"],
          definition: {
            handler: {
              type: "command",
              command:
                "cat >/dev/null; node -e 'process.stdout.write(JSON.stringify({systemMessage:\"Hook warning.\",hookSpecificOutput:{patch:{model_request:{temperature:0.9}}}}))'"
            }
          }
        }
      },
      catalog: {
        workspaceId: "chat_locked_down",
        agents: [{ name: "assistant", source: "workspace" }],
        models: [],
        actions: [{ name: "dangerous.run", callableByApi: true, callableByUser: true, exposeToLlm: true }],
        skills: [{ name: "repo-explorer", exposeToLlm: true }],
        mcp: [{ name: "docs", transportType: "http" }],
        hooks: [{ name: "rewrite-request", handlerType: "command", events: ["before_model_call"] }],
        nativeTools: ["shell"]
      }
    });

    const catalog = await runtimeService.getWorkspaceCatalog("chat_locked_down");
    expect(catalog.actions).toEqual([]);
    expect(catalog.skills).toEqual([]);
    expect(catalog.tools).toEqual([]);
    expect(catalog.hooks).toEqual([]);
    expect(catalog.nativeTools).toEqual([]);

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };
    const session = await runtimeService.createSession({
      workspaceId: "chat_locked_down",
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "hello" }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    const systemMessages = gateway.invocations.at(0)?.input.messages?.filter((message) => message.role === "system") ?? [];
    expect(systemMessages.map((message) => message.content)).toEqual(
      expect.arrayContaining(["You are a chat-only assistant."])
    );
    expect(systemMessages.some((message) => message.content.includes("<available_actions>"))).toBe(false);
    expect(systemMessages.some((message) => message.content.includes("<available_skills>"))).toBe(false);
    expect(systemMessages.some((message) => message.content.includes("Hook warning."))).toBe(false);
    expect(gateway.invocations.at(0)?.input.temperature).toBeUndefined();
    expect(capturedToolNames).toEqual([]);
    expect(capturedMcpNames).toEqual([]);

    const runSteps = await runtimeService.listRunSteps(accepted.runId);
    expect(runSteps.items.some((step) => step.stepType === "hook")).toBe(false);
    expect(runSteps.items.some((step) => step.stepType === "tool_call")).toBe(false);
  });

  it("applies before_model_call command hooks to patch request and inject context", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_before_hook",
      name: "before-hook",
      rootPath: "/tmp",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Hook-aware builder.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            mcp: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {
        "rewrite-request": {
          name: "rewrite-request",
          events: ["before_model_call"],
          handlerType: "command",
          capabilities: ["rewrite_model_request"],
          definition: {
            handler: {
              type: "command",
              command:
                "cat >/dev/null; node -e 'process.stdout.write(JSON.stringify({systemMessage:\"Hook warning.\",hookSpecificOutput:{additionalContext:\"Check secrets before answering.\",patch:{model_request:{temperature:0.7}}}}))'"
            }
          }
        }
      },
      catalog: {
        workspaceId: "project_before_hook",
        agents: [{ name: "builder", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        mcp: [],
        hooks: [{ name: "rewrite-request", handlerType: "command", events: ["before_model_call"] }],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };
    const session = await runtimeService.createSession({
      workspaceId: "project_before_hook",
      caller,
      input: {}
    });

    await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "hello" }
    });

    await waitFor(async () => {
      if (gateway.invocations.length > 0) {
        return true;
      }

      const runs = await runtimeService.listSessionEvents(session.id);
      return runs.some((event) => event.event === "run.failed");
    });
    const run = await runtimeService.listSessionEvents(session.id);
    const acceptedRunId = run.find((event) => event.event === "run.queued")?.runId;
    const runSteps = acceptedRunId ? await runtimeService.listRunSteps(acceptedRunId) : { items: [] };
    expect(runSteps.items.some((step) => step.stepType === "hook" && step.name === "rewrite-request")).toBe(true);
    expect(
      runSteps.items.find((step) => step.stepType === "hook" && step.name === "rewrite-request")?.status
    ).toBe("completed");
    expect(gateway.invocations.at(0)?.input.temperature).toBe(0.7);
    expect(gateway.invocations.at(0)?.input.messages?.some((message) => message.content === "Hook warning.")).toBe(true);
    expect(
      gateway.invocations.at(0)?.input.messages?.some((message) => message.content === "Check secrets before answering.")
    ).toBe(true);
  });

  it("treats command hook timeout_seconds as a non-blocking timeout and emits a notice", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_before_hook_timeout",
      name: "before-hook-timeout",
      rootPath: "/tmp",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Hook-timeout-aware builder.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            mcp: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {
        "slow-before-hook": {
          name: "slow-before-hook",
          events: ["before_model_call"],
          handlerType: "command",
          capabilities: ["rewrite_model_request"],
          definition: {
            handler: {
              type: "command",
              timeout_seconds: 1,
              command:
                "cat >/dev/null; node -e 'setTimeout(() => process.stdout.write(JSON.stringify({systemMessage:\"too late\"})), 2000)'"
            }
          }
        }
      },
      catalog: {
        workspaceId: "project_before_hook_timeout",
        agents: [{ name: "builder", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        mcp: [],
        hooks: [{ name: "slow-before-hook", handlerType: "command", events: ["before_model_call"] }],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };
    const session = await runtimeService.createSession({
      workspaceId: "project_before_hook_timeout",
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "hello" }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    }, 5_000);

    const events = await runtimeService.listSessionEvents(session.id, undefined, accepted.runId);
    const runSteps = await runtimeService.listRunSteps(accepted.runId);
    expect(runSteps.items.some((step) => step.stepType === "hook" && step.name === "slow-before-hook")).toBe(true);
    expect(runSteps.items.find((step) => step.stepType === "hook" && step.name === "slow-before-hook")?.status).toBe("failed");
    expect(events.find((event) => event.event === "hook.notice")?.data).toMatchObject({
      hookName: "slow-before-hook",
      eventName: "before_model_call",
      errorCode: "hook_execution_failed"
    });
    expect(gateway.invocations.at(0)?.input.messages?.some((message) => message.content === "too late")).toBe(false);
  });

  it("treats prompt hook timeout_seconds as a non-blocking timeout and emits a notice", async () => {
    const gateway = new FakeModelGateway();
    gateway.generateDelayMs = 2_000;
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_prompt_hook_timeout",
      name: "prompt-hook-timeout",
      rootPath: "/tmp",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Prompt-hook-timeout-aware builder.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            mcp: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {
        "slow-prompt-hook": {
          name: "slow-prompt-hook",
          events: ["after_model_call"],
          handlerType: "prompt",
          capabilities: ["rewrite_model_response"],
          definition: {
            handler: {
              type: "prompt",
              timeout_seconds: 1,
              prompt: {
                inline: "return a JSON patch"
              }
            }
          }
        }
      },
      catalog: {
        workspaceId: "project_prompt_hook_timeout",
        agents: [{ name: "builder", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        mcp: [],
        hooks: [{ name: "slow-prompt-hook", handlerType: "prompt", events: ["after_model_call"] }],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };
    const session = await runtimeService.createSession({
      workspaceId: "project_prompt_hook_timeout",
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "hello" }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    }, 5_000);

    const events = await runtimeService.listSessionEvents(session.id, undefined, accepted.runId);
    const runSteps = await runtimeService.listRunSteps(accepted.runId);
    const assistantMessages = await runtimeService.listSessionMessages(session.id, 50);

    expect(runSteps.items.find((step) => step.stepType === "hook" && step.name === "slow-prompt-hook")?.status).toBe("failed");
    expect(events.find((event) => event.event === "hook.notice")?.data).toMatchObject({
      hookName: "slow-prompt-hook",
      eventName: "after_model_call",
      errorCode: "hook_execution_failed"
    });
    expect(assistantMessages.items.find((message) => message.role === "assistant")?.content).toBe("reply:hello");
  });

  it("applies context build hooks before and after composing model messages", async () => {
    const gateway = new FakeModelGateway();
    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_context_hooks",
      name: "context-hooks",
      rootPath: "/tmp",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Context-aware builder.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            mcp: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {
        "rewrite-context": {
          name: "rewrite-context",
          events: ["before_context_build"],
          handlerType: "command",
          capabilities: ["rewrite_context"],
          definition: {
            handler: {
              type: "command",
              command:
                "cat >/dev/null; node -e 'process.stdout.write(JSON.stringify({hookSpecificOutput:{patch:{context:{messages:[{role:\"user\",content:\"rewritten hello\"}]}}}}))'"
            }
          }
        },
        "annotate-context": {
          name: "annotate-context",
          events: ["after_context_build"],
          handlerType: "command",
          capabilities: [],
          definition: {
            handler: {
              type: "command",
              command:
                "cat >/dev/null; node -e 'process.stdout.write(JSON.stringify({systemMessage:\"Context assembled.\"}))'"
            }
          }
        }
      },
      catalog: {
        workspaceId: "project_context_hooks",
        agents: [{ name: "builder", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        mcp: [],
        hooks: [
          { name: "rewrite-context", handlerType: "command", events: ["before_context_build"] },
          { name: "annotate-context", handlerType: "command", events: ["after_context_build"] }
        ],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };
    const session = await runtimeService.createSession({
      workspaceId: "project_context_hooks",
      caller,
      input: {}
    });

    await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "hello" }
    });

    await waitFor(() => gateway.invocations.length > 0);
    const messages = gateway.invocations.at(0)?.input.messages ?? [];
    const events = await runtimeService.listSessionEvents(session.id);
    const acceptedRunId = events.find((event) => event.event === "run.queued")?.runId;
    const runSteps = acceptedRunId ? await runtimeService.listRunSteps(acceptedRunId) : { items: [] };

    expect(messages.some((message) => message.role === "user" && message.content === "rewritten hello")).toBe(true);
    expect(messages.some((message) => message.role === "user" && message.content === "hello")).toBe(false);
    expect(messages.some((message) => message.role === "system" && message.content === "Context assembled.")).toBe(true);
    expect(runSteps.items.some((step) => step.stepType === "hook" && step.name === "rewrite-context")).toBe(true);
    expect(runSteps.items.some((step) => step.stepType === "hook" && step.name === "annotate-context")).toBe(true);
  });

  it("applies tool dispatch hooks to rewrite tool input and output", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "oah-tool-hooks-"));
    const actionDir = path.join(tempDir, "actions", "echo");
    await mkdir(actionDir, { recursive: true });
    await writeFile(
      path.join(actionDir, "echo-input.js"),
      'process.stdout.write(process.env.OPENHARNESS_ACTION_INPUT || "");',
      "utf8"
    );

    const gateway = new FakeModelGateway();
    gateway.streamScenarioFactory = () => ({
      text: "tool flow complete",
      toolSteps: [
        {
          toolName: "run_action",
          input: {
            name: "debug.echo",
            input: {
              message: "original"
            }
          },
          toolCallId: "call_tool"
        }
      ]
    });

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_tool_hooks",
      name: "tool-hooks",
      rootPath: tempDir,
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "Tool-aware builder.",
          tools: {
            native: [],
            actions: ["debug.echo"],
            skills: [],
            mcp: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {
        "debug.echo": {
          name: "debug.echo",
          description: "Echo action input",
          callableByApi: true,
          callableByUser: true,
          exposeToLlm: true,
          directory: actionDir,
          entry: {
            command: "node ./echo-input.js"
          }
        }
      },
      skills: {},
      toolServers: {},
      hooks: {
        "rewrite-tool-input": {
          name: "rewrite-tool-input",
          events: ["before_tool_dispatch"],
          matcher: "run_action",
          handlerType: "command",
          capabilities: ["rewrite_tool_request"],
          definition: {
            handler: {
              type: "command",
              command:
                "cat >/dev/null; node -e 'process.stdout.write(JSON.stringify({hookSpecificOutput:{patch:{tool_input:{input:{message:\"patched\"}}}}}))'"
            }
          }
        },
        "rewrite-tool-output": {
          name: "rewrite-tool-output",
          events: ["after_tool_dispatch"],
          matcher: "run_action",
          handlerType: "command",
          capabilities: ["rewrite_tool_response"],
          definition: {
            handler: {
              type: "command",
              command:
                "cat >/dev/null; node -e 'process.stdout.write(JSON.stringify({hookSpecificOutput:{patch:{tool_output:\"tool output patched\"}}}))'"
            }
          }
        }
      },
      catalog: {
        workspaceId: "project_tool_hooks",
        agents: [{ name: "builder", source: "workspace" }],
        models: [],
        actions: [
          {
            name: "debug.echo",
            description: "Echo action input",
            exposeToLlm: true,
            callableByUser: true,
            callableByApi: true
          }
        ],
        skills: [],
        mcp: [],
        hooks: [
          {
            name: "rewrite-tool-input",
            matcher: "run_action",
            handlerType: "command",
            events: ["before_tool_dispatch"]
          },
          {
            name: "rewrite-tool-output",
            matcher: "run_action",
            handlerType: "command",
            events: ["after_tool_dispatch"]
          }
        ],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };
    const session = await runtimeService.createSession({
      workspaceId: "project_tool_hooks",
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "Run the debug action." }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    const events = await runtimeService.listSessionEvents(session.id, undefined, accepted.runId);
    const messages = await runtimeService.listSessionMessages(session.id, 50);
    const runSteps = await runtimeService.listRunSteps(accepted.runId);
    const toolStarted = events.find((event) => event.event === "tool.started");
    const toolMessage = messages.items.find((message) => message.role === "tool");
    const toolStep = runSteps.items.find((step) => step.stepType === "tool_call" && step.name === "run_action");

    expect((toolStarted?.data.input as { input?: { message?: string } } | undefined)?.input?.message).toBe("patched");
    expect((toolStep?.input?.input as { input?: { message?: string } } | undefined)?.input?.message).toBe("patched");
    expect(toolMessage?.content).toBe("tool output patched");
    expect(runSteps.items.some((step) => step.stepType === "hook" && step.name === "rewrite-tool-input")).toBe(true);
    expect(runSteps.items.some((step) => step.stepType === "hook" && step.name === "rewrite-tool-output")).toBe(true);
  });

  it("applies after_model_call prompt hooks to rewrite model output", async () => {
    const gateway = new FakeModelGateway();
    gateway.generateResponseFactory = (input) => {
      const content = input.prompt ?? input.messages?.map((message) => message.content).join("\n") ?? "";
      if (!content.includes("rewrite-output")) {
        return undefined;
      }

      return {
        model: input.model ?? "openai-default",
        text: JSON.stringify({
          hookSpecificOutput: {
            patch: {
              model_response: {
                text: "hooked reply"
              }
            }
          }
        }),
        finishReason: "stop"
      };
    };

    const persistence = createMemoryRuntimePersistence();
    const runtimeService = new RuntimeService({
      defaultModel: "openai-default",
      modelGateway: gateway,
      ...persistence
    });

    await persistence.workspaceRepository.upsert({
      id: "project_after_hook",
      name: "after-hook",
      rootPath: "/tmp/after-hook",
      executionPolicy: "local",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      kind: "project",
      readOnly: false,
      historyMirrorEnabled: false,
      defaultAgent: "builder",
      settings: {
        defaultAgent: "builder",
        skillDirs: []
      },
      workspaceModels: {},
      agents: {
        builder: {
          name: "builder",
          mode: "primary",
          prompt: "After-hook builder.",
          tools: {
            native: [],
            actions: [],
            skills: [],
            mcp: []
          },
          switch: [],
          subagents: []
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {
        "rewrite-output": {
          name: "rewrite-output",
          events: ["after_model_call"],
          handlerType: "prompt",
          capabilities: ["rewrite_model_response"],
          definition: {
            handler: {
              type: "prompt",
              prompt: {
                inline: "rewrite-output"
              }
            }
          }
        }
      },
      catalog: {
        workspaceId: "project_after_hook",
        agents: [{ name: "builder", source: "workspace" }],
        models: [],
        actions: [],
        skills: [],
        mcp: [],
        hooks: [{ name: "rewrite-output", handlerType: "prompt", events: ["after_model_call"] }],
        nativeTools: []
      }
    });

    const caller = {
      subjectRef: "dev:test",
      authSource: "standalone_server",
      scopes: [],
      workspaceAccess: []
    };
    const session = await runtimeService.createSession({
      workspaceId: "project_after_hook",
      caller,
      input: {}
    });

    const accepted = await runtimeService.createSessionMessage({
      sessionId: session.id,
      caller,
      input: { content: "hello" }
    });

    await waitFor(async () => {
      const run = await runtimeService.getRun(accepted.runId);
      return run.status === "completed";
    });

    const runSteps = await runtimeService.listRunSteps(accepted.runId);
    expect(runSteps.items.some((step) => step.stepType === "hook" && step.name === "rewrite-output")).toBe(true);
    expect(
      runSteps.items.find((step) => step.stepType === "hook" && step.name === "rewrite-output")?.status
    ).toBe("completed");

    const page = await runtimeService.listSessionMessages(session.id, 50);
    expect(page.items.find((message) => message.role === "assistant")?.content).toBe("hooked reply");
  });
});
