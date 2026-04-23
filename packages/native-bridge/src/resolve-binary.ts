import { statSync } from "node:fs";
import path from "node:path";

const WORKSPACE_SYNC_BINARY_BASENAME = process.platform === "win32" ? "oah-workspace-sync.exe" : "oah-workspace-sync";

function envPath(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function resolveWorkspaceSyncBinary(): string | undefined {
  const configured = envPath("OAH_NATIVE_WORKSPACE_SYNC_BINARY");
  const candidates = [
    configured,
    path.resolve(process.cwd(), "native", WORKSPACE_SYNC_BINARY_BASENAME),
    path.resolve(process.cwd(), "native", "bin", WORKSPACE_SYNC_BINARY_BASENAME),
    path.resolve(process.cwd(), "native", "target", "release", WORKSPACE_SYNC_BINARY_BASENAME)
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);

  return candidates.find((candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}
