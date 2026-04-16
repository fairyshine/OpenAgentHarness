import { describe, expect, it } from "vitest";

import type { ServerConfig } from "@oah/config";

import { createConfiguredSandboxHost } from "../apps/server/src/bootstrap/configured-sandbox-host.ts";

function buildConfig(overrides?: Partial<ServerConfig>): ServerConfig {
  return {
    server: {
      host: "127.0.0.1",
      port: 8787
    },
    storage: {},
    paths: {
      workspace_dir: "/tmp/workspaces",
      blueprint_dir: "/tmp/blueprints",
      model_dir: "/tmp/models",
      tool_dir: "/tmp/tools",
      skill_dir: "/tmp/skills"
    },
    llm: {
      default_model: "openai-default"
    },
    ...overrides
  };
}

function createFakeMaterializationManager() {
  return {
    diagnostics() {
      return {};
    },
    async acquireWorkspace() {
      throw new Error("not used in this test");
    },
    async refreshLeases() {
      return undefined;
    },
    async flushIdleCopies() {
      return [];
    },
    async evictIdleCopies() {
      return [];
    },
    async beginDrain() {
      return {
        drainStartedAt: "2026-04-16T00:00:00.000Z",
        flushed: [],
        evicted: []
      };
    },
    async close() {
      return undefined;
    }
  } as never;
}

describe("configured sandbox host", () => {
  it("uses the local self-hosted sandbox host by default", async () => {
    const host = await createConfiguredSandboxHost({
      config: buildConfig(),
      workspaceMaterializationManager: createFakeMaterializationManager()
    });

    expect(host?.providerKind).toBe("self_hosted");
  });

  it("can create a remote self-hosted sandbox host", async () => {
    const host = await createConfiguredSandboxHost({
      config: buildConfig({
        sandbox: {
          provider: "self_hosted",
          self_hosted: {
            base_url: "http://127.0.0.1:8788/internal/v1"
          }
        }
      })
    });

    expect(host?.providerKind).toBe("self_hosted");
  });

  it("can create an e2b sandbox host from config", async () => {
    const host = await createConfiguredSandboxHost({
      config: buildConfig({
        sandbox: {
          provider: "e2b",
          e2b: {
            base_url: "https://sandbox-gateway.example.com/internal/v1",
            api_key: "secret"
          }
        }
      })
    });

    expect(host?.providerKind).toBe("e2b");
  });

  it("requires a base url when e2b provider is selected", async () => {
    await expect(
      createConfiguredSandboxHost({
        config: buildConfig({
          sandbox: {
            provider: "e2b"
          }
        })
      })
    ).rejects.toThrow("sandbox.e2b.base_url is required");
  });
});
