import { describe, expect, it } from "vitest";

import type { ServerConfig } from "@oah/config";

import {
  createSandboxHostMaintenance,
  createSandboxWorkspaceActivityTracker,
  isRemoteSandboxProvider,
  resolveConfiguredSandboxProvider,
  resolveSandboxBootstrapPlan,
  resolveSandboxWorkspaceServicePlan
} from "../apps/server/src/bootstrap/configured-sandbox-services.ts";
import type { SandboxHost } from "../apps/server/src/bootstrap/sandbox-host.ts";

function buildConfig(overrides?: Partial<ServerConfig>): ServerConfig {
  return {
    server: {
      host: "127.0.0.1",
      port: 8787
    },
    storage: {},
    paths: {
      workspace_dir: "/tmp/workspaces",
      runtime_dir: "/tmp/runtimes",
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

function createSandboxHost(providerKind: SandboxHost["providerKind"]): SandboxHost {
  return {
    providerKind,
    workspaceCommandExecutor: {} as never,
    workspaceFileSystem: {} as never,
    workspaceExecutionProvider: {} as never,
    workspaceFileAccessProvider: {} as never,
    diagnostics() {
      return {
        provider: providerKind
      };
    },
    async maintain() {
      return undefined;
    },
    async beginDrain() {
      return undefined;
    },
    async close() {
      return undefined;
    }
  };
}

describe("configured sandbox workspace services", () => {
  it("derives the configured provider and remote flag from explicit and legacy self-hosted config", () => {
    expect(resolveConfiguredSandboxProvider(buildConfig())).toBe("embedded");
    expect(
      resolveConfiguredSandboxProvider(
        buildConfig({
          sandbox: {
            self_hosted: {
              base_url: "http://127.0.0.1:8788/internal/v1"
            }
          }
        })
      )
    ).toBe("self_hosted");
    expect(
      resolveConfiguredSandboxProvider(
        buildConfig({
          sandbox: {
            provider: "e2b",
            self_hosted: {
              base_url: "http://127.0.0.1:8788/internal/v1"
            }
          }
        })
      )
    ).toBe("e2b");
    expect(isRemoteSandboxProvider(buildConfig())).toBe(false);
    expect(
      isRemoteSandboxProvider(
        buildConfig({
          sandbox: {
            provider: "self_hosted"
          }
        })
      )
    ).toBe(true);
  });

  it("resolves materialization strategy once for embedded, self-hosted worker, and e2b processes", () => {
    expect(
      resolveSandboxBootstrapPlan({
        config: buildConfig({
          object_storage: {
            provider: "s3",
            bucket: "bucket",
            region: "us-east-1"
          }
        }),
        processKind: "api",
        startWorker: false,
        hasSandboxHostFactory: false
      })
    ).toMatchObject({
      provider: "embedded",
      remoteSandboxProvider: false,
      selfHostedWorkerProcess: false,
      materializationMode: "lazy",
      shouldUseWorkspaceMaterialization: true,
      canDeferEmbeddedSandboxMaterialization: true
    });

    expect(
      resolveSandboxBootstrapPlan({
        config: buildConfig({
          object_storage: {
            provider: "s3",
            bucket: "bucket",
            region: "us-east-1"
          }
        }),
        processKind: "api",
        startWorker: true,
        hasSandboxHostFactory: false
      })
    ).toMatchObject({
      provider: "embedded",
      materializationMode: "eager",
      canDeferEmbeddedSandboxMaterialization: false
    });

    expect(
      resolveSandboxBootstrapPlan({
        config: buildConfig({
          object_storage: {
            provider: "s3",
            bucket: "bucket",
            region: "us-east-1"
          },
          sandbox: {
            provider: "self_hosted",
            self_hosted: {
              base_url: "http://127.0.0.1:8788/internal/v1"
            }
          }
        }),
        processKind: "worker",
        startWorker: false,
        hasSandboxHostFactory: false
      })
    ).toMatchObject({
      provider: "self_hosted",
      remoteSandboxProvider: true,
      selfHostedWorkerProcess: true,
      materializationMode: "eager",
      shouldUseWorkspaceMaterialization: true
    });

    expect(
      resolveSandboxBootstrapPlan({
        config: buildConfig({
          object_storage: {
            provider: "s3",
            bucket: "bucket",
            region: "us-east-1"
          },
          sandbox: {
            provider: "e2b"
          }
        }),
        processKind: "api",
        startWorker: false,
        hasSandboxHostFactory: false
      })
    ).toMatchObject({
      provider: "e2b",
      remoteSandboxProvider: true,
      materializationMode: "none",
      shouldUseWorkspaceMaterialization: false
    });
  });

  it("keeps embedded workspaces on the local initializer path", () => {
    const plan = resolveSandboxWorkspaceServicePlan({
      config: buildConfig(),
      remoteSandboxProvider: false,
      sandboxHost: createSandboxHost("embedded"),
      processKind: "api",
      startWorker: false
    });

    expect(plan).toMatchObject({
      initializerMode: "local",
      useSelfHostedWorkspaceDelegatingInitializer: false,
      useSandboxBackedWorkspaceInitializer: false
    });
  });

  it("delegates self-hosted workspace creation from API-only processes", () => {
    const plan = resolveSandboxWorkspaceServicePlan({
      config: buildConfig({
        sandbox: {
          provider: "self_hosted",
          self_hosted: {
            base_url: " http://127.0.0.1:8788/internal/v1 "
          }
        }
      }),
      remoteSandboxProvider: true,
      sandboxHost: createSandboxHost("self_hosted"),
      processKind: "api",
      startWorker: false
    });

    expect(plan).toMatchObject({
      initializerMode: "self_hosted_delegated",
      useSelfHostedWorkspaceDelegatingInitializer: true,
      useSandboxBackedWorkspaceInitializer: false,
      selfHostedSandboxOptions: {
        baseUrl: "http://127.0.0.1:8788/internal/v1"
      }
    });
  });

  it("uses sandbox-backed creation for self-hosted worker processes", () => {
    const plan = resolveSandboxWorkspaceServicePlan({
      config: buildConfig({
        sandbox: {
          provider: "self_hosted",
          self_hosted: {
            base_url: "http://127.0.0.1:8788/internal/v1"
          }
        }
      }),
      remoteSandboxProvider: true,
      sandboxHost: createSandboxHost("self_hosted"),
      processKind: "worker",
      startWorker: false
    });

    expect(plan).toMatchObject({
      initializerMode: "sandbox_backed",
      useSelfHostedWorkspaceDelegatingInitializer: false,
      useSandboxBackedWorkspaceInitializer: true
    });
  });

  it("uses sandbox-backed creation for e2b when object storage does not own managed workspaces", () => {
    const plan = resolveSandboxWorkspaceServicePlan({
      config: buildConfig({
        sandbox: {
          provider: "e2b"
        }
      }),
      remoteSandboxProvider: true,
      sandboxHost: createSandboxHost("e2b"),
      processKind: "api",
      startWorker: false
    });

    expect(plan).toMatchObject({
      initializerMode: "sandbox_backed",
      useSelfHostedWorkspaceDelegatingInitializer: false,
      useSandboxBackedWorkspaceInitializer: true
    });
  });

  it("falls back to local creation when object storage owns managed workspaces", () => {
    const plan = resolveSandboxWorkspaceServicePlan({
      config: buildConfig({
        object_storage: {
          provider: "s3",
          bucket: "bucket",
          region: "us-east-1",
          workspace_backing_store: {
            enabled: true
          }
        },
        sandbox: {
          provider: "e2b"
        }
      }),
      remoteSandboxProvider: true,
      sandboxHost: createSandboxHost("e2b"),
      processKind: "api",
      startWorker: false
    });

    expect(plan).toMatchObject({
      initializerMode: "local",
      useSelfHostedWorkspaceDelegatingInitializer: false,
      useSandboxBackedWorkspaceInitializer: false
    });
  });

  it("does not instantiate lazy materialization just to touch activity or maintain", async () => {
    let touched = 0;
    const activityTracker = createSandboxWorkspaceActivityTracker({
      workspaceMaterializationManager: undefined,
      canDeferEmbeddedSandboxMaterialization: true
    });
    await activityTracker?.touchWorkspace("ws_lazy");
    expect(touched).toBe(0);

    const maintenance = createSandboxHostMaintenance({
      sandboxHost: undefined,
      idleTtlMs: 1_000,
      maintenanceIntervalMs: 5_000
    });
    expect(maintenance.start()).toBeUndefined();
  });
});
