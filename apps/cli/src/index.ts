#!/usr/bin/env node
import { runCli } from "./cli/program.js";

runCli().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`oah: ${message}`);
  process.exitCode = 1;
});
