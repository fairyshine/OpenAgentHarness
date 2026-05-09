import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pipeline } from "node:stream/promises";

import { recordObjectStorageOperation } from "./observability/object-storage.js";
import {
  DEFAULT_OBJECT_STORAGE_BUNDLE_TIMEOUT_MS,
  resolveObjectStorageBundleConfig,
  resolveObjectStorageBundleTimeoutMs
} from "./object-storage-config.js";
import type { LocalDirectorySnapshot } from "./object-storage-types.js";

export function shouldAttemptObjectStorageBundle(input: {
  files: Iterable<{ size: number }>;
}): boolean {
  const config = resolveObjectStorageBundleConfig();
  const mode = config.mode;
  if (mode === "off") {
    return false;
  }

  let fileCount = 0;
  let totalBytes = 0;
  for (const file of input.files) {
    fileCount += 1;
    totalBytes += file.size;
  }

  if (fileCount === 0) {
    return false;
  }
  if (mode === "force") {
    return true;
  }

  return fileCount >= config.minFileCount || totalBytes >= config.minTotalBytes;
}

export async function isDirectoryEmpty(rootDir: string): Promise<boolean> {
  const rootExists = await stat(rootDir).catch((error) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (!rootExists) {
    return true;
  }
  if (!rootExists.isDirectory()) {
    return false;
  }

  return (await readdir(rootDir)).length === 0;
}

export async function withObjectStorageBundleFile<T>(
  input: {
    localDir: string;
    snapshot: LocalDirectorySnapshot;
  },
  useBundle: (bundlePath: string) => Promise<T>
): Promise<T> {
  const bundleRoot = await mkdtemp(path.join(os.tmpdir(), "oah-object-store-bundle-"));
  const listPath = path.join(bundleRoot, "bundle-files.txt");
  const bundlePath = path.join(bundleRoot, "bundle.tar");
  const timeoutMs = resolveObjectStorageBundleTimeoutMs();
  const startedAt = performance.now();

  try {
    const fileList = [
      ...[...input.snapshot.files.keys()].sort((left, right) => left.localeCompare(right)),
      ...[...input.snapshot.emptyDirectories].sort((left, right) => left.localeCompare(right))
    ];
    await writeFile(listPath, Buffer.from(fileList.join("\0"), "utf8"));
    await runLocalProcess({
      executable: "tar",
      args: ["-C", input.localDir, "-cf", bundlePath, "--null", "-T", listPath],
      timeoutMs
    });
    recordObjectStorageOperation({
      operation: "bundle_create",
      durationMs: Math.max(0, Math.round(performance.now() - startedAt))
    });
    return await useBundle(bundlePath);
  } finally {
    await rm(bundleRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function withObjectStorageBundleStream<T>(
  input: {
    localDir: string;
    snapshot: LocalDirectorySnapshot;
  },
  useBundle: (bundle: NodeJS.ReadableStream) => Promise<T>
): Promise<T> {
  const bundleRoot = await mkdtemp(path.join(os.tmpdir(), "oah-object-store-bundle-stream-"));
  const listPath = path.join(bundleRoot, "bundle-files.txt");
  const timeoutMs = resolveObjectStorageBundleTimeoutMs();
  const startedAt = performance.now();

  try {
    const fileList = [
      ...[...input.snapshot.files.keys()].sort((left, right) => left.localeCompare(right)),
      ...[...input.snapshot.emptyDirectories].sort((left, right) => left.localeCompare(right))
    ];
    await writeFile(listPath, Buffer.from(fileList.join("\0"), "utf8"));

    const child = spawn("tar", ["-C", input.localDir, "-cf", "-", "--null", "-T", listPath], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    let timeoutTriggered = false;
    const timeoutHandle = setTimeout(() => {
      timeoutTriggered = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-32_768);
    });

    const closePromise = new Promise<void>((resolve, reject) => {
      child.on("error", (error) => {
        clearTimeout(timeoutHandle);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timeoutHandle);
        if (timeoutTriggered) {
          reject(new Error(`Process timed out after ${timeoutMs}ms.`));
          return;
        }
        if ((code ?? 0) !== 0) {
          reject(new Error(stderr.trim() || `Process exited with code ${code ?? 0}.`));
          return;
        }
        resolve();
      });
    });

    if (!child.stdout) {
      child.kill("SIGTERM");
      throw new Error("tar stdout stream is unavailable.");
    }

    const result = await Promise.all([
      useBundle(child.stdout).catch((error) => {
        child.kill("SIGTERM");
        throw error;
      }),
      closePromise
    ]).then(([value]) => value);
    recordObjectStorageOperation({
      operation: "bundle_create",
      durationMs: Math.max(0, Math.round(performance.now() - startedAt))
    });
    return result;
  } finally {
    await rm(bundleRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function withObjectStorageBundleExtractRoot<T>(useBundleRoot: (input: { bundleRoot: string; bundlePath: string }) => Promise<T>): Promise<T> {
  const bundleRoot = await mkdtemp(path.join(os.tmpdir(), "oah-object-store-bundle-extract-"));
  const bundlePath = path.join(bundleRoot, "bundle.tar");
  try {
    return await useBundleRoot({ bundleRoot, bundlePath });
  } finally {
    await rm(bundleRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function runLocalProcess(input: {
  executable: string;
  args: string[];
  cwd?: string | undefined;
  timeoutMs?: number | undefined;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(input.executable, input.args, {
      ...(input.cwd ? { cwd: input.cwd } : {}),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    let timeoutTriggered = false;
    const timeoutHandle = setTimeout(() => {
      timeoutTriggered = true;
      child.kill("SIGTERM");
    }, input.timeoutMs ?? DEFAULT_OBJECT_STORAGE_BUNDLE_TIMEOUT_MS);

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-32_768);
    });
    child.on("error", (error) => {
      clearTimeout(timeoutHandle);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeoutHandle);
      if (timeoutTriggered) {
        reject(new Error(`Process timed out after ${input.timeoutMs ?? DEFAULT_OBJECT_STORAGE_BUNDLE_TIMEOUT_MS}ms.`));
        return;
      }
      if ((code ?? 0) !== 0) {
        reject(new Error(stderr.trim() || `Process exited with code ${code ?? 0}.`));
        return;
      }
      resolve();
    });
  });
}

export async function extractTarStreamToDirectory(input: {
  bundle: NodeJS.ReadableStream;
  localDir: string;
  timeoutMs: number;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-xf", "-", "-C", input.localDir], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stderr = "";
    let timeoutTriggered = false;
    const timeoutHandle = setTimeout(() => {
      timeoutTriggered = true;
      child.kill("SIGTERM");
    }, input.timeoutMs);

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-32_768);
    });
    child.on("error", (error) => {
      clearTimeout(timeoutHandle);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeoutHandle);
      if (timeoutTriggered) {
        reject(new Error(`Process timed out after ${input.timeoutMs}ms.`));
        return;
      }
      if ((code ?? 0) !== 0) {
        reject(new Error(stderr.trim() || `Process exited with code ${code ?? 0}.`));
        return;
      }
      resolve();
    });

    if (!child.stdin) {
      child.kill("SIGTERM");
      reject(new Error("tar stdin stream is unavailable."));
      return;
    }

    pipeline(input.bundle, child.stdin).catch((error) => {
      child.kill("SIGTERM");
      reject(error);
    });
  });
}
