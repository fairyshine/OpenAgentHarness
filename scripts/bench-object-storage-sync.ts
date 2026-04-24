import { performance } from "node:perf_hooks";
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { planNativeSeedUpload } from "../packages/native-bridge/src/index.ts";
import { WorkspaceMaterializationManager } from "../apps/server/src/bootstrap/workspace-materialization.ts";
import {
  createDirectoryObjectStore,
  deleteRemotePrefixFromObjectStore,
  syncLocalDirectoryToRemote,
  syncRemotePrefixToLocal
} from "../apps/server/src/object-storage.ts";

interface BenchmarkOptions {
  files: number;
  sizeBytes: number;
  bucket: string;
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle: boolean;
  memoryPollIntervalMs: number;
}

interface SeedUploadPlan {
  directories: string[];
  files: Array<{ localPath: string; remotePath: string }>;
}

interface MemorySample {
  rssBeforeMiB: number;
  rssAfterMiB: number;
  rssPeakDeltaMiB: number;
  heapBeforeMiB: number;
  heapAfterMiB: number;
  heapPeakDeltaMiB: number;
}

interface TimedMeasurement<T> {
  durationMs: number;
  memory: MemorySample;
  result: T;
}

const noisySdkBodyLogPattern = /^\{ sendHeader: false, bodyLength: \d+, threshold: \d+ \}\s*$/;

function installStdoutNoiseFilter(): void {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  const filterChunk = (chunk: string | Uint8Array): boolean => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return noisySdkBodyLogPattern.test(text);
  };

  process.stdout.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    if (filterChunk(chunk)) {
      if (typeof encoding === "function") {
        encoding();
      } else {
        callback?.();
      }
      return true;
    }

    if (typeof encoding === "function") {
      return originalStdoutWrite(chunk, encoding);
    }

    return originalStdoutWrite(chunk, encoding, callback);
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    if (filterChunk(chunk)) {
      if (typeof encoding === "function") {
        encoding();
      } else {
        callback?.();
      }
      return true;
    }

    if (typeof encoding === "function") {
      return originalStderrWrite(chunk, encoding);
    }

    return originalStderrWrite(chunk, encoding, callback);
  }) as typeof process.stderr.write;
}

function parseArgs(argv: string[]): BenchmarkOptions {
  const options: BenchmarkOptions = {
    files: Number.parseInt(process.env.OAH_BENCH_SYNC_FILES || "64", 10) || 64,
    sizeBytes: Number.parseInt(process.env.OAH_BENCH_SYNC_SIZE_BYTES || "65536", 10) || 65536,
    bucket: process.env.OAH_BENCH_SYNC_BUCKET || "test-oah-server",
    endpoint: process.env.OAH_BENCH_SYNC_ENDPOINT || "http://127.0.0.1:9000",
    region: process.env.OAH_BENCH_SYNC_REGION || "us-east-1",
    accessKey: process.env.OAH_BENCH_SYNC_ACCESS_KEY || "oahadmin",
    secretKey: process.env.OAH_BENCH_SYNC_SECRET_KEY || "oahadmin123",
    forcePathStyle: process.env.OAH_BENCH_SYNC_FORCE_PATH_STYLE !== "0",
    memoryPollIntervalMs: Number.parseInt(process.env.OAH_BENCH_SYNC_MEMORY_POLL_MS || "10", 10) || 10
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (!arg?.startsWith("--") || value === undefined) {
      continue;
    }

    switch (arg) {
      case "--files":
        options.files = Math.max(1, Number.parseInt(value, 10) || options.files);
        index += 1;
        break;
      case "--size-bytes":
        options.sizeBytes = Math.max(1, Number.parseInt(value, 10) || options.sizeBytes);
        index += 1;
        break;
      case "--bucket":
        options.bucket = value;
        index += 1;
        break;
      case "--endpoint":
        options.endpoint = value;
        index += 1;
        break;
      case "--region":
        options.region = value;
        index += 1;
        break;
      case "--access-key":
        options.accessKey = value;
        index += 1;
        break;
      case "--secret-key":
        options.secretKey = value;
        index += 1;
        break;
      case "--force-path-style":
        options.forcePathStyle = value !== "0" && value !== "false";
        index += 1;
        break;
      case "--memory-poll-ms":
        options.memoryPollIntervalMs = Math.max(1, Number.parseInt(value, 10) || options.memoryPollIntervalMs);
        index += 1;
        break;
      default:
        break;
    }
  }

  return options;
}

