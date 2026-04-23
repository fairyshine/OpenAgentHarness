import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(repoRoot, "native", "Cargo.toml");
const args = ["build", "--release", "--manifest-path", manifestPath, "-p", "oah-workspace-sync"];

const child = spawn("cargo", args, {
  cwd: repoRoot,
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(`Failed to start cargo: ${error.message}`);
  process.exit(1);
});
