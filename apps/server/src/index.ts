import { startApiServer } from "./api-server.js";
import { installProcessSafetyHandlers } from "./bootstrap/process-safety.js";

installProcessSafetyHandlers();

async function main() {
  await startApiServer(process.argv.slice(2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