async function createFixture(rootDir: string, files: number, sizeBytes: number): Promise<void> {
  const payload = Buffer.alloc(sizeBytes, "a");
  for (let index = 0; index < files; index += 1) {
    const relativeDirectory = path.join(
      `batch-${String(index % 8).padStart(2, "0")}`,
      `group-${String(index % 4).padStart(2, "0")}`
    );
    const absoluteDirectory = path.join(rootDir, relativeDirectory);
    const absoluteFile = path.join(absoluteDirectory, `file-${String(index).padStart(4, "0")}.txt`);
    await mkdir(absoluteDirectory, { recursive: true });
    await writeFile(absoluteFile, payload);
    const mtime = new Date(Date.now() - index * 1000);
    await utimes(absoluteFile, mtime, mtime);
  }
}

async function countLocalFiles(rootDir: string): Promise<number> {
  let count = 0;
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(target);
      } else if (entry.isFile()) {
        count += 1;
      }
    }
  };
  await walk(rootDir);
  return count;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function bytesToMiB(value: number): number {
  return round(value / (1024 * 1024));
}

async function measureOperation<T>(pollIntervalMs: number, action: () => Promise<T>): Promise<TimedMeasurement<T>> {
  const before = process.memoryUsage();
  let peakRss = before.rss;
  let peakHeap = before.heapUsed;
  const sampler = setInterval(() => {
    const current = process.memoryUsage();
    peakRss = Math.max(peakRss, current.rss);
    peakHeap = Math.max(peakHeap, current.heapUsed);
  }, pollIntervalMs);

  const start = performance.now();
  try {
    const result = await action();
    const after = process.memoryUsage();
    return {
      durationMs: performance.now() - start,
      memory: {
        rssBeforeMiB: bytesToMiB(before.rss),
        rssAfterMiB: bytesToMiB(after.rss),
        rssPeakDeltaMiB: bytesToMiB(Math.max(0, peakRss - before.rss)),
        heapBeforeMiB: bytesToMiB(before.heapUsed),
        heapAfterMiB: bytesToMiB(after.heapUsed),
        heapPeakDeltaMiB: bytesToMiB(Math.max(0, peakHeap - before.heapUsed))
      },
      result
    };
  } finally {
    clearInterval(sampler);
  }
}

async function collectSeedUploadPlanTs(input: { currentLocalPath: string; currentRemotePath: string }): Promise<SeedUploadPlan> {
  const directories: string[] = [];
  const files: Array<{ localPath: string; remotePath: string }> = [];
  const entries = await readdir(input.currentLocalPath, { withFileTypes: true });

  for (const entry of entries) {
    const localPath = path.join(input.currentLocalPath, entry.name);
    const remotePath = path.posix.join(input.currentRemotePath, entry.name);

    if (entry.isDirectory()) {
      directories.push(remotePath);
      const nested = await collectSeedUploadPlanTs({
        currentLocalPath: localPath,
        currentRemotePath: remotePath
      });
      directories.push(...nested.directories);
      files.push(...nested.files);
      continue;
    }

    if (entry.isFile()) {
      files.push({
        localPath,
        remotePath
      });
    }
  }

  return { directories, files };
}

