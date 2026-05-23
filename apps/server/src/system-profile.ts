import type { ServerConfig } from "@oah/config";
import type { SystemProfile, SystemRuntimeMode } from "@oah/api-contracts";

import type { EngineProcessDescriptor } from "./bootstrap/engine-process.js";

export interface BuildSystemProfileInput {
  config?: ServerConfig | undefined;
  process?: EngineProcessDescriptor | undefined;
  workspaceMode?: "multi" | "single" | undefined;
  storageInspection?: boolean | undefined;
  assetManagement?: boolean | undefined;
}

function inferRuntimeMode(input: BuildSystemProfileInput): SystemRuntimeMode {
  const configured = input.config?.deployment?.runtime_mode;
  if (configured) {
    return configured;
  }

  if (input.config?.deployment?.kind === "oap") {
    return "daemon";
  }

  if (input.process?.mode === "api_only" || input.process?.mode === "standalone_worker") {
    return "split";
  }

  return "embedded";
}

export function buildSystemProfile(input: BuildSystemProfileInput = {}): SystemProfile {
  const deploymentKind = input.config?.deployment?.kind ?? "oah";
  const edition = deploymentKind === "oap" ? "personal" : "enterprise";
  const runtimeMode = inferRuntimeMode(input);
  const isLocalDaemon = deploymentKind === "oap" && runtimeMode === "daemon";
  const workspaceRegistration = input.workspaceMode !== "single";

  return {
    apiCompatibility: "oah/v1",
    product: "open-agent-harness",
    edition,
    runtimeMode,
    deploymentKind,
    displayName:
      input.config?.deployment?.display_name ??
      (deploymentKind === "oap" ? "OAP local daemon" : "OAH enterprise server"),
    capabilities: {
      localDaemonControl: isLocalDaemon,
      localWorkspacePaths: deploymentKind === "oap",
      workspaceRegistration,
      storageInspection: Boolean(input.storageInspection),
      assetManagement: Boolean(input.assetManagement),
      modelManagement: deploymentKind === "oap",
      localDaemonSupervisor: isLocalDaemon
    }
  };
}
