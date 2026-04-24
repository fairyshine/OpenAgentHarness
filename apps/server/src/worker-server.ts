import { createInternalWorkerApp } from "./internal-worker-app.js";
import { bootstrapRuntime, installSignalHandlers } from "./bootstrap.js";
import { buildWorkerAppDependencies } from "./runtime-app-dependencies.js";

export async function startWorkerServer(argv = process.argv.slice(2)): Promise<void> {
  const runtime = await bootstrapRuntime({
    argv,
    startWorker: true,
    processKind: "worker"
  });

  const app = createInternalWorkerApp(buildWorkerAppDependencies(runtime));

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
