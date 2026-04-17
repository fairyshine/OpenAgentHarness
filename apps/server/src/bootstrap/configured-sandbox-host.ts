import type { ServerConfig } from "@oah/config";

import {
  createE2BCompatibleSandboxHost,
  createHttpE2BCompatibleSandboxService
} from "./e2b-compatible-sandbox-host.js";
import { createNativeE2BSandboxService, normalizeE2BApiUrl } from "./native-e2b-sandbox-service.js";
import { createMaterializationSandboxHost, type SandboxHost } from "./sandbox-host.js";
import { trimToUndefined } from "./string-utils.js";
import type { WorkspaceMaterializationManager } from "./workspace-materialization.js";

function createRemoteSandboxHost(options: {
  providerKind: "self_hosted" | "e2b";
  baseUrl: string;
  headers?: Record<string, string> | undefined;
}): SandboxHost {
  return createE2BCompatibleSandboxHost({
    providerKind: options.providerKind,
    diagnostics: {
      provider: options.providerKind,
      transport: "http",
      executionModel: "sandbox_hosted",
      workerPlacement: "inside_sandbox"
    },
    service: createHttpE2BCompatibleSandboxService({
      baseUrl: options.baseUrl,
      ...(options.headers ? { headers: options.headers } : {})
    })
  });
}

function createNativeE2BSandboxHost(options: {
  apiKey?: string | undefined;
  apiUrl?: string | undefined;
  domain?: string | undefined;
  headers?: Record<string, string> | undefined;
  template?: string | undefined;
  timeoutMs?: number | undefined;
  requestTimeoutMs?: number | undefined;
}): SandboxHost {
  return createE2BCompatibleSandboxHost({
    providerKind: "e2b",
    service: createNativeE2BSandboxService({
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
      ...(options.domain ? { domain: options.domain } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.template ? { template: options.template } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {})
    })
  });
}

export async function createConfiguredSandboxHost(options: {
  config: ServerConfig;
  workspaceMaterializationManager?: WorkspaceMaterializationManager | undefined;
}): Promise<SandboxHost | undefined> {
  const provider =
    options.config.sandbox?.provider ??
    (trimToUndefined(options.config.sandbox?.self_hosted?.base_url) ? "self_hosted" : "embedded");

  if (provider === "embedded") {
    if (!options.workspaceMaterializationManager) {
      return undefined;
    }

    return createMaterializationSandboxHost({
      materializationManager: options.workspaceMaterializationManager
    });
  }

  if (provider === "self_hosted") {
    const baseUrl = trimToUndefined(options.config.sandbox?.self_hosted?.base_url);
    if (!baseUrl) {
      throw new Error("sandbox.self_hosted.base_url is required when sandbox.provider is self_hosted.");
    }

    return createRemoteSandboxHost({
      providerKind: "self_hosted",
      baseUrl,
      headers: options.config.sandbox?.self_hosted?.headers
    });
  }

  return createNativeE2BSandboxHost({
    apiKey: trimToUndefined(options.config.sandbox?.e2b?.api_key),
    apiUrl: normalizeE2BApiUrl(options.config.sandbox?.e2b?.base_url),
    domain: trimToUndefined(options.config.sandbox?.e2b?.domain),
    headers: options.config.sandbox?.e2b?.headers,
    template: trimToUndefined(options.config.sandbox?.e2b?.template),
    timeoutMs: options.config.sandbox?.e2b?.timeout_ms,
    requestTimeoutMs: options.config.sandbox?.e2b?.request_timeout_ms
  });
}
