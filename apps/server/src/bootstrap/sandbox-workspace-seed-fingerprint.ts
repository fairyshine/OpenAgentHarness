import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import * as nativeBridge from "@oah/native-bridge";

import {
  observeNativeWorkspaceSyncOperation,
  recordNativeWorkspaceSyncFallback
} from "../observability/native-workspace-sync.js";

export const nativeWorkspaceSyncAdapter = {
  isEnabled: nativeBridge.isNativeWorkspaceSyncEnabled,
  computeDirectoryFingerprint: nativeBridge.computeNativeDirectoryFingerprint,
  computeDirectoryFingerprintBatch: nativeBridge.computeNativeDirectoryFingerprintBatch,
  planSeedUpload: nativeBridge.planNativeSeedUpload,
  buildSeedArchive: nativeBridge.buildNativeSeedArchive,
  syncLocalToSandboxHttp: nativeBridge.syncNativeLocalToSandboxHttp
};

async function collectDirectoryFingerprint(rootPath: string): Promise<string> {
  if (nativeWorkspaceSyncAdapter.isEnabled()) {
    try {
      const result = await observeNativeWorkspaceSyncOperation({
        operation: "fingerprint",
        implementation: "rust",
        target: rootPath,
        logFailure: false,
        action: () => nativeWorkspaceSyncAdapter.computeDirectoryFingerprint({ rootDir: rootPath })
      });
      return result.fingerprint;
    } catch (error) {
      recordNativeWorkspaceSyncFallback({
        operation: "fingerprint",
        target: rootPath,
        error
      });
    }
  }

  return observeNativeWorkspaceSyncOperation({
    operation: "fingerprint",
    implementation: "ts",
    target: rootPath,
    logSuccess: false,
    logFailure: false,
    action: async () => {
      const hash = createHash("sha1");
      const visit = async (currentPath: string): Promise<void> => {
        const entries = await readdir(currentPath, { withFileTypes: true }).catch(() => []);
        entries.sort((left, right) => left.name.localeCompare(right.name));

        for (const entry of entries) {
          const absolutePath = path.join(currentPath, entry.name);
          const relativePath = path.relative(rootPath, absolutePath).replaceAll(path.sep, "/");
          const entryStat = await stat(absolutePath).catch(() => null);
          if (!entryStat) {
            continue;
          }

          hash.update(
            `${entry.isDirectory() ? "dir" : "file"}:${relativePath}:${entryStat.size}:${Math.trunc(entryStat.mtimeMs)}\n`
          );
          if (entry.isDirectory()) {
            await visit(absolutePath);
          }
        }
      };

      await visit(rootPath);
      return hash.digest("hex");
    }
  });
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(",")}}`;
}

export async function buildPreparedSeedCacheKey(input: {
  runtimeDir: string;
  runtimeName: string;
  platformToolDir: string;
  platformSkillDir: string;
  toolDir: string;
  agentsMd?: string | undefined;
  toolServers?: Record<string, Record<string, unknown>> | undefined;
  skills?: Array<{ name: string; content: string }> | undefined;
}): Promise<string> {
  const runtimeRoot = path.join(input.runtimeDir, input.runtimeName);
  const fingerprintInputs = [
    { key: "runtimeRoot", rootDir: runtimeRoot },
    { key: "platformToolDir", rootDir: input.platformToolDir },
    { key: "platformSkillDir", rootDir: input.platformSkillDir },
    { key: "toolDir", rootDir: input.toolDir }
  ] as const;

  const directoryFingerprints = new Map<string, string>();
  if (nativeWorkspaceSyncAdapter.isEnabled()) {
    try {
      const result = await observeNativeWorkspaceSyncOperation({
        operation: "fingerprint_batch",
        implementation: "rust",
        target: runtimeRoot,
        logFailure: false,
        metadata: {
          directoryCount: fingerprintInputs.length
        },
        action: () =>
          nativeWorkspaceSyncAdapter.computeDirectoryFingerprintBatch({
            directories: fingerprintInputs.map((entry) => ({
              rootDir: entry.rootDir
            }))
          })
      });
      for (const [index, entry] of result.results.entries()) {
        const fingerprintInput = fingerprintInputs[index];
        if (!fingerprintInput) {
          continue;
        }
        directoryFingerprints.set(fingerprintInput.key, entry.fingerprint);
      }
    } catch (error) {
      recordNativeWorkspaceSyncFallback({
        operation: "fingerprint_batch",
        target: runtimeRoot,
        error,
        metadata: {
          directoryCount: fingerprintInputs.length
        }
      });
    }
  }

  const hash = createHash("sha1");
  hash.update(input.runtimeName);
  hash.update("\n");
  hash.update(directoryFingerprints.get("runtimeRoot") ?? (await collectDirectoryFingerprint(runtimeRoot)));
  hash.update("\n");
  hash.update(directoryFingerprints.get("platformToolDir") ?? (await collectDirectoryFingerprint(input.platformToolDir).catch(() => "")));
  hash.update("\n");
  hash.update(
    directoryFingerprints.get("platformSkillDir") ?? (await collectDirectoryFingerprint(input.platformSkillDir).catch(() => ""))
  );
  hash.update("\n");
  hash.update(directoryFingerprints.get("toolDir") ?? (await collectDirectoryFingerprint(input.toolDir).catch(() => "")));
  hash.update("\n");
  hash.update(input.agentsMd?.trim() ?? "");
  hash.update("\n");
  hash.update(stableJson(input.toolServers ?? {}));
  hash.update("\n");
  hash.update(stableJson(input.skills ?? []));
  return hash.digest("hex");
}
