import { describe, expect, it } from "vitest";

import { formatSystemProfileDisplayName } from "@oah/api-contracts";
import type { ServerConfig } from "@oah/config";

import { buildSystemProfile } from "../apps/server/src/system-profile.ts";

const baseConfig: ServerConfig = {
  server: {
    host: "127.0.0.1",
    port: 8787
  },
  storage: {},
  paths: {
    workspace_dir: "/tmp/oah/workspaces",
    runtime_state_dir: "/tmp/oah/state",
    runtime_dir: "/tmp/oah/runtimes",
    model_dir: "/tmp/oah/models",
    tool_dir: "/tmp/oah/tools",
    skill_dir: "/tmp/oah/skills"
  },
  llm: {
    default_model: "openai-default"
  }
};

describe("system profile", () => {
  it("defaults to an enterprise OAH embedded profile", () => {
    expect(
      buildSystemProfile({
        config: baseConfig,
        process: {
          mode: "api_embedded_worker",
          label: "API + embedded worker",
          execution: "local_inline"
        },
        workspaceMode: "multi",
        storageInspection: true
      })
    ).toEqual({
      apiCompatibility: "oah/v1",
      product: "open-agent-harness",
      edition: "enterprise",
      runtimeMode: "embedded",
      deploymentKind: "oah",
      displayName: "OAH enterprise server",
      capabilities: {
        localDaemonControl: false,
        localWorkspacePaths: false,
        workspaceRegistration: true,
        storageInspection: true,
        assetManagement: false,
        modelManagement: false,
        localDaemonSupervisor: false
      }
    });
  });

  it("reports a personal OAP daemon profile from deployment config", () => {
    expect(
      buildSystemProfile({
        config: {
          ...baseConfig,
          deployment: {
            kind: "oap",
            runtime_mode: "daemon",
            display_name: "OAP local daemon"
          }
        },
        process: {
          mode: "api_embedded_worker",
          label: "API + embedded worker",
          execution: "local_inline"
        },
        workspaceMode: "multi",
        storageInspection: true
      })
    ).toEqual({
      apiCompatibility: "oah/v1",
      product: "open-agent-harness",
      edition: "personal",
      runtimeMode: "daemon",
      deploymentKind: "oap",
      displayName: "OAP local daemon",
      capabilities: {
        localDaemonControl: true,
        localWorkspacePaths: true,
        workspaceRegistration: true,
        storageInspection: true,
        assetManagement: false,
        modelManagement: true,
        localDaemonSupervisor: true
      }
    });
  });

  it("disables workspace registration capability in single workspace mode", () => {
    const profile = buildSystemProfile({
      config: baseConfig,
      workspaceMode: "single"
    });

    expect(profile.capabilities.workspaceRegistration).toBe(false);
  });

  it("reports platform asset management when runtime dependencies provide it", () => {
    const profile = buildSystemProfile({
      config: baseConfig,
      workspaceMode: "multi",
      assetManagement: true
    });

    expect(profile.capabilities.assetManagement).toBe(true);
  });

  it("formats user-facing deployment names without exposing internal split mode", () => {
    expect(
      formatSystemProfileDisplayName({
        deploymentKind: "oah",
        edition: "enterprise",
        runtimeMode: "split"
      })
    ).toBe("OAH Docker");
    expect(
      formatSystemProfileDisplayName({
        deploymentKind: "oap",
        edition: "personal",
        runtimeMode: "daemon"
      })
    ).toBe("OAP Local");
  });
});
