import { startWorkerServer } from "./worker-server.js";

async function main() {
  await startWorkerServer(process.argv.slice(2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
