import { createApiApp } from "./api-app.js";
import { bootstrapRuntime, installSignalHandlers, shouldStartEmbeddedWorker } from "./bootstrap.js";
import { buildApiAppDependencies } from "./runtime-app-dependencies.js";

export async function startApiServer(argv = process.argv.slice(2)): Promise<void> {
  const runtime = await bootstrapRuntime({
    argv,
    startWorker: shouldStartEmbeddedWorker(argv),
    processKind: "api"
  });

  const app = createApiApp(buildApiAppDependencies(runtime));

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
