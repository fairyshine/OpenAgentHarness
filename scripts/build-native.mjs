import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(repoRoot, "native", "Cargo.toml");
const targetDir = path.join(repoRoot, ".native-target");
const localBinaryDir = path.join(repoRoot, "native", "bin");
const binaryBasenames = [
  process.platform === "win32" ? "oah-workspace-sync.exe" : "oah-workspace-sync",
  process.platform === "win32" ? "oah-archive-export.exe" : "oah-archive-export"
];
const args = [
  "build",
  "--release",
  "--manifest-path",
  manifestPath,
  "--target-dir",
  targetDir,
  "-p",
  "oah-workspace-sync",
  "-p",
  "oah-archive-export"
];

const child = spawn("cargo", args, {
  cwd: repoRoot,
  stdio: "inherit"
});

child.on("exit", async (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  if ((code ?? 1) !== 0) {
    process.exit(code ?? 1);
    return;
  }

  try {
    await mkdir(localBinaryDir, { recursive: true });
    for (const binaryBasename of binaryBasenames) {
      const builtBinaryPath = path.join(targetDir, "release", binaryBasename);
      const localBinaryPath = path.join(localBinaryDir, binaryBasename);
      await copyFile(builtBinaryPath, localBinaryPath);
      if (process.platform !== "win32") {
        await chmod(localBinaryPath, 0o755);
      }
    }
    process.exit(0);
  } catch (error) {
    console.error(`Failed to stage native binary: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
});

child.on("error", (error) => {
  console.error(`Failed to start cargo: ${error.message}`);
  process.exit(1);
});
