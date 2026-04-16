import { createApp, type AppDependencies } from "./app.js";
import { bootstrapRuntime, installSignalHandlers, shouldStartEmbeddedWorker, type BootstrappedRuntime } from "./bootstrap.js";

function buildAppDependencies(runtime: BootstrappedRuntime): AppDependencies {
  const runtimeService = runtime.runtimeService as unknown as AppDependencies["runtimeService"];

  return {
    runtimeService,
    modelGateway: runtime.modelGateway,
    defaultModel: runtime.config.llm.default_model,
    workspaceMode: runtime.workspaceMode.kind,
    healthCheck: () => runtime.healthReport(),
    readinessCheck: () => runtime.readinessReport(),
    storageAdmin: runtime.storageAdmin,
    appendRuntimeLog: runtime.appendRuntimeLog,
    ...(runtime.sandboxHostProviderKind ? { sandboxHostProviderKind: runtime.sandboxHostProviderKind } : {}),
    ...(runtime.listPlatformModels ? { listPlatformModels: runtime.listPlatformModels } : {}),
    ...(runtime.getPlatformModelSnapshot ? { getPlatformModelSnapshot: runtime.getPlatformModelSnapshot } : {}),
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