async function runCase(options: {
  label: string;
  nativeEnabled: boolean;
  remotePrefix: string;
  benchmark: BenchmarkOptions;
}): Promise<{
  seedPlanMs: number;
  pushMs: number;
  materializeMs: number;
  pullMs: number;
  seedPlanMemory: MemorySample;
  pushMemory: MemorySample;
  materializeMemory: MemorySample;
  pullMemory: MemorySample;
  plannedSeedFileCount: number;
  uploadedFileCount: number;
  materializedFileCount: number;
  pulledFileCount: number;
}> {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "oah-bench-source-"));
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "oah-bench-target-"));
  const materializationCacheRoot = await mkdtemp(path.join(os.tmpdir(), "oah-bench-materialization-"));
  const store = createDirectoryObjectStore({
    provider: "s3",
    bucket: options.benchmark.bucket,
    region: options.benchmark.region,
    endpoint: options.benchmark.endpoint,
    force_path_style: options.benchmark.forcePathStyle,
    access_key: options.benchmark.accessKey,
    secret_key: options.benchmark.secretKey
  });

  process.env.OAH_NATIVE_WORKSPACE_SYNC = options.nativeEnabled ? "1" : "0";

  try {
    await createFixture(sourceDir, options.benchmark.files, options.benchmark.sizeBytes);

    const seedPlanMeasurement = await measureOperation(options.benchmark.memoryPollIntervalMs, async () => {
      if (options.nativeEnabled) {
        return planNativeSeedUpload({
          rootDir: sourceDir,
          remoteBasePath: "/workspace"
        });
      }

      return collectSeedUploadPlanTs({
        currentLocalPath: sourceDir,
        currentRemotePath: "/workspace"
      });
    });

    const pushMeasurement = await measureOperation(options.benchmark.memoryPollIntervalMs, async () =>
      syncLocalDirectoryToRemote(store, options.remotePrefix, sourceDir)
    );

    const materializationManager = new WorkspaceMaterializationManager({
      cacheRoot: materializationCacheRoot,
      workerId: `bench-${options.label}`,
      store
    });
    const materializeMeasurement = await measureOperation(options.benchmark.memoryPollIntervalMs, async () => {
      const lease = await materializationManager.acquireWorkspace({
        workspace: {
          id: `bench-${options.label}`,
          rootPath: path.join(materializationCacheRoot, "workspace"),
          externalRef: `s3://${options.benchmark.bucket}/${options.remotePrefix}`,
          ownerId: undefined
        }
      });
      try {
        return {
          localPath: lease.localPath
        };
      } finally {
        await lease.release();
      }
    });
    const materializedFileCount = await countLocalFiles(materializeMeasurement.result.localPath);
    await materializationManager.close();

    const pullMeasurement = await measureOperation(options.benchmark.memoryPollIntervalMs, async () =>
      syncRemotePrefixToLocal(store, options.remotePrefix, targetDir)
    );

    return {
      seedPlanMs: seedPlanMeasurement.durationMs,
      pushMs: pushMeasurement.durationMs,
      materializeMs: materializeMeasurement.durationMs,
      pullMs: pullMeasurement.durationMs,
      seedPlanMemory: seedPlanMeasurement.memory,
      pushMemory: pushMeasurement.memory,
      materializeMemory: materializeMeasurement.memory,
      pullMemory: pullMeasurement.memory,
      plannedSeedFileCount: seedPlanMeasurement.result.files.length,
      uploadedFileCount: pushMeasurement.result.uploadedFileCount,
      materializedFileCount,
      pulledFileCount: await countLocalFiles(targetDir)
    };
  } finally {
    await deleteRemotePrefixFromObjectStore(store, options.remotePrefix).catch(() => undefined);
    await rm(sourceDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
    await rm(materializationCacheRoot, { recursive: true, force: true });
    await (store as { close?: (() => Promise<void>) | undefined }).close?.();
  }
}

