import { createApp } from "./app.js";
import { bootstrapRuntime, installSignalHandlers, shouldStartEmbeddedWorker } from "./bootstrap.js";

async function main() {
  const runtime = await bootstrapRuntime({
    argv: process.argv.slice(2),
    startWorker: shouldStartEmbeddedWorker(process.argv.slice(2)),
    processKind: "api"
  });

  const app = createApp({
    runtimeService: runtime.runtimeService,
    modelGateway: runtime.modelGateway,
    defaultModel: runtime.config.llm.default_model,
    workspaceMode: runtime.workspaceMode.kind,
    healthCheck: () => runtime.healthReport(),
    readinessCheck: () => runtime.readinessReport(),
    rebuildWorkspaceHistoryMirror: runtime.rebuildWorkspaceHistoryMirror,
    ...(runtime.listWorkspaceTemplates ? { listWorkspaceTemplates: runtime.listWorkspaceTemplates } : {}),
    ...(runtime.importWorkspace ? { importWorkspace: runtime.importWorkspace } : {})
  });

  app.addHook("onClose", async () => {
    await runtime.close();
  });

  installSignalHandlers(async () => {
    await app.close();
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
