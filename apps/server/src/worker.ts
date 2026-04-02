import { bootstrapRuntime, installSignalHandlers } from "./bootstrap.js";

async function main() {
  const runtime = await bootstrapRuntime({
    argv: process.argv.slice(2),
    startWorker: true,
    processKind: "worker"
  });

  installSignalHandlers(async () => {
    await runtime.close();
  });

  console.log(
    `Open Agent Harness ${runtime.process.label} started for ${runtime.config.server.host}:${runtime.config.server.port}${
      runtime.config.storage.redis_url ? ` using Redis ${runtime.config.storage.redis_url}` : " without Redis queue"
    }`
  );

  await new Promise<void>(() => undefined);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