async function main(): Promise<void> {
  installStdoutNoiseFilter();
  const options = parseArgs(process.argv.slice(2));
  const runId = Date.now().toString(36);
  const sharedPrefix = `benchmarks/object-storage-sync/${runId}`;

  console.log(
    `Benchmarking object-storage sync against ${options.endpoint} bucket=${options.bucket} prefix=${sharedPrefix} files=${options.files} sizeBytes=${options.sizeBytes}`
  );
  console.log(
    "This script expects the target bucket to already exist. In the local stack, `pnpm storage:sync` prepares the default `test-oah-server` bucket."
  );

  const typescriptCase = await runCase({
    label: "typescript",
    nativeEnabled: false,
    remotePrefix: `${sharedPrefix}/typescript`,
    benchmark: options
  });
  const nativeCase = await runCase({
    label: "native",
    nativeEnabled: true,
    remotePrefix: `${sharedPrefix}/native`,
    benchmark: options
  });

  console.table([
    {
      mode: "typescript",
      seedPlanMs: Math.round(typescriptCase.seedPlanMs),
      pushMs: Math.round(typescriptCase.pushMs),
      materializeMs: Math.round(typescriptCase.materializeMs),
      pullMs: Math.round(typescriptCase.pullMs),
      plannedSeedFiles: typescriptCase.plannedSeedFileCount,
      uploadedFiles: typescriptCase.uploadedFileCount,
      materializedFiles: typescriptCase.materializedFileCount,
      pulledFiles: typescriptCase.pulledFileCount
    },
    {
      mode: "native",
      seedPlanMs: Math.round(nativeCase.seedPlanMs),
      pushMs: Math.round(nativeCase.pushMs),
      materializeMs: Math.round(nativeCase.materializeMs),
      pullMs: Math.round(nativeCase.pullMs),
      plannedSeedFiles: nativeCase.plannedSeedFileCount,
      uploadedFiles: nativeCase.uploadedFileCount,
      materializedFiles: nativeCase.materializedFileCount,
      pulledFiles: nativeCase.pulledFileCount
    }
  ]);

  console.table([
    {
      mode: "typescript",
      seedPlanRssPeakMiB: typescriptCase.seedPlanMemory.rssPeakDeltaMiB,
      pushRssPeakMiB: typescriptCase.pushMemory.rssPeakDeltaMiB,
      materializeRssPeakMiB: typescriptCase.materializeMemory.rssPeakDeltaMiB,
      pullRssPeakMiB: typescriptCase.pullMemory.rssPeakDeltaMiB,
      seedPlanHeapPeakMiB: typescriptCase.seedPlanMemory.heapPeakDeltaMiB,
      pushHeapPeakMiB: typescriptCase.pushMemory.heapPeakDeltaMiB,
      materializeHeapPeakMiB: typescriptCase.materializeMemory.heapPeakDeltaMiB,
      pullHeapPeakMiB: typescriptCase.pullMemory.heapPeakDeltaMiB
    },
    {
      mode: "native",
      seedPlanRssPeakMiB: nativeCase.seedPlanMemory.rssPeakDeltaMiB,
      pushRssPeakMiB: nativeCase.pushMemory.rssPeakDeltaMiB,
      materializeRssPeakMiB: nativeCase.materializeMemory.rssPeakDeltaMiB,
      pullRssPeakMiB: nativeCase.pullMemory.rssPeakDeltaMiB,
      seedPlanHeapPeakMiB: nativeCase.seedPlanMemory.heapPeakDeltaMiB,
      pushHeapPeakMiB: nativeCase.pushMemory.heapPeakDeltaMiB,
      materializeHeapPeakMiB: nativeCase.materializeMemory.heapPeakDeltaMiB,
      pullHeapPeakMiB: nativeCase.pullMemory.heapPeakDeltaMiB
    }
  ]);

  console.log(
    `Native delta: seed-plan ${Math.round(typescriptCase.seedPlanMs - nativeCase.seedPlanMs)}ms, push ${Math.round(
      typescriptCase.pushMs - nativeCase.pushMs
    )}ms, materialize ${Math.round(typescriptCase.materializeMs - nativeCase.materializeMs)}ms, pull ${Math.round(
      typescriptCase.pullMs - nativeCase.pullMs
    )}ms`
  );
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
