import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildWorkspaceId } from "@oah/config";

import { bootstrapRuntime } from "../apps/server/src/bootstrap.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    })
  );
});

describe("bootstrap platform agents", () => {
  it("injects built-in platform agents by default", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-bootstrap-platform-agents-"));
    tempDirs.push(tempDir);

    const workspaceDir = path.join(tempDir, "workspaces");
    const chatDir = path.join(tempDir, "chat");
    const templateDir = path.join(tempDir, "templates");
    const modelsDir = path.join(tempDir, "models");
    const toolDir = path.join(tempDir, "tools");
    const skillDir = path.join(tempDir, "skills");
    const projectRoot = path.join(workspaceDir, "demo-project");
    const chatRoot = path.join(chatDir, "pair-mode");

    await Promise.all([
      mkdir(workspaceDir, { recursive: true }),
      mkdir(chatDir, { recursive: true }),
      mkdir(templateDir, { recursive: true }),
      mkdir(modelsDir, { recursive: true }),
      mkdir(toolDir, { recursive: true }),
      mkdir(skillDir, { recursive: true }),
      mkdir(path.join(projectRoot, ".openharness"), { recursive: true }),
      mkdir(path.join(chatRoot, ".openharness"), { recursive: true })
    ]);

    await writeFile(
      path.join(tempDir, "server.yaml"),
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

    await writeFile(
      path.join(modelsDir, "openai.yaml"),
      `
openai-default:
  provider: openai
  name: gpt-4o-mini
`,
      "utf8"
    );

    await writeFile(path.join(projectRoot, ".openharness", "settings.yaml"), "default_agent: builder\n", "utf8");
    await writeFile(path.join(chatRoot, ".openharness", "settings.yaml"), "default_agent: assistant\n", "utf8");

    const runtime = await bootstrapRuntime({
      argv: ["--config", path.join(tempDir, "server.yaml")],
      startWorker: false,
      processKind: "api"
    });

    try {
      const project = await runtime.runtimeService.getWorkspaceRecord(buildWorkspaceId("project", "demo-project", projectRoot));
      const chat = await runtime.runtimeService.getWorkspaceRecord(buildWorkspaceId("chat", "pair-mode", chatRoot));

      expect(project.defaultAgent).toBe("builder");
      expect(project.catalog.agents).toEqual(
        expect.arrayContaining([
          { name: "assistant", mode: "primary", source: "platform", description: expect.any(String) },
          { name: "builder", mode: "primary", source: "platform", description: expect.any(String) }
        ])
      );
      expect(project.agents.builder.tools.native).toEqual([
        "Bash",
        "Read",
        "Write",
        "Edit",
        "Glob",
        "Grep",
        "WebFetch",
        "WebSearch",
        "TodoWrite"
      ]);
      expect(project.agents.assistant.switch).toEqual(["builder"]);
      expect(project.agents.builder.switch).toEqual(["assistant"]);

      expect(chat.defaultAgent).toBe("assistant");
      expect(chat.catalog.agents).toEqual(
        expect.arrayContaining([
          { name: "assistant", mode: "primary", source: "platform", description: expect.any(String) },
          { name: "builder", mode: "primary", source: "platform", description: expect.any(String) }
        ])
      );
    } finally {
      await runtime.close();
    }
  });
});
