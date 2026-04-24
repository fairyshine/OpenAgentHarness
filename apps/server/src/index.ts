import { startApiServer } from "./api-server.js";

async function main() {
  await startApiServer(process.argv.slice(2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
