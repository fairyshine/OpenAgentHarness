import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { bootstrapRuntime } from "../apps/server/src/bootstrap.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    })
  );
});

describe("bootstrap single workspace mode", () => {
  it("boots a single workspace directly from CLI flags without a server config file", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-single-workspace-"));
    tempDirs.push(tempDir);

    const workspaceRoot = path.join(tempDir, "repo");
    const modelsDir = path.join(tempDir, "models");
    await Promise.all([
      mkdir(path.join(workspaceRoot, ".openharness"), { recursive: true }),
      mkdir(modelsDir, { recursive: true })
    ]);

    await writeFile(path.join(workspaceRoot, ".openharness", "settings.yaml"), "default_agent: assistant\n", "utf8");
    await writeFile(
      path.join(modelsDir, "openai.yaml"),
      `
openai-default:
  provider: openai
  name: gpt-4o-mini
`,
      "utf8"
    );

    const runtime = await bootstrapRuntime({
      argv: ["--workspace", workspaceRoot, "--model-dir", modelsDir, "--default-model", "openai-default"],
      startWorker: false,
      processKind: "api"
    });

    try {
      expect(runtime.workspaceMode).toEqual({
        kind: "single",
        workspaceId: "project_repo",
        workspaceKind: "project",
        rootPath: workspaceRoot
      });
      expect(runtime.listWorkspaceTemplates).toBeUndefined();
      expect(runtime.importWorkspace).toBeUndefined();

      const workspacePage = await runtime.runtimeService.listWorkspaces(10);
      expect(workspacePage.items).toHaveLength(1);
      expect(workspacePage.items[0]).toMatchObject({
        id: "project_repo",
        rootPath: workspaceRoot,
        kind: "project"
      });
      expect(runtime.config.paths.model_dir).toBe(modelsDir);
      expect(runtime.config.llm.default_model).toBe("openai-default");
    } finally {
      await runtime.close();
    }
  });
});
