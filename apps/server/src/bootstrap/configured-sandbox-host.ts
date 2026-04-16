import type { ServerConfig } from "@oah/config";

import {
  createE2BCompatibleSandboxHost,
  createHttpE2BCompatibleSandboxService
} from "./e2b-compatible-sandbox-host.js";
import { createMaterializationSandboxHost, type SandboxHost } from "./sandbox-host.js";
import type { WorkspaceMaterializationManager } from "./workspace-materialization.js";

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function mergeHeaders(...sets: Array<Record<string, string> | undefined>): Record<string, string> | undefined {
  const entries = sets.flatMap((set) => (set ? Object.entries(set) : []));
  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries);
}

function createRemoteSandboxHost(options: {
  providerKind: "self_hosted" | "e2b";
  baseUrl: string;
  headers?: Record<string, string> | undefined;
}): SandboxHost {
  return createE2BCompatibleSandboxHost({
    providerKind: options.providerKind,
    diagnostics: {
      provider: options.providerKind,
      transport: "http"
    },
    service: createHttpE2BCompatibleSandboxService({
      baseUrl: options.baseUrl,
      ...(options.headers ? { headers: options.headers } : {})
    })
  });
}

export async function createConfiguredSandboxHost(options: {
  config: ServerConfig;
  workspaceMaterializationManager?: WorkspaceMaterializationManager | undefined;
}): Promise<SandboxHost | undefined> {
  const provider = options.config.sandbox?.provider ?? "self_hosted";

  if (provider === "self_hosted") {
    const baseUrl = trimToUndefined(options.config.sandbox?.self_hosted?.base_url);
    if (baseUrl) {
      return createRemoteSandboxHost({
        providerKind: "self_hosted",
        baseUrl,
        headers: options.config.sandbox?.self_hosted?.headers
      });
    }

    if (!options.workspaceMaterializationManager) {
      return undefined;
    }

    return createMaterializationSandboxHost({
      materializationManager: options.workspaceMaterializationManager
    });
  }

  const baseUrl = trimToUndefined(options.config.sandbox?.e2b?.base_url);
  if (!baseUrl) {
    throw new Error("Invalid server config: sandbox.e2b.base_url is required when sandbox.provider is e2b.");
  }

  return createRemoteSandboxHost({
    providerKind: "e2b",
    baseUrl,
    headers: mergeHeaders(
      trimToUndefined(options.config.sandbox?.e2b?.api_key)
        ? {
            authorization: `Bearer ${options.config.sandbox?.e2b?.api_key?.trim()}`
          }
        : undefined,
      options.config.sandbox?.e2b?.headers
    )
  });
}
