import { createApp, type AppDependencies } from "./app.js";
import { bootstrapRuntime, installSignalHandlers, shouldStartEmbeddedWorker, type BootstrappedRuntime } from "./bootstrap.js";

function normalizeOwnerProxyBaseUrl(input: string | undefined): string | undefined {
  const trimmed = input?.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const url = new URL(trimmed);
    const normalizedPath = url.pathname.replace(/\/(?:api|internal)\/v1\/?$/u, "").replace(/\/+$/u, "");
    return `${url.origin}${normalizedPath}`;
  } catch {
    return trimmed.replace(/\/(?:api|internal)\/v1\/?$/u, "").replace(/\/+$/u, "");
  }
}

function buildAppDependencies(runtime: BootstrappedRuntime): AppDependencies {
  const sandboxOwnerFallbackBaseUrl =
    runtime.sandboxHostProviderKind === "self_hosted"
      ? normalizeOwnerProxyBaseUrl(runtime.config.sandbox?.self_hosted?.base_url)
      : undefined;

  return {
    runtimeService: runtime.controlPlaneRuntimeService,
    modelGateway: runtime.modelGateway,
    defaultModel: runtime.config.llm.default_model,
    workspaceMode: runtime.workspaceMode.kind,
    healthCheck: () => runtime.healthReport(),
    readinessCheck: () => runtime.readinessReport(),
    storageAdmin: runtime.adminCapabilities.storageAdmin,
    appendRuntimeLog: runtime.appendRuntimeLog,
    ...(runtime.sandboxHostProviderKind ? { sandboxHostProviderKind: runtime.sandboxHostProviderKind } : {}),
    ...(sandboxOwnerFallbackBaseUrl ? { sandboxOwnerFallbackBaseUrl } : {}),
    ...(runtime.listPlatformModels ? { listPlatformModels: runtime.listPlatformModels } : {}),
    ...(runtime.getPlatformModelSnapshot ? { getPlatformModelSnapshot: runtime.getPlatformModelSnapshot } : {}),
    ...(runtime.refreshPlatformModels ? { refreshPlatformModels: runtime.refreshPlatformModels } : {}),
    ...(runtime.refreshDistributedPlatformModels
      ? { refreshDistributedPlatformModels: runtime.refreshDistributedPlatformModels }
      : {}),
    ...(runtime.subscribePlatformModelSnapshot
      ? { subscribePlatformModelSnapshot: runtime.subscribePlatformModelSnapshot }
      : {}),
    ...(runtime.listWorkspaceBlueprints ? { listWorkspaceBlueprints: runtime.listWorkspaceBlueprints } : {}),
    ...(runtime.uploadWorkspaceBlueprint ? { uploadWorkspaceBlueprint: runtime.uploadWorkspaceBlueprint } : {}),
    ...(runtime.deleteWorkspaceBlueprint ? { deleteWorkspaceBlueprint: runtime.deleteWorkspaceBlueprint } : {}),
    ...(runtime.importWorkspace ? { importWorkspace: runtime.importWorkspace } : {}),
    ...(runtime.resolveWorkspaceOwnership
      ? { resolveWorkspaceOwnership: runtime.resolveWorkspaceOwnership }
      : {})
  };
}

export async function startApiServer(argv = process.argv.slice(2)): Promise<void> {
  const runtime = await bootstrapRuntime({
    argv,
    startWorker: shouldStartEmbeddedWorker(argv),
    processKind: "api"
  });

  const app = createApp(buildAppDependencies(runtime));

  app.addHook("onClose", async () => {
    await runtime.close();
  });

  installSignalHandlers({
    beginDrain: () => runtime.beginDrain(),
    close: async () => {
      await app.close();
    }
  });

  await app.listen({
    host: runtime.config.server.host,
    port: runtime.config.server.port
  });

  const workspaceScopeLabel =
    runtime.workspaceMode.kind === "single"
      ? `; workspace=${runtime.workspaceMode.workspaceId} (${runtime.workspaceMode.workspaceKind})`
      : "";
  console.log(
    `Open Agent Harness server listening on ${runtime.config.server.host}:${runtime.config.server.port} (${runtime.process.label}; execution=${runtime.process.execution}${workspaceScopeLabel})`
  );
}

export async function startWorkerServer(argv = process.argv.slice(2)): Promise<void> {
  const runtime = await bootstrapRuntime({
    argv,
    startWorker: true,
    processKind: "worker"
  });

  const app = createApp(buildAppDependencies(runtime), {
    surface: "internal_only"
  });

  app.addHook("onClose", async () => {
    await runtime.close();
  });

  installSignalHandlers({
    beginDrain: () => runtime.beginDrain(),
    close: async () => {
      await app.close();
    }
  });

  await app.listen({
    host: runtime.config.server.host,
    port: runtime.config.server.port
  });

  console.log(
    `Open Agent Harness ${runtime.process.label} listening on ${runtime.config.server.host}:${runtime.config.server.port}${
      runtime.config.storage.redis_url ? ` using Redis ${runtime.config.storage.redis_url}` : " without Redis queue"
    }`
  );

  await new Promise<void>(() => undefined);
}
