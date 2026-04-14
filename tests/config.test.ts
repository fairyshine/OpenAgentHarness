import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildWorkspaceId,
  discoverWorkspace,
  discoverWorkspaces,
  initializeWorkspaceFromTemplate,
  listWorkspaceTemplates,
  loadPlatformModels,
  resolveWorkspaceCreationRoot,
  loadWorkspaceSettings,
  loadServerConfig
} from "@oah/config";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await import("node:fs/promises").then(({ rm }) => rm(dir, { recursive: true, force: true }));
    })
  );
});

describe("config loading", () => {
  it("loads server config, expands env vars, and resolves relative paths", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-config-"));
    tempDirs.push(tempDir);

    for (const dirName of ["workspaces", "chat", "templates", "models", "tools", "skills"]) {
      await mkdir(path.join(tempDir, dirName), { recursive: true });
    }

    process.env.DATABASE_URL = "postgres://local/test";
    process.env.REDIS_URL = "redis://local/0";

    const configPath = path.join(tempDir, "server.yaml");
    await writeFile(
      configPath,
      `
server:
  host: 127.0.0.1
  port: 8787
storage:
  postgres_url: \${env.DATABASE_URL}
  redis_url: \${env.REDIS_URL}
paths:
  workspace_dir: ./workspaces
  chat_dir: ./chat
  template_dir: ./templates
  model_dir: ./models
  tool_dir: ./tools
  skill_dir: ./skills
llm:
  default_model: openai-default
`,
      "utf8"
    );

    const config = await loadServerConfig(configPath);
    expect(config.storage.postgres_url).toBe("postgres://local/test");
    expect(config.paths.model_dir).toBe(path.join(tempDir, "models"));
    expect(config.paths.archive_dir).toBe(path.join(tempDir, "workspaces", ".openharness", "archives"));
    expect(config.llm.default_model).toBe("openai-default");
  });

  it("accepts an explicit archive_dir in server config", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-config-archive-dir-"));
    tempDirs.push(tempDir);

    for (const dirName of ["workspaces", "chat", "templates", "models", "tools", "skills", "archives"]) {
      await mkdir(path.join(tempDir, dirName), { recursive: true });
    }

    const configPath = path.join(tempDir, "server.yaml");
    await writeFile(
      configPath,
      `
server:
  host: 127.0.0.1
  port: 8787
storage: {}
paths:
  workspace_dir: ./workspaces
  chat_dir: ./chat
  template_dir: ./templates
  model_dir: ./models
  tool_dir: ./tools
  skill_dir: ./skills
  archive_dir: ./archives
llm:
  default_model: openai-default
`,
      "utf8"
    );

    const config = await loadServerConfig(configPath);
    expect(config.paths.archive_dir).toBe(path.join(tempDir, "archives"));
  });

  it("loads optional object storage settings for S3-compatible backends", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-config-object-storage-"));
    tempDirs.push(tempDir);

    for (const dirName of ["workspaces", "chat", "templates", "models", "tools", "skills", "archives"]) {
      await mkdir(path.join(tempDir, dirName), { recursive: true });
    }

    process.env.OAH_OBJECT_ACCESS_KEY = "demo-key";
    process.env.OAH_OBJECT_SECRET_KEY = "demo-secret";
    const configPath = path.join(tempDir, "server.yaml");
    await writeFile(
      configPath,
      `
server:
  host: 127.0.0.1
  port: 8787
storage: {}
object_storage:
  provider: s3
  bucket: open-agent-harness
  region: us-east-1
  endpoint: http://127.0.0.1:9000
  access_key: \${env.OAH_OBJECT_ACCESS_KEY}
  secret_key: \${env.OAH_OBJECT_SECRET_KEY}
  force_path_style: true
  sync_on_boot: true
  sync_on_change: true
  poll_interval_ms: 4000
  managed_paths:
    - workspace
    - chat
  key_prefixes:
    workspace: workspace
    chat: chat
paths:
  workspace_dir: ./workspaces
  chat_dir: ./chat
  template_dir: ./templates
  model_dir: ./models
  tool_dir: ./tools
  skill_dir: ./skills
  archive_dir: ./archives
llm:
  default_model: openai-default
`,
      "utf8"
    );

    const config = await loadServerConfig(configPath);
    expect(config.object_storage).toEqual({
      provider: "s3",
      bucket: "open-agent-harness",
      region: "us-east-1",
      endpoint: "http://127.0.0.1:9000",
      access_key: "demo-key",
      secret_key: "demo-secret",
      force_path_style: true,
      sync_on_boot: true,
      sync_on_change: true,
      poll_interval_ms: 4000,
      managed_paths: ["workspace", "chat"],
      key_prefixes: {
        workspace: "workspace",
        chat: "chat"
      }
    });
  });

  it("loads embedded worker pool settings from server config", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-config-workers-"));
    tempDirs.push(tempDir);

    for (const dirName of ["workspaces", "chat", "templates", "models", "tools", "skills"]) {
      await mkdir(path.join(tempDir, dirName), { recursive: true });
    }

    const configPath = path.join(tempDir, "server.yaml");
    await writeFile(
      configPath,
      `
server:
  host: 127.0.0.1
  port: 8787
storage:
  redis_url: redis://local/0
paths:
  workspace_dir: ./workspaces
  chat_dir: ./chat
  template_dir: ./templates
  model_dir: ./models
  tool_dir: ./tools
  skill_dir: ./skills
workers:
  embedded:
    min_count: 2
    max_count: 6
    scale_interval_ms: 1500
    idle_ttl_ms: 45000
    scale_up_window: 3
    scale_down_window: 4
    cooldown_ms: 2500
    reserved_capacity_for_subagent: 2
llm:
  default_model: openai-default
`,
      "utf8"
    );

    const config = await loadServerConfig(configPath);
    expect(config.workers?.embedded).toEqual({
      min_count: 2,
      max_count: 6,
      scale_interval_ms: 1500,
      idle_ttl_ms: 45000,
      scale_up_window: 3,
      scale_down_window: 4,
      cooldown_ms: 2500,
      reserved_capacity_for_subagent: 2
    });
  });

  it("requires model_dir and tool_dir in server config", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-config-missing-required-paths-"));
    tempDirs.push(tempDir);

    for (const dirName of ["workspaces", "chat", "templates", "models", "tools", "skills"]) {
      await mkdir(path.join(tempDir, dirName), { recursive: true });
    }

    const configPath = path.join(tempDir, "server.yaml");
    await writeFile(
      configPath,
      `
server:
  host: 127.0.0.1
  port: 8787
storage: {}
paths:
  workspace_dir: ./workspaces
  chat_dir: ./chat
  template_dir: ./templates
  skill_dir: ./skills
llm:
  default_model: openai-default
`,
      "utf8"
    );

    await expect(loadServerConfig(configPath)).rejects.toThrow(/required property/);
  });

  it("accepts server config without storage urls for local development", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-config-no-storage-"));
    tempDirs.push(tempDir);

    for (const dirName of ["workspaces", "chat", "templates", "models", "tools", "skills"]) {
      await mkdir(path.join(tempDir, dirName), { recursive: true });
    }

    const configPath = path.join(tempDir, "server.yaml");
    await writeFile(
      configPath,
      `
server:
  host: 127.0.0.1
  port: 8787
storage: {}
paths:
  workspace_dir: ./workspaces
  chat_dir: ./chat
  template_dir: ./templates
  model_dir: ./models
  tool_dir: ./tools
  skill_dir: ./skills
llm:
  default_model: openai-default
`,
      "utf8"
    );

    const config = await loadServerConfig(configPath);
    expect(config.storage).toEqual({});
    expect(config.paths.workspace_dir).toBe(path.join(tempDir, "workspaces"));
  });

  it("treats a commented-only storage block as empty storage", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-config-comment-only-storage-"));
    tempDirs.push(tempDir);

    for (const dirName of ["workspaces", "chat", "templates", "models", "tools", "skills"]) {
      await mkdir(path.join(tempDir, dirName), { recursive: true });
    }

    const configPath = path.join(tempDir, "server.yaml");
    await writeFile(
      configPath,
      `
server:
  host: 127.0.0.1
  port: 8787
storage:
  # postgres_url: \${env.DATABASE_URL}
  # redis_url: \${env.REDIS_URL}
paths:
  workspace_dir: ./workspaces
  chat_dir: ./chat
  template_dir: ./templates
  model_dir: ./models
  tool_dir: ./tools
  skill_dir: ./skills
llm:
  default_model: openai-default
`,
      "utf8"
    );

    const config = await loadServerConfig(configPath);
    expect(config.storage).toEqual({});
    expect(config.paths.tool_dir).toBe(path.join(tempDir, "tools"));
  });

  it("fails when an env placeholder cannot be resolved", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-config-missing-env-"));
    tempDirs.push(tempDir);

    const configPath = path.join(tempDir, "server.yaml");
    delete process.env.MISSING_DATABASE_URL;

    await writeFile(
      configPath,
      `
server:
  host: 127.0.0.1
  port: 8787
storage:
  postgres_url: \${env.MISSING_DATABASE_URL}
  redis_url: redis://local/0
paths:
  workspace_dir: ./workspaces
  chat_dir: ./chat
  template_dir: ./templates
  model_dir: ./models
  tool_dir: ./tools
  skill_dir: ./skills
llm:
  default_model: openai-default
`,
      "utf8"
    );

    await expect(loadServerConfig(configPath)).rejects.toThrow(/MISSING_DATABASE_URL/);
  });

  it("loads model files with env expansion", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-models-"));
    tempDirs.push(tempDir);

    process.env.OPENAI_API_KEY = "test-key";
    await writeFile(
      path.join(tempDir, "openai.yaml"),
      `
openai-default:
  provider: openai
  key: \${env.OPENAI_API_KEY}
  name: gpt-4o-mini
`,
      "utf8"
    );

    const models = await loadPlatformModels(tempDir);
    expect(models["openai-default"]).toMatchObject({
      provider: "openai",
      key: "test-key",
      name: "gpt-4o-mini"
    });
  });

  it("loads model files from nested directories under model_dir", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-models-nested-"));
    tempDirs.push(tempDir);

    await mkdir(path.join(tempDir, "openai"), { recursive: true });
    await mkdir(path.join(tempDir, "compatible", "vendor-a"), { recursive: true });
    await writeFile(
      path.join(tempDir, "openai", "default.yaml"),
      `
openai-default:
  provider: openai
  name: gpt-4o-mini
`,
      "utf8"
    );
    await writeFile(
      path.join(tempDir, "compatible", "vendor-a", "qwen.yaml"),
      `
compat-qwen-max:
  provider: openai-compatible
  name: qwen-max
  url: https://example.test/v1
`,
      "utf8"
    );

    const models = await loadPlatformModels(tempDir);
    expect(models).toMatchObject({
      "openai-default": {
        provider: "openai",
        name: "gpt-4o-mini"
      },
      "compat-qwen-max": {
        provider: "openai-compatible",
        name: "qwen-max",
        url: "https://example.test/v1"
      }
    });
  });

  it("defaults new workspace roots into workspace_dir using workspace id when provided", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-workspace-root-"));
    tempDirs.push(tempDir);

    const resolved = resolveWorkspaceCreationRoot({
      workspaceDir: path.join(tempDir, "workspaces"),
      name: "Demo App",
      workspaceId: "ws_demo123"
    });

    expect(resolved).toBe(path.join(tempDir, "workspaces", "ws_demo123"));
  });

  it("falls back to normalized workspace name when workspace id is absent", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-workspace-root-name-"));
    tempDirs.push(tempDir);

    const resolved = resolveWorkspaceCreationRoot({
      workspaceDir: path.join(tempDir, "workspaces"),
      name: "Demo App"
    });

    expect(resolved).toBe(path.join(tempDir, "workspaces", "demo-app"));
  });

  it("rejects rootPath that escapes workspace directory via absolute path", () => {
    expect(() =>
      resolveWorkspaceCreationRoot({
        workspaceDir: "/tmp/workspaces",
        name: "test",
        rootPath: "/etc"
      })
    ).toThrow(/outside the workspace directory/);
  });

  it("rejects rootPath that escapes workspace directory via traversal", () => {
    expect(() =>
      resolveWorkspaceCreationRoot({
        workspaceDir: "/tmp/workspaces",
        name: "test",
        rootPath: "../../etc"
      })
    ).toThrow(/outside the workspace directory/);
  });

  it("allows rootPath within workspace directory", () => {
    const resolved = resolveWorkspaceCreationRoot({
      workspaceDir: "/tmp/workspaces",
      name: "test",
      rootPath: "my-project"
    });
    expect(resolved).toBe("/tmp/workspaces/my-project");
  });

  it("lists workspace templates from template_dir direct subdirectories", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-templates-list-"));
    tempDirs.push(tempDir);

    await mkdir(path.join(tempDir, "workspace"), { recursive: true });
    await mkdir(path.join(tempDir, "chat-workspace"), { recursive: true });
    await writeFile(path.join(tempDir, "README.md"), "ignore", "utf8");

    const templates = await listWorkspaceTemplates(tempDir);
    expect(templates).toEqual([{ name: "chat-workspace" }, { name: "workspace" }]);
  });

  it("rejects unsupported platform prompt segments in compose order", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-settings-platform-segment-"));
    tempDirs.push(tempDir);

    await mkdir(path.join(tempDir, ".openharness"), { recursive: true });
    await writeFile(
      path.join(tempDir, ".openharness", "settings.yaml"),
      `
system_prompt:
  compose:
    order:
      - platform
      - base
`,
      "utf8"
    );

    await expect(loadWorkspaceSettings(tempDir)).rejects.toThrow(/system_prompt\/compose\/order/);
  });

  it("rejects legacy compose toggles for AGENTS.md and skills injection", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-settings-legacy-compose-toggles-"));
    tempDirs.push(tempDir);

    await mkdir(path.join(tempDir, ".openharness"), { recursive: true });
    await writeFile(
      path.join(tempDir, ".openharness", "settings.yaml"),
      `
system_prompt:
  compose:
    order:
      - base
      - project_agents_md
      - skills
    include_project_agents_md: false
    include_skills: false
`,
      "utf8"
    );

    await expect(loadWorkspaceSettings(tempDir)).rejects.toThrow(/compose must NOT have additional properties/);
  });

  it("defaults include_environment to false", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-settings-default-environment-"));
    tempDirs.push(tempDir);

    await mkdir(path.join(tempDir, ".openharness"), { recursive: true });
    await writeFile(
      path.join(tempDir, ".openharness", "settings.yaml"),
      `
system_prompt:
  compose:
    order:
      - base
`,
      "utf8"
    );

    const settings = await loadWorkspaceSettings(tempDir);
    expect(settings.systemPrompt?.compose.includeEnvironment).toBe(false);
  });

  it("accepts actions in compose order", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-settings-actions-segment-"));
    tempDirs.push(tempDir);

    await mkdir(path.join(tempDir, ".openharness"), { recursive: true });
    await writeFile(
      path.join(tempDir, ".openharness", "settings.yaml"),
      `
system_prompt:
  compose:
    order:
      - base
      - actions
      - skills
`,
      "utf8"
    );

    const settings = await loadWorkspaceSettings(tempDir);
    expect(settings.systemPrompt?.compose.order).toEqual(["base", "actions", "skills"]);
  });

  it("accepts agent switch, subagent, and environment segments in compose order", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-settings-agent-segments-"));
    tempDirs.push(tempDir);

    await mkdir(path.join(tempDir, ".openharness"), { recursive: true });
    await writeFile(
      path.join(tempDir, ".openharness", "settings.yaml"),
      `
system_prompt:
  compose:
    order:
      - base
      - agent_switches
      - subagents
      - environment
      - skills
    include_environment: true
`,
      "utf8"
    );

    const settings = await loadWorkspaceSettings(tempDir);
    expect(settings.systemPrompt?.compose.order).toEqual(["base", "agent_switches", "subagents", "environment", "skills"]);
    expect(settings.systemPrompt?.compose.includeEnvironment).toBe(true);
  });

  it("discovers project and chat workspaces with merged model catalogs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-discovery-"));
    tempDirs.push(tempDir);

    const workspaceDir = path.join(tempDir, "workspaces");
    const chatDir = path.join(tempDir, "chat");
    const modelsDir = path.join(tempDir, "models");
    const skillDir = path.join(tempDir, "skills");
    const toolDir = path.join(tempDir, "tools");
    const projectRoot = path.join(workspaceDir, "demo-app");
    const chatRoot = path.join(chatDir, "pair-mode");

    await mkdir(path.join(projectRoot, ".openharness", "models"), { recursive: true });
    await mkdir(path.join(projectRoot, ".openharness", "agents"), { recursive: true });
    await mkdir(path.join(projectRoot, ".openharness", "actions", "echo"), { recursive: true });
    await mkdir(path.join(projectRoot, ".openharness", "skills", "repo-explorer"), { recursive: true });
    await mkdir(path.join(projectRoot, ".openharness", "tools"), { recursive: true });
    await mkdir(path.join(projectRoot, ".openharness", "hooks"), { recursive: true });
    await mkdir(path.join(chatRoot, ".openharness", "models"), { recursive: true });
    await mkdir(modelsDir, { recursive: true });
    await mkdir(path.join(skillDir, "shared-skill"), { recursive: true });
    await mkdir(toolDir, { recursive: true });

    await writeFile(
      path.join(modelsDir, "platform.yaml"),
      `
openai-default:
  provider: openai
  name: gpt-4o-mini
`,
      "utf8"
    );

    await writeFile(
      path.join(projectRoot, ".openharness", "settings.yaml"),
      `
default_agent: builder
`,
      "utf8"
    );

    await writeFile(
      path.join(projectRoot, ".openharness", "models", "workspace.yaml"),
      `
repo-model:
  provider: openai
  name: gpt-4.1-mini
`,
      "utf8"
    );

    await writeFile(
      path.join(projectRoot, "AGENTS.md"),
      `
# Project Guide

Always run tests before finishing.
`,
      "utf8"
    );

    await writeFile(
      path.join(projectRoot, ".openharness", "agents", "builder.md"),
      `---
mode: primary
description: Build things
model:
  model_ref: platform/openai-default
tools:
  native:
    - Bash
policy:
  run_timeout_seconds: 120
  tool_timeout_seconds: 30
  parallel_tool_calls: false
  max_concurrent_subagents: 2
system_reminder: Stay in build mode.
---

# Builder

Make concrete code changes.
`,
      "utf8"
    );

    await writeFile(
      path.join(projectRoot, ".openharness", "actions", "echo", "ACTION.yaml"),
      `
name: debug.echo
description: Echo debug output
expose:
  to_llm: false
  callable_by_user: true
  callable_by_api: true
recovery:
  retry_policy: safe
entry:
  command: printf "action-ok"
`,
      "utf8"
    );

    await writeFile(
      path.join(projectRoot, ".openharness", "skills", "repo-explorer", "SKILL.md"),
      `---
name: repo-explorer
description: Explore repository structure.
---

# Repo Explorer

Read the repo and summarize it.
`,
      "utf8"
    );

    await writeFile(
      path.join(skillDir, "shared-skill", "SKILL.md"),
      `
# Shared Skill

Platform-provided helper.
`,
      "utf8"
    );

    await writeFile(
      path.join(projectRoot, ".openharness", "tools", "settings.yaml"),
      `
docs-server:
  command: node ./servers/docs.js
  enabled: true
  expose:
    tool_prefix: mcp.docs
`,
      "utf8"
    );

    await writeFile(
      path.join(toolDir, "settings.yaml"),
      `
shared-browser:
  url: https://example.com/mcp
  enabled: true
  expose:
    tool_prefix: mcp.browser
`,
      "utf8"
    );

    await writeFile(
      path.join(projectRoot, ".openharness", "hooks", "redact.yaml"),
      `
name: redact-secrets
events:
  - before_model_call
matcher: "platform/openai-default|workspace/repo-model"
handler:
  type: command
  command: node ./.openharness/hooks/scripts/redact.js
capabilities:
  - rewrite_model_request
`,
      "utf8"
    );

    await writeFile(
      path.join(chatRoot, ".openharness", "settings.yaml"),
      `
default_agent: assistant
`,
      "utf8"
    );

    const platformModels = await loadPlatformModels(modelsDir);
    const platformAgents = {
      assistant: {
        name: "assistant",
        mode: "primary" as const,
        description: "Platform assistant",
        prompt: "# Assistant\n\nHelp with general tasks.",
        modelRef: "platform/openai-default",
        tools: {
          native: [],
          actions: [],
          skills: [],
          external: []
        },
        switch: [],
        subagents: []
      }
    };
    const discovered = await discoverWorkspaces({
      paths: {
        workspace_dir: workspaceDir,
        chat_dir: chatDir,
        skill_dir: skillDir,
        tool_dir: toolDir
      },
      platformModels,
      platformAgents
    });

    expect(discovered).toHaveLength(2);

    const project = discovered.find((workspace) => workspace.kind === "project");
    const chat = discovered.find((workspace) => workspace.kind === "chat");

    expect(project).toMatchObject({
      id: buildWorkspaceId("project", "demo-app", path.join(workspaceDir, "demo-app")),
      name: "demo-app",
      defaultAgent: "builder",
      readOnly: false,
      projectAgentsMd: expect.stringContaining("Always run tests before finishing.")
    });
    expect(project?.agents.builder).toMatchObject({
      name: "builder",
      mode: "primary",
      description: "Build things",
      modelRef: "platform/openai-default",
      tools: {
        native: ["Bash"],
        external: []
      },
      policy: {
        runTimeoutSeconds: 120,
        toolTimeoutSeconds: 30,
        parallelToolCalls: false,
        maxConcurrentSubagents: 2
      }
    });
    expect(project?.agents.assistant).toBeUndefined();
    expect(project?.catalog.agents).toEqual([{ name: "builder", mode: "primary", source: "workspace", description: "Build things" }]);
    expect(project?.catalog.models.map((model) => model.ref)).toEqual(["platform/openai-default", "workspace/repo-model"]);
    expect(project?.workspaceModels["repo-model"]).toMatchObject({
      provider: "openai",
      name: "gpt-4.1-mini"
    });
    expect(project?.catalog.actions).toEqual([
      {
        name: "debug.echo",
        description: "Echo debug output",
        exposeToLlm: false,
        callableByUser: true,
        callableByApi: true,
        retryPolicy: "safe"
      }
    ]);
    expect(project?.catalog.skills).toEqual([
      {
        name: "repo-explorer",
        description: "Explore repository structure.",
        exposeToLlm: true
      }
    ]);
    expect(project?.catalog.tools).toEqual([
      {
        name: "docs-server",
        transportType: "stdio",
        toolPrefix: "mcp.docs"
      }
    ]);
    expect(project?.catalog.hooks).toEqual([
      {
        name: "redact-secrets",
        matcher: "platform/openai-default|workspace/repo-model",
        handlerType: "command",
        events: ["before_model_call"]
      }
    ]);
    expect(project?.actions["debug.echo"]).toMatchObject({
      name: "debug.echo",
      retryPolicy: "safe",
      directory: expect.stringContaining("/.openharness/actions/echo")
    });
    expect(project?.skills["repo-explorer"]).toMatchObject({
      name: "repo-explorer"
    });
    expect(project?.skills["shared-skill"]).toBeUndefined();
    expect(project?.toolServers["docs-server"]).toMatchObject({
      transportType: "stdio"
    });
    expect(project?.toolServers["shared-browser"]).toBeUndefined();
    expect(project?.hooks["redact-secrets"]).toMatchObject({
      handlerType: "command"
    });

    expect(chat).toMatchObject({
      id: buildWorkspaceId("chat", "pair-mode", path.join(chatDir, "pair-mode")),
      name: "pair-mode",
      defaultAgent: "assistant",
      readOnly: true
    });
    expect(chat?.agents.assistant).toMatchObject({
      name: "assistant",
      description: "Platform assistant"
    });
    expect(chat?.catalog.agents).toEqual([{ name: "assistant", mode: "primary", source: "platform", description: "Platform assistant" }]);
    expect(chat?.catalog.models.map((model) => model.ref)).toEqual(["platform/openai-default"]);
    expect(chat?.catalog.actions).toEqual([]);
    expect(chat?.catalog.skills).toEqual([]);
    expect(chat?.catalog.tools).toEqual([]);
    expect(chat?.catalog.hooks).toEqual([]);
  });

  it("discovers workspace-local model refs for a single workspace", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-discovery-model-ref-"));
    tempDirs.push(tempDir);

    await mkdir(path.join(tempDir, ".openharness", "models"), { recursive: true });
    await mkdir(path.join(tempDir, ".openharness", "agents"), { recursive: true });

    const platformModels = {
      "openai-default": {
        provider: "openai",
        name: "gpt-4o-mini"
      }
    };

    await writeFile(
      path.join(tempDir, ".openharness", "models", "workspace.yaml"),
      `
repo-model:
  provider: openai
  name: gpt-4.1-mini
`,
      "utf8"
    );

    await writeFile(
      path.join(tempDir, ".openharness", "agents", "writer.md"),
      `---
model:
  model_ref: workspace/repo-model
---

# Writer

Use the workspace model.
`,
      "utf8"
    );

    const workspace = await discoverWorkspace(tempDir, "project", {
      platformModels
    });

    expect(workspace.agents.writer.modelRef).toBe("workspace/repo-model");
    expect(workspace.workspaceModels["repo-model"]).toMatchObject({
      provider: "openai",
      name: "gpt-4.1-mini"
    });
  });

  it("parses extended agent config fields and omits hidden agents from the catalog", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-discovery-agent-fields-"));
    tempDirs.push(tempDir);

    await mkdir(path.join(tempDir, ".openharness", "agents"), { recursive: true });

    await writeFile(
      path.join(tempDir, ".openharness", "agents", "builder.md"),
      `---
description: Workspace builder
model:
  model_ref: platform/openai-default
  temperature: 0.2
  top_p: 0.85
  max_tokens: 512
background: true
color: amber
tools:
  native:
    - Bash
  external:
    - docs-server
actions:
  - debug.echo
skills:
  - repo-explorer
disallowed:
  tools:
    native:
      - WebFetch
    external:
      - shared-browser
  actions:
    - danger.delete
  skills:
    - secret-skill
---

# Builder

Use the extended workspace agent config.
`,
      "utf8"
    );

    await writeFile(
      path.join(tempDir, ".openharness", "agents", "shadow.md"),
      `---
mode: subagent
description: Hidden helper
hidden: true
---

# Shadow

Stay hidden from the catalog.
`,
      "utf8"
    );

    const workspace = await discoverWorkspace(tempDir, "project", {
      platformModels: {
        "openai-default": {
          provider: "openai",
          name: "gpt-4o-mini"
        }
      }
    });

    expect(workspace.agents.builder).toMatchObject({
      description: "Workspace builder",
      modelRef: "platform/openai-default",
      temperature: 0.2,
      topP: 0.85,
      maxTokens: 512,
      background: true,
      color: "amber",
      tools: {
        native: ["Bash"],
        external: ["docs-server"]
      },
      actions: ["debug.echo"],
      skills: ["repo-explorer"],
      disallowed: {
        tools: {
          native: ["WebFetch"],
          external: ["shared-browser"]
        },
        actions: ["danger.delete"],
        skills: ["secret-skill"]
      }
    });
    expect(workspace.agents.shadow?.hidden).toBe(true);
    expect(workspace.catalog.agents).toEqual([
      { name: "builder", mode: "primary", source: "workspace", description: "Workspace builder" }
    ]);
  });

  it("builds distinct discovered workspace ids for the same name under different roots", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-discovery-unique-id-"));
    tempDirs.push(tempDir);

    const firstRoot = path.join(tempDir, "workspaces-a", "demo-app");
    const secondRoot = path.join(tempDir, "workspaces-b", "demo-app");

    await Promise.all([
      mkdir(path.join(firstRoot, ".openharness"), { recursive: true }),
      mkdir(path.join(secondRoot, ".openharness"), { recursive: true })
    ]);

    const [first, second] = await Promise.all([
      discoverWorkspace(firstRoot, "project", { platformModels: {} }),
      discoverWorkspace(secondRoot, "project", { platformModels: {} })
    ]);

    expect(first.id).not.toBe(second.id);
    expect(first.id).toBe(buildWorkspaceId("project", "demo-app", firstRoot));
    expect(second.id).toBe(buildWorkspaceId("project", "demo-app", secondRoot));
  });

  it("ignores platform agents when the workspace declares local agents", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-discovery-platform-agent-"));
    tempDirs.push(tempDir);

    await mkdir(path.join(tempDir, ".openharness", "agents"), { recursive: true });
    await writeFile(
      path.join(tempDir, ".openharness", "settings.yaml"),
      `
default_agent: builder
`,
      "utf8"
    );

    const platformModels = {
      "openai-default": {
        provider: "openai",
        name: "gpt-4o-mini"
      }
    };

    const platformAgents = {
      assistant: {
        name: "assistant",
        mode: "primary" as const,
        description: "Platform assistant",
        prompt: "# Assistant\n\nHandle general help.",
        modelRef: "platform/openai-default",
        tools: {
          native: [],
          actions: [],
          skills: [],
          external: []
        },
        switch: [],
        subagents: []
      },
      builder: {
        name: "builder",
        mode: "primary" as const,
        description: "Platform builder",
        prompt: "# Builder\n\nPlatform implementation prompt.",
        modelRef: "platform/openai-default",
        tools: {
          native: [],
          actions: [],
          skills: [],
          external: []
        },
        switch: [],
        subagents: []
      }
    };

    await writeFile(
      path.join(tempDir, ".openharness", "agents", "builder.md"),
      `---
description: Workspace builder
model:
  model_ref: platform/openai-default
---

# Builder

Workspace implementation prompt.
`,
      "utf8"
    );

    const workspace = await discoverWorkspace(tempDir, "project", {
      platformModels,
      platformAgents
    });

    expect(workspace.defaultAgent).toBe("builder");
    expect(workspace.catalog.agents).toEqual([{ name: "builder", mode: "primary", source: "workspace", description: "Workspace builder" }]);
    expect(workspace.agents.assistant).toBeUndefined();
    expect(workspace.agents.builder).toMatchObject({
      description: "Workspace builder",
      prompt: "# Builder\n\nWorkspace implementation prompt."
    });
    expect(workspace.agents.builder.prompt).not.toContain("Platform implementation prompt.");
  });

  it("initializes a workspace from template_dir before overlaying user AGENTS, MCP, and skills", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-template-init-"));
    tempDirs.push(tempDir);

    const templateDir = path.join(tempDir, "templates");
    const platformToolDir = path.join(tempDir, "tools");
    const platformSkillDir = path.join(tempDir, "skills");
    const workspaceRoot = path.join(tempDir, "workspaces", "demo");
    const templateRoot = path.join(templateDir, "workspace");

    await mkdir(path.join(platformToolDir, "servers", "shared-browser"), { recursive: true });
    await mkdir(path.join(platformSkillDir, "shared-skill", "references"), { recursive: true });
    await mkdir(path.join(templateRoot, ".openharness", "tools"), { recursive: true });
    await mkdir(path.join(templateRoot, ".openharness", "skills", "repo-explorer"), { recursive: true });
    await mkdir(path.join(templateRoot, ".openharness", "agents"), { recursive: true });
    await mkdir(path.join(templateRoot, ".openharness", "models"), { recursive: true });

    await writeFile(path.join(templateRoot, "AGENTS.md"), "# Template Guide\n\nFollow template rules.\n", "utf8");
    await writeFile(
      path.join(templateRoot, ".openharness", "settings.yaml"),
      `default_agent: builder
template_imports:
  tools:
    - shared-browser
  skills:
    - shared-skill
`,
      "utf8"
    );
    await writeFile(
      path.join(templateRoot, ".openharness", "agents", "builder.md"),
      `---
model:
  model_ref: platform/openai-default
---

# Builder

Implement requested changes.
`,
      "utf8"
    );
    await writeFile(
      path.join(templateRoot, ".openharness", "models", "workspace.yaml"),
      `
repo-model:
  provider: openai
  name: gpt-4.1-mini
`,
      "utf8"
    );
    await writeFile(
      path.join(templateRoot, ".openharness", "tools", "settings.yaml"),
      `
docs-server:
  command: node ./servers/docs.js
  enabled: true
`,
      "utf8"
    );
    await writeFile(
      path.join(templateRoot, ".openharness", "skills", "repo-explorer", "SKILL.md"),
      `
# Template Skill

Explore the repository.
`,
      "utf8"
    );
    await writeFile(
      path.join(platformToolDir, "settings.yaml"),
      `
shared-browser:
  command: node ${path.join(platformToolDir, "shared-browser", "index.js")}
  enabled: true
`,
      "utf8"
    );
    await writeFile(
      path.join(platformToolDir, "servers", "shared-browser", "index.js"),
      "console.log('shared-browser');\n",
      "utf8"
    );
    await writeFile(
      path.join(platformSkillDir, "shared-skill", "SKILL.md"),
      `
# Shared Skill

Platform-provided helper.
`,
      "utf8"
    );
    await writeFile(
      path.join(platformSkillDir, "shared-skill", "references", "guide.md"),
      "Use the shared guide.\n",
      "utf8"
    );

    await initializeWorkspaceFromTemplate({
      templateDir,
      templateName: "workspace",
      rootPath: workspaceRoot,
      platformToolDir,
      platformSkillDir,
      agentsMd: "## User Rules\n\nAlways mention assumptions.",
      toolServers: {
        "docs-server": {
          url: "https://example.com/mcp",
          enabled: true
        },
        browser: {
          command: "node ./servers/browser.js",
          enabled: true
        }
      },
      skills: [
        {
          name: "repo-explorer",
          content: "# User Skill\n\nUse the user-provided exploration flow."
        }
      ]
    });

    const workspace = await discoverWorkspace(workspaceRoot, "project", {
      platformModels: {
        "openai-default": {
          provider: "openai",
          name: "gpt-4o-mini"
        }
      }
    });

    const agentsMd = await readFile(path.join(workspaceRoot, "AGENTS.md"), "utf8");

    expect(agentsMd).toContain("Follow template rules.");
    expect(agentsMd).toContain("Always mention assumptions.");
    expect(workspace.defaultAgent).toBe("builder");
    expect(workspace.toolServers["docs-server"]).toMatchObject({
      transportType: "http",
      url: "https://example.com/mcp"
    });
    expect(workspace.toolServers["shared-browser"]).toMatchObject({
      transportType: "stdio",
      command: "node ./.openharness/tools/servers/shared-browser/index.js",
      workingDirectory: workspaceRoot
    });
    expect(workspace.toolServers.browser).toMatchObject({
      transportType: "stdio",
      command: "node ./servers/browser.js",
      workingDirectory: workspaceRoot
    });
    expect(workspace.skills["shared-skill"]).toMatchObject({
      content: "# Shared Skill\n\nPlatform-provided helper."
    });
    expect(workspace.skills["repo-explorer"]).toMatchObject({
      content: "# User Skill\n\nUse the user-provided exploration flow."
    });
    expect(await readFile(path.join(workspaceRoot, ".openharness", "tools", "servers", "shared-browser", "index.js"), "utf8")).toContain(
      "shared-browser"
    );
    expect(await readFile(path.join(workspaceRoot, ".openharness", "skills", "shared-skill", "references", "guide.md"), "utf8")).toContain(
      "shared guide"
    );
  });

  it("does not duplicate workspace tool prefixes when imported commands are already workspace-relative", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-template-import-tool-command-"));
    tempDirs.push(tempDir);

    const templateDir = path.join(tempDir, "templates");
    const platformToolDir = path.join(tempDir, "tools");
    const workspaceRoot = path.join(tempDir, "workspaces", "demo");
    const templateRoot = path.join(templateDir, "workspace");

    await mkdir(path.join(templateRoot, ".openharness"), { recursive: true });
    await mkdir(path.join(platformToolDir, "servers", "test-echo"), { recursive: true });

    await writeFile(
      path.join(templateRoot, ".openharness", "settings.yaml"),
      `template_imports:
  tools:
    - test-echo
`,
      "utf8"
    );
    await writeFile(
      path.join(platformToolDir, "settings.yaml"),
      `
test-echo:
  command: python3 ./.openharness/tools/servers/test-echo/test_echo_mcp.py
  enabled: true
`,
      "utf8"
    );
    await writeFile(
      path.join(platformToolDir, "servers", "test-echo", "test_echo_mcp.py"),
      "print('echo')\n",
      "utf8"
    );

    await initializeWorkspaceFromTemplate({
      templateDir,
      templateName: "workspace",
      rootPath: workspaceRoot,
      platformToolDir
    });

    const workspace = await discoverWorkspace(workspaceRoot, "project", {
      platformModels: {}
    });

    expect(workspace.toolServers["test-echo"]).toMatchObject({
      transportType: "stdio",
      command: "python3 ./.openharness/tools/servers/test-echo/test_echo_mcp.py",
      workingDirectory: workspaceRoot
    });
  });
});
