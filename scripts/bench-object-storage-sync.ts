import { performance } from "node:perf_hooks";
import { mkdtemp, mkdir, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { planNativeSeedUpload, shutdownNativeWorkspaceSyncWorkerPool } from "../packages/native-bridge/src/index.ts";
import { WorkspaceMaterializationManager } from "../apps/server/src/bootstrap/workspace-materialization.ts";
import {
  createDirectoryObjectStore,
  deleteRemotePrefixFromObjectStore,
  syncLocalDirectoryToRemote,
  syncRemotePrefixToLocal,
  type DirectoryObjectStore
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

type BenchmarkMode = "typescript" | "typescript-primary" | "native-oneshot" | "native-persistent";

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

interface StoreOperationCounts {
  listEntries: number;
  getObject: number;
  getObjectInfo: number;
  putObject: number;
  deleteObjects: number;
  deleteKeys: number;
}

interface BenchmarkCaseResult {
  seedPlanMs: number;
  pushMs: number;
  pushWarmMs: number;
  materializeMs: number;
  pullMs: number;
  seedPlanMemory: MemorySample;
  pushMemory: MemorySample;
  pushWarmMemory: MemorySample;
  materializeMemory: MemorySample;
  pullMemory: MemorySample;
  plannedSeedFileCount: number;
  uploadedFileCount: number;
  materializedFileCount: number;
  pulledFileCount: number;
  pushPhaseTimings?: NativeSyncLocalToRemotePhaseTimingsLike | undefined;
  pushWarmPhaseTimings?: NativeSyncLocalToRemotePhaseTimingsLike | undefined;
  pushBridgeTimings?: NativeWorkspaceSyncBridgeTimingsLike | undefined;
  pushWarmBridgeTimings?: NativeWorkspaceSyncBridgeTimingsLike | undefined;
  pushWorkerTimings?: NativeWorkspaceSyncWorkerTimingsLike | undefined;
  pushWarmWorkerTimings?: NativeWorkspaceSyncWorkerTimingsLike | undefined;
  pushWrapperTimings?: DirectorySyncWrapperTimingsLike | undefined;
  pushWarmWrapperTimings?: DirectorySyncWrapperTimingsLike | undefined;
  materializePhaseTimings?: NativeSyncRemoteToLocalPhaseTimingsLike | undefined;
  pullPhaseTimings?: NativeSyncRemoteToLocalPhaseTimingsLike | undefined;
  pushRequests: StoreOperationCounts;
  pushWarmRequests: StoreOperationCounts;
  materializeRequests: StoreOperationCounts;
  pullRequests: StoreOperationCounts;
}

interface CountingDirectoryObjectStore extends DirectoryObjectStore {
  close?: (() => Promise<void>) | undefined;
  getCounts(): StoreOperationCounts;
}

interface NativeRequestCountsLike {
  listRequests: number;
  getRequests: number;
  headRequests: number;
  putRequests: number;
  deleteRequests: number;
}

interface NativeSyncLocalToRemotePhaseTimingsLike {
  scanMs: number;
  fingerprintMs: number;
  clientCreateMs: number;
  manifestReadMs: number;
  bundleBuildMs: number;
  bundleBodyPrepareMs: number;
  bundleUploadMs: number;
  bundleTransport: "none" | "memory" | "tempfile";
  bundleBytes: number;
  manifestWriteMs: number;
  deleteMs: number;
  totalPrimaryPathMs: number;
  totalCommandMs: number;
}

interface NativeSyncRemoteToLocalPhaseTimingsLike {
  scanMs: number;
  clientCreateMs: number;
  listingMs: number;
  manifestReadMs: number;
  planMs: number;
  removeMs: number;
  mkdirMs: number;
  bundleGetMs: number;
  bundleBodyReadMs: number;
  bundleExtractMs: number;
  bundleTransport: "none" | "memory" | "tempfile";
  bundleExtractor: "none" | "rust-ustar" | "tar";
  bundleBytes: number;
  downloadMs: number;
  infoCheckMs: number;
  fingerprintMs: number;
  totalCommandMs: number;
}

interface NativeWorkspaceSyncBridgeTimingsLike {
  mode: "persistent" | "oneshot";
  poolInitMs: number;
  queueWaitMs: number;
  writeMs: number;
  responseWaitMs: number;
  totalBridgeMs: number;
}

interface DirectorySyncWrapperTimingsLike {
  nativeCallMs: number;
  pruneEmptyDirectoriesMs: number;
  totalNativeWrapperMs: number;
}

interface NativeWorkspaceSyncWorkerTimingsLike {
  receiveDelayMs: number;
  parseMs: number;
  handleMs: number;
  serializeMs: number;
  writeMs: number;
  totalWorkerMs: number;
}

const WORKSPACE_SYNC_BINARY_BASENAME = process.platform === "win32" ? "oah-workspace-sync.exe" : "oah-workspace-sync";

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

async function resolveKnownGoodWorkspaceSyncBinary(): Promise<string | undefined> {
  const configured = process.env.OAH_NATIVE_WORKSPACE_SYNC_BINARY?.trim();
  if (configured) {
    return configured;
  }

  const candidates = [
    path.resolve(process.cwd(), ".native-target", "release", WORKSPACE_SYNC_BINARY_BASENAME),
    path.resolve(process.cwd(), "native", "target", "release", WORKSPACE_SYNC_BINARY_BASENAME),
    path.resolve(process.cwd(), "native", "target", "debug", WORKSPACE_SYNC_BINARY_BASENAME),
    path.resolve(process.cwd(), "native", "bin", WORKSPACE_SYNC_BINARY_BASENAME)
  ];

  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) {
        return candidate;
      }
    } catch {
      // Ignore missing candidates and keep scanning.
    }
  }

  return undefined;
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

function createEmptyStoreOperationCounts(): StoreOperationCounts {
  return {
    listEntries: 0,
    getObject: 0,
    getObjectInfo: 0,
    putObject: 0,
    deleteObjects: 0,
    deleteKeys: 0
  };
}

function diffStoreOperationCounts(after: StoreOperationCounts, before: StoreOperationCounts): StoreOperationCounts {
  return {
    listEntries: after.listEntries - before.listEntries,
    getObject: after.getObject - before.getObject,
    getObjectInfo: after.getObjectInfo - before.getObjectInfo,
    putObject: after.putObject - before.putObject,
    deleteObjects: after.deleteObjects - before.deleteObjects,
    deleteKeys: after.deleteKeys - before.deleteKeys
  };
}

function mergeStoreOperationCounts(left: StoreOperationCounts, right: StoreOperationCounts): StoreOperationCounts {
  return {
    listEntries: left.listEntries + right.listEntries,
    getObject: left.getObject + right.getObject,
    getObjectInfo: left.getObjectInfo + right.getObjectInfo,
    putObject: left.putObject + right.putObject,
    deleteObjects: left.deleteObjects + right.deleteObjects,
    deleteKeys: left.deleteKeys + right.deleteKeys
  };
}

function sumStoreOperationCounts(counts: StoreOperationCounts): number {
  return counts.listEntries + counts.getObject + counts.getObjectInfo + counts.putObject + counts.deleteObjects;
}

function convertNativeRequestCounts(counts: NativeRequestCountsLike | undefined): StoreOperationCounts | undefined {
  if (!counts) {
    return undefined;
  }

  return {
    listEntries: counts.listRequests,
    getObject: counts.getRequests,
    getObjectInfo: counts.headRequests,
    putObject: counts.putRequests,
    deleteObjects: counts.deleteRequests,
    deleteKeys: 0
  };
}

function createCountingStore(store: DirectoryObjectStore & { close?: (() => Promise<void>) | undefined }): CountingDirectoryObjectStore {
  const counts = createEmptyStoreOperationCounts();

  return {
    bucket: store.bucket,
    listEntries: async (prefix: string) => {
      counts.listEntries += 1;
      return store.listEntries(prefix);
    },
    getObject: async (key: string) => {
      counts.getObject += 1;
      return store.getObject(key);
    },
    getObjectInfo: store.getObjectInfo
      ? async (key: string) => {
          counts.getObjectInfo += 1;
          return store.getObjectInfo?.(key) ?? {};
        }
      : undefined,
    putObject: async (key: string, body: Buffer, options?: { mtimeMs?: number | undefined }) => {
      counts.putObject += 1;
      return store.putObject(key, body, options);
    },
    deleteObjects: async (keys: string[]) => {
      counts.deleteObjects += 1;
      counts.deleteKeys += keys.length;
      return store.deleteObjects(keys);
    },
    getNativeWorkspaceSyncConfig: store.getNativeWorkspaceSyncConfig
      ? () => store.getNativeWorkspaceSyncConfig?.()
      : undefined,
    close: store.close ? async () => store.close?.() : undefined,
    getCounts: () => ({ ...counts })
  };
}

function formatPhaseTimings(timings: NativeSyncLocalToRemotePhaseTimingsLike | undefined): string {
  if (!timings) {
    return "n/a";
  }

  return [
    `scan=${timings.scanMs}ms`,
    `fingerprint=${timings.fingerprintMs}ms`,
    `client-create=${timings.clientCreateMs}ms`,
    `manifest=${timings.manifestReadMs}ms`,
    `bundle-build=${timings.bundleBuildMs}ms`,
    `bundle-body-prepare=${timings.bundleBodyPrepareMs}ms`,
    `bundle-upload=${timings.bundleUploadMs}ms`,
    `bundle-transport=${timings.bundleTransport}`,
    `bundle-bytes=${timings.bundleBytes}`,
    `manifest-write=${timings.manifestWriteMs}ms`,
    `delete=${timings.deleteMs}ms`,
    `primary-total=${timings.totalPrimaryPathMs}ms`,
    `command-total=${timings.totalCommandMs}ms`
  ].join(" ");
}

function formatBridgeTimings(timings: NativeWorkspaceSyncBridgeTimingsLike | undefined): string {
  if (!timings) {
    return "n/a";
  }

  return [
    `mode=${timings.mode}`,
    `pool-init=${timings.poolInitMs}ms`,
    `queue=${timings.queueWaitMs}ms`,
    `write=${timings.writeMs}ms`,
    `response=${timings.responseWaitMs}ms`,
    `bridge-total=${timings.totalBridgeMs}ms`
  ].join(" ");
}

function formatRemotePhaseTimings(timings: NativeSyncRemoteToLocalPhaseTimingsLike | undefined): string {
  if (!timings) {
    return "n/a";
  }

  return [
    `scan=${timings.scanMs}ms`,
    `client-create=${timings.clientCreateMs}ms`,
    `listing=${timings.listingMs}ms`,
    `manifest=${timings.manifestReadMs}ms`,
    `plan=${timings.planMs}ms`,
    `remove=${timings.removeMs}ms`,
    `mkdir=${timings.mkdirMs}ms`,
    `bundle-get=${timings.bundleGetMs}ms`,
    `bundle-body-read=${timings.bundleBodyReadMs}ms`,
    `bundle-extract=${timings.bundleExtractMs}ms`,
    `bundle-transport=${timings.bundleTransport}`,
    `bundle-extractor=${timings.bundleExtractor}`,
    `bundle-bytes=${timings.bundleBytes}`,
    `download=${timings.downloadMs}ms`,
    `info-check=${timings.infoCheckMs}ms`,
    `fingerprint=${timings.fingerprintMs}ms`,
    `command-total=${timings.totalCommandMs}ms`
  ].join(" ");
}

function formatWrapperTimings(timings: DirectorySyncWrapperTimingsLike | undefined): string {
  if (!timings) {
    return "n/a";
  }

  return [
    `native-call=${timings.nativeCallMs}ms`,
    `prune=${timings.pruneEmptyDirectoriesMs}ms`,
    `wrapper-total=${timings.totalNativeWrapperMs}ms`
  ].join(" ");
}

function formatWorkerTimings(timings: NativeWorkspaceSyncWorkerTimingsLike | undefined): string {
  if (!timings) {
    return "n/a";
  }

  return [
    `receive-delay=${timings.receiveDelayMs}ms`,
    `parse=${timings.parseMs}ms`,
    `handle=${timings.handleMs}ms`,
    `serialize=${timings.serializeMs}ms`,
    `write=${timings.writeMs}ms`,
    `worker-total=${timings.totalWorkerMs}ms`
  ].join(" ");
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
  label: BenchmarkMode;
  nativeEnabled: boolean;
  persistentNative: boolean;
  bundleLayout: "sidecar" | "primary";
  remotePrefix: string;
  benchmark: BenchmarkOptions;
}): Promise<BenchmarkCaseResult> {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "oah-bench-source-"));
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "oah-bench-target-"));
  const materializationCacheRoot = await mkdtemp(path.join(os.tmpdir(), "oah-bench-materialization-"));
  const store = createCountingStore(createDirectoryObjectStore({
    provider: "s3",
    bucket: options.benchmark.bucket,
    region: options.benchmark.region,
    endpoint: options.benchmark.endpoint,
    force_path_style: options.benchmark.forcePathStyle,
    access_key: options.benchmark.accessKey,
    secret_key: options.benchmark.secretKey
  }));

  process.env.OAH_NATIVE_WORKSPACE_SYNC = options.nativeEnabled ? "1" : "0";
  process.env.OAH_NATIVE_WORKSPACE_SYNC_PERSISTENT = options.persistentNative ? "1" : "0";
  process.env.OAH_OBJECT_STORAGE_SYNC_BUNDLE_LAYOUT = options.bundleLayout;
  process.env.OAH_OBJECT_STORAGE_SYNC_TRUST_MANAGED_PREFIXES = options.bundleLayout === "primary" ? "1" : "0";
  await shutdownNativeWorkspaceSyncWorkerPool();

  try {
    await createFixture(sourceDir, options.benchmark.files, options.benchmark.sizeBytes);

    console.log(`[bench-object-storage] case=${options.label} stage=seed-plan start prefix=${options.remotePrefix}`);
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
    console.log(`[bench-object-storage] case=${options.label} stage=seed-plan done ms=${Math.round(seedPlanMeasurement.durationMs)}`);

    console.log(`[bench-object-storage] case=${options.label} stage=push start prefix=${options.remotePrefix}`);
    const pushCountsBefore = store.getCounts();
    const pushMeasurement = await measureOperation(options.benchmark.memoryPollIntervalMs, async () =>
      syncLocalDirectoryToRemote(store, options.remotePrefix, sourceDir)
    );
    const pushStoreRequests = diffStoreOperationCounts(store.getCounts(), pushCountsBefore);
    const pushRequests = mergeStoreOperationCounts(
      pushStoreRequests,
      convertNativeRequestCounts(pushMeasurement.result.requestCounts) ?? createEmptyStoreOperationCounts()
    );
    console.log(
      `[bench-object-storage] case=${options.label} stage=push done ms=${Math.round(pushMeasurement.durationMs)} uploaded=${pushMeasurement.result.uploadedFileCount} requests=${sumStoreOperationCounts(pushRequests)} phases="${formatPhaseTimings(pushMeasurement.result.phaseTimings)}" bridge="${formatBridgeTimings(pushMeasurement.result.bridgeTimings)}" worker="${formatWorkerTimings(pushMeasurement.result.workerTimings)}" wrapper="${formatWrapperTimings(pushMeasurement.result.wrapperTimings)}"`
    );

    console.log(`[bench-object-storage] case=${options.label} stage=push-warm start prefix=${options.remotePrefix}`);
    const pushWarmCountsBefore = store.getCounts();
    const pushWarmMeasurement = await measureOperation(options.benchmark.memoryPollIntervalMs, async () =>
      syncLocalDirectoryToRemote(store, options.remotePrefix, sourceDir)
    );
    const pushWarmStoreRequests = diffStoreOperationCounts(store.getCounts(), pushWarmCountsBefore);
    const pushWarmRequests = mergeStoreOperationCounts(
      pushWarmStoreRequests,
      convertNativeRequestCounts(pushWarmMeasurement.result.requestCounts) ?? createEmptyStoreOperationCounts()
    );
    console.log(
      `[bench-object-storage] case=${options.label} stage=push-warm done ms=${Math.round(pushWarmMeasurement.durationMs)} uploaded=${pushWarmMeasurement.result.uploadedFileCount} requests=${sumStoreOperationCounts(pushWarmRequests)} phases="${formatPhaseTimings(pushWarmMeasurement.result.phaseTimings)}" bridge="${formatBridgeTimings(pushWarmMeasurement.result.bridgeTimings)}" worker="${formatWorkerTimings(pushWarmMeasurement.result.workerTimings)}" wrapper="${formatWrapperTimings(pushWarmMeasurement.result.wrapperTimings)}"`
    );

    const materializationManager = new WorkspaceMaterializationManager({
      cacheRoot: materializationCacheRoot,
      workerId: `bench-${options.label}`,
      store
    });
    console.log(`[bench-object-storage] case=${options.label} stage=materialize start prefix=${options.remotePrefix}`);
    const materializeCountsBefore = store.getCounts();
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
          localPath: lease.localPath,
          requestCounts: lease.materializeRequestCounts
        };
      } finally {
        await lease.release();
      }
    });
    const materializeStoreRequests = diffStoreOperationCounts(store.getCounts(), materializeCountsBefore);
    const materializeRequests = mergeStoreOperationCounts(
      materializeStoreRequests,
      convertNativeRequestCounts(materializeMeasurement.result.requestCounts) ?? createEmptyStoreOperationCounts()
    );
    const materializedFileCount = await countLocalFiles(materializeMeasurement.result.localPath);
    console.log(
      `[bench-object-storage] case=${options.label} stage=materialize done ms=${Math.round(materializeMeasurement.durationMs)} files=${materializedFileCount} requests=${sumStoreOperationCounts(materializeRequests)}`
    );
    await materializationManager.close();

    console.log(`[bench-object-storage] case=${options.label} stage=pull start prefix=${options.remotePrefix}`);
    const pullCountsBefore = store.getCounts();
    const pullMeasurement = await measureOperation(options.benchmark.memoryPollIntervalMs, async () =>
      syncRemotePrefixToLocal(store, options.remotePrefix, targetDir)
    );
    const pullStoreRequests = diffStoreOperationCounts(store.getCounts(), pullCountsBefore);
    const pullRequests = mergeStoreOperationCounts(
      pullStoreRequests,
      convertNativeRequestCounts(pullMeasurement.result.requestCounts) ?? createEmptyStoreOperationCounts()
    );
    const pulledFileCount = await countLocalFiles(targetDir);
    console.log(
      `[bench-object-storage] case=${options.label} stage=pull done ms=${Math.round(pullMeasurement.durationMs)} files=${pulledFileCount} requests=${sumStoreOperationCounts(pullRequests)}`
    );

    return {
      seedPlanMs: seedPlanMeasurement.durationMs,
      pushMs: pushMeasurement.durationMs,
      pushWarmMs: pushWarmMeasurement.durationMs,
      materializeMs: materializeMeasurement.durationMs,
      pullMs: pullMeasurement.durationMs,
      seedPlanMemory: seedPlanMeasurement.memory,
      pushMemory: pushMeasurement.memory,
      pushWarmMemory: pushWarmMeasurement.memory,
      materializeMemory: materializeMeasurement.memory,
      pullMemory: pullMeasurement.memory,
      plannedSeedFileCount: seedPlanMeasurement.result.files.length,
      uploadedFileCount: pushMeasurement.result.uploadedFileCount,
      materializedFileCount,
      pulledFileCount,
      pushPhaseTimings: pushMeasurement.result.phaseTimings,
      pushWarmPhaseTimings: pushWarmMeasurement.result.phaseTimings,
      pushBridgeTimings: pushMeasurement.result.bridgeTimings,
      pushWarmBridgeTimings: pushWarmMeasurement.result.bridgeTimings,
      pushWorkerTimings: pushMeasurement.result.workerTimings,
      pushWarmWorkerTimings: pushWarmMeasurement.result.workerTimings,
      pushWrapperTimings: pushMeasurement.result.wrapperTimings,
      pushWarmWrapperTimings: pushWarmMeasurement.result.wrapperTimings,
      pushRequests,
      pushWarmRequests,
      materializeRequests,
      pullRequests
    };
  } finally {
    await shutdownNativeWorkspaceSyncWorkerPool().catch(() => undefined);
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
  const nativeBinary = await resolveKnownGoodWorkspaceSyncBinary();
  if (nativeBinary) {
    process.env.OAH_NATIVE_WORKSPACE_SYNC_BINARY = nativeBinary;
  }
  process.env.OAH_NATIVE_WORKSPACE_SYNC_PERSISTENT = "0";
  await shutdownNativeWorkspaceSyncWorkerPool();
  const runId = Date.now().toString(36);
  const sharedPrefix = `benchmarks/object-storage-sync/${runId}`;

  console.log(
    `Benchmarking object-storage sync against ${options.endpoint} bucket=${options.bucket} prefix=${sharedPrefix} files=${options.files} sizeBytes=${options.sizeBytes}`
  );
  console.log(
    `Native workspace sync binary: ${process.env.OAH_NATIVE_WORKSPACE_SYNC_BINARY || "<not found>"}`
  );
  console.log(
    "This script expects the target bucket to already exist. In the local stack, `pnpm storage:sync` prepares the default `test-oah-server` bucket."
  );

  const typescriptCase = await runCase({
    label: "typescript",
    nativeEnabled: false,
    persistentNative: false,
    bundleLayout: "sidecar",
    remotePrefix: `${sharedPrefix}/typescript`,
    benchmark: options
  });
  const typescriptPrimaryCase = await runCase({
    label: "typescript-primary",
    nativeEnabled: false,
    persistentNative: false,
    bundleLayout: "primary",
    remotePrefix: `${sharedPrefix}/typescript-primary`,
    benchmark: options
  });
  const nativeOneShotCase = await runCase({
    label: "native-oneshot",
    nativeEnabled: true,
    persistentNative: false,
    bundleLayout: "primary",
    remotePrefix: `${sharedPrefix}/native-oneshot`,
    benchmark: options
  });
  const nativePersistentCase = await runCase({
    label: "native-persistent",
    nativeEnabled: true,
    persistentNative: true,
    bundleLayout: "primary",
    remotePrefix: `${sharedPrefix}/native-persistent`,
    benchmark: options
  });

  console.table([
    {
      mode: "typescript",
      seedPlanMs: Math.round(typescriptCase.seedPlanMs),
      pushMs: Math.round(typescriptCase.pushMs),
      pushWarmMs: Math.round(typescriptCase.pushWarmMs),
      materializeMs: Math.round(typescriptCase.materializeMs),
      pullMs: Math.round(typescriptCase.pullMs),
      plannedSeedFiles: typescriptCase.plannedSeedFileCount,
      uploadedFiles: typescriptCase.uploadedFileCount,
      materializedFiles: typescriptCase.materializedFileCount,
      pulledFiles: typescriptCase.pulledFileCount
    },
    {
      mode: "typescript-primary",
      seedPlanMs: Math.round(typescriptPrimaryCase.seedPlanMs),
      pushMs: Math.round(typescriptPrimaryCase.pushMs),
      pushWarmMs: Math.round(typescriptPrimaryCase.pushWarmMs),
      materializeMs: Math.round(typescriptPrimaryCase.materializeMs),
      pullMs: Math.round(typescriptPrimaryCase.pullMs),
      plannedSeedFiles: typescriptPrimaryCase.plannedSeedFileCount,
      uploadedFiles: typescriptPrimaryCase.uploadedFileCount,
      materializedFiles: typescriptPrimaryCase.materializedFileCount,
      pulledFiles: typescriptPrimaryCase.pulledFileCount
    },
    {
      mode: "native-oneshot",
      seedPlanMs: Math.round(nativeOneShotCase.seedPlanMs),
      pushMs: Math.round(nativeOneShotCase.pushMs),
      pushWarmMs: Math.round(nativeOneShotCase.pushWarmMs),
      materializeMs: Math.round(nativeOneShotCase.materializeMs),
      pullMs: Math.round(nativeOneShotCase.pullMs),
      plannedSeedFiles: nativeOneShotCase.plannedSeedFileCount,
      uploadedFiles: nativeOneShotCase.uploadedFileCount,
      materializedFiles: nativeOneShotCase.materializedFileCount,
      pulledFiles: nativeOneShotCase.pulledFileCount
    },
    {
      mode: "native-persistent",
      seedPlanMs: Math.round(nativePersistentCase.seedPlanMs),
      pushMs: Math.round(nativePersistentCase.pushMs),
      pushWarmMs: Math.round(nativePersistentCase.pushWarmMs),
      materializeMs: Math.round(nativePersistentCase.materializeMs),
      pullMs: Math.round(nativePersistentCase.pullMs),
      plannedSeedFiles: nativePersistentCase.plannedSeedFileCount,
      uploadedFiles: nativePersistentCase.uploadedFileCount,
      materializedFiles: nativePersistentCase.materializedFileCount,
      pulledFiles: nativePersistentCase.pulledFileCount
    }
  ]);

  console.table([
    {
      mode: "typescript",
      seedPlanRssPeakMiB: typescriptCase.seedPlanMemory.rssPeakDeltaMiB,
      pushRssPeakMiB: typescriptCase.pushMemory.rssPeakDeltaMiB,
      pushWarmRssPeakMiB: typescriptCase.pushWarmMemory.rssPeakDeltaMiB,
      materializeRssPeakMiB: typescriptCase.materializeMemory.rssPeakDeltaMiB,
      pullRssPeakMiB: typescriptCase.pullMemory.rssPeakDeltaMiB,
      seedPlanHeapPeakMiB: typescriptCase.seedPlanMemory.heapPeakDeltaMiB,
      pushHeapPeakMiB: typescriptCase.pushMemory.heapPeakDeltaMiB,
      pushWarmHeapPeakMiB: typescriptCase.pushWarmMemory.heapPeakDeltaMiB,
      materializeHeapPeakMiB: typescriptCase.materializeMemory.heapPeakDeltaMiB,
      pullHeapPeakMiB: typescriptCase.pullMemory.heapPeakDeltaMiB
    },
    {
      mode: "typescript-primary",
      seedPlanRssPeakMiB: typescriptPrimaryCase.seedPlanMemory.rssPeakDeltaMiB,
      pushRssPeakMiB: typescriptPrimaryCase.pushMemory.rssPeakDeltaMiB,
      pushWarmRssPeakMiB: typescriptPrimaryCase.pushWarmMemory.rssPeakDeltaMiB,
      materializeRssPeakMiB: typescriptPrimaryCase.materializeMemory.rssPeakDeltaMiB,
      pullRssPeakMiB: typescriptPrimaryCase.pullMemory.rssPeakDeltaMiB,
      seedPlanHeapPeakMiB: typescriptPrimaryCase.seedPlanMemory.heapPeakDeltaMiB,
      pushHeapPeakMiB: typescriptPrimaryCase.pushMemory.heapPeakDeltaMiB,
      pushWarmHeapPeakMiB: typescriptPrimaryCase.pushWarmMemory.heapPeakDeltaMiB,
      materializeHeapPeakMiB: typescriptPrimaryCase.materializeMemory.heapPeakDeltaMiB,
      pullHeapPeakMiB: typescriptPrimaryCase.pullMemory.heapPeakDeltaMiB
    },
    {
      mode: "native-oneshot",
      seedPlanRssPeakMiB: nativeOneShotCase.seedPlanMemory.rssPeakDeltaMiB,
      pushRssPeakMiB: nativeOneShotCase.pushMemory.rssPeakDeltaMiB,
      pushWarmRssPeakMiB: nativeOneShotCase.pushWarmMemory.rssPeakDeltaMiB,
      materializeRssPeakMiB: nativeOneShotCase.materializeMemory.rssPeakDeltaMiB,
      pullRssPeakMiB: nativeOneShotCase.pullMemory.rssPeakDeltaMiB,
      seedPlanHeapPeakMiB: nativeOneShotCase.seedPlanMemory.heapPeakDeltaMiB,
      pushHeapPeakMiB: nativeOneShotCase.pushMemory.heapPeakDeltaMiB,
      pushWarmHeapPeakMiB: nativeOneShotCase.pushWarmMemory.heapPeakDeltaMiB,
      materializeHeapPeakMiB: nativeOneShotCase.materializeMemory.heapPeakDeltaMiB,
      pullHeapPeakMiB: nativeOneShotCase.pullMemory.heapPeakDeltaMiB
    },
    {
      mode: "native-persistent",
      seedPlanRssPeakMiB: nativePersistentCase.seedPlanMemory.rssPeakDeltaMiB,
      pushRssPeakMiB: nativePersistentCase.pushMemory.rssPeakDeltaMiB,
      pushWarmRssPeakMiB: nativePersistentCase.pushWarmMemory.rssPeakDeltaMiB,
      materializeRssPeakMiB: nativePersistentCase.materializeMemory.rssPeakDeltaMiB,
      pullRssPeakMiB: nativePersistentCase.pullMemory.rssPeakDeltaMiB,
      seedPlanHeapPeakMiB: nativePersistentCase.seedPlanMemory.heapPeakDeltaMiB,
      pushHeapPeakMiB: nativePersistentCase.pushMemory.heapPeakDeltaMiB,
      pushWarmHeapPeakMiB: nativePersistentCase.pushWarmMemory.heapPeakDeltaMiB,
      materializeHeapPeakMiB: nativePersistentCase.materializeMemory.heapPeakDeltaMiB,
      pullHeapPeakMiB: nativePersistentCase.pullMemory.heapPeakDeltaMiB
    }
  ]);

  console.table([
    {
      mode: "typescript",
      pushRequests: sumStoreOperationCounts(typescriptCase.pushRequests),
      pushWarmRequests: sumStoreOperationCounts(typescriptCase.pushWarmRequests),
      pushList: typescriptCase.pushRequests.listEntries,
      pushGet: typescriptCase.pushRequests.getObject,
      pushHead: typescriptCase.pushRequests.getObjectInfo,
      pushPut: typescriptCase.pushRequests.putObject,
      pushDelete: typescriptCase.pushRequests.deleteObjects,
      materializeRequests: sumStoreOperationCounts(typescriptCase.materializeRequests),
      pullRequests: sumStoreOperationCounts(typescriptCase.pullRequests)
    },
    {
      mode: "typescript-primary",
      pushRequests: sumStoreOperationCounts(typescriptPrimaryCase.pushRequests),
      pushWarmRequests: sumStoreOperationCounts(typescriptPrimaryCase.pushWarmRequests),
      pushList: typescriptPrimaryCase.pushRequests.listEntries,
      pushGet: typescriptPrimaryCase.pushRequests.getObject,
      pushHead: typescriptPrimaryCase.pushRequests.getObjectInfo,
      pushPut: typescriptPrimaryCase.pushRequests.putObject,
      pushDelete: typescriptPrimaryCase.pushRequests.deleteObjects,
      materializeRequests: sumStoreOperationCounts(typescriptPrimaryCase.materializeRequests),
      pullRequests: sumStoreOperationCounts(typescriptPrimaryCase.pullRequests)
    },
    {
      mode: "native-oneshot",
      pushRequests: sumStoreOperationCounts(nativeOneShotCase.pushRequests),
      pushWarmRequests: sumStoreOperationCounts(nativeOneShotCase.pushWarmRequests),
      pushList: nativeOneShotCase.pushRequests.listEntries,
      pushGet: nativeOneShotCase.pushRequests.getObject,
      pushHead: nativeOneShotCase.pushRequests.getObjectInfo,
      pushPut: nativeOneShotCase.pushRequests.putObject,
      pushDelete: nativeOneShotCase.pushRequests.deleteObjects,
      materializeRequests: sumStoreOperationCounts(nativeOneShotCase.materializeRequests),
      pullRequests: sumStoreOperationCounts(nativeOneShotCase.pullRequests)
    },
    {
      mode: "native-persistent",
      pushRequests: sumStoreOperationCounts(nativePersistentCase.pushRequests),
      pushWarmRequests: sumStoreOperationCounts(nativePersistentCase.pushWarmRequests),
      pushList: nativePersistentCase.pushRequests.listEntries,
      pushGet: nativePersistentCase.pushRequests.getObject,
      pushHead: nativePersistentCase.pushRequests.getObjectInfo,
      pushPut: nativePersistentCase.pushRequests.putObject,
      pushDelete: nativePersistentCase.pushRequests.deleteObjects,
      materializeRequests: sumStoreOperationCounts(nativePersistentCase.materializeRequests),
      pullRequests: sumStoreOperationCounts(nativePersistentCase.pullRequests)
    }
  ]);

  console.table([
    {
      mode: "typescript",
      materializeList: typescriptCase.materializeRequests.listEntries,
      materializeGet: typescriptCase.materializeRequests.getObject,
      materializeHead: typescriptCase.materializeRequests.getObjectInfo,
      materializePut: typescriptCase.materializeRequests.putObject,
      materializeDelete: typescriptCase.materializeRequests.deleteObjects,
      pullList: typescriptCase.pullRequests.listEntries,
      pullGet: typescriptCase.pullRequests.getObject,
      pullHead: typescriptCase.pullRequests.getObjectInfo,
      pullPut: typescriptCase.pullRequests.putObject,
      pullDelete: typescriptCase.pullRequests.deleteObjects
    },
    {
      mode: "typescript-primary",
      materializeList: typescriptPrimaryCase.materializeRequests.listEntries,
      materializeGet: typescriptPrimaryCase.materializeRequests.getObject,
      materializeHead: typescriptPrimaryCase.materializeRequests.getObjectInfo,
      materializePut: typescriptPrimaryCase.materializeRequests.putObject,
      materializeDelete: typescriptPrimaryCase.materializeRequests.deleteObjects,
      pullList: typescriptPrimaryCase.pullRequests.listEntries,
      pullGet: typescriptPrimaryCase.pullRequests.getObject,
      pullHead: typescriptPrimaryCase.pullRequests.getObjectInfo,
      pullPut: typescriptPrimaryCase.pullRequests.putObject,
      pullDelete: typescriptPrimaryCase.pullRequests.deleteObjects
    },
    {
      mode: "native-oneshot",
      materializeList: nativeOneShotCase.materializeRequests.listEntries,
      materializeGet: nativeOneShotCase.materializeRequests.getObject,
      materializeHead: nativeOneShotCase.materializeRequests.getObjectInfo,
      materializePut: nativeOneShotCase.materializeRequests.putObject,
      materializeDelete: nativeOneShotCase.materializeRequests.deleteObjects,
      pullList: nativeOneShotCase.pullRequests.listEntries,
      pullGet: nativeOneShotCase.pullRequests.getObject,
      pullHead: nativeOneShotCase.pullRequests.getObjectInfo,
      pullPut: nativeOneShotCase.pullRequests.putObject,
      pullDelete: nativeOneShotCase.pullRequests.deleteObjects
    },
    {
      mode: "native-persistent",
      materializeList: nativePersistentCase.materializeRequests.listEntries,
      materializeGet: nativePersistentCase.materializeRequests.getObject,
      materializeHead: nativePersistentCase.materializeRequests.getObjectInfo,
      materializePut: nativePersistentCase.materializeRequests.putObject,
      materializeDelete: nativePersistentCase.materializeRequests.deleteObjects,
      pullList: nativePersistentCase.pullRequests.listEntries,
      pullGet: nativePersistentCase.pullRequests.getObject,
      pullHead: nativePersistentCase.pullRequests.getObjectInfo,
      pullPut: nativePersistentCase.pullRequests.putObject,
      pullDelete: nativePersistentCase.pullRequests.deleteObjects
    }
  ]);

  console.table([
    {
      mode: "typescript",
      pushPhases: formatPhaseTimings(typescriptCase.pushPhaseTimings),
      pushWarmPhases: formatPhaseTimings(typescriptCase.pushWarmPhaseTimings),
      pushBridge: formatBridgeTimings(typescriptCase.pushBridgeTimings),
      pushWarmBridge: formatBridgeTimings(typescriptCase.pushWarmBridgeTimings),
      pushWorker: formatWorkerTimings(typescriptCase.pushWorkerTimings),
      pushWarmWorker: formatWorkerTimings(typescriptCase.pushWarmWorkerTimings),
      pushWrapper: formatWrapperTimings(typescriptCase.pushWrapperTimings),
      pushWarmWrapper: formatWrapperTimings(typescriptCase.pushWarmWrapperTimings)
    },
    {
      mode: "typescript-primary",
      pushPhases: formatPhaseTimings(typescriptPrimaryCase.pushPhaseTimings),
      pushWarmPhases: formatPhaseTimings(typescriptPrimaryCase.pushWarmPhaseTimings),
      pushBridge: formatBridgeTimings(typescriptPrimaryCase.pushBridgeTimings),
      pushWarmBridge: formatBridgeTimings(typescriptPrimaryCase.pushWarmBridgeTimings),
      pushWorker: formatWorkerTimings(typescriptPrimaryCase.pushWorkerTimings),
      pushWarmWorker: formatWorkerTimings(typescriptPrimaryCase.pushWarmWorkerTimings),
      pushWrapper: formatWrapperTimings(typescriptPrimaryCase.pushWrapperTimings),
      pushWarmWrapper: formatWrapperTimings(typescriptPrimaryCase.pushWarmWrapperTimings)
    },
    {
      mode: "native-oneshot",
      pushPhases: formatPhaseTimings(nativeOneShotCase.pushPhaseTimings),
      pushWarmPhases: formatPhaseTimings(nativeOneShotCase.pushWarmPhaseTimings),
      pushBridge: formatBridgeTimings(nativeOneShotCase.pushBridgeTimings),
      pushWarmBridge: formatBridgeTimings(nativeOneShotCase.pushWarmBridgeTimings),
      pushWorker: formatWorkerTimings(nativeOneShotCase.pushWorkerTimings),
      pushWarmWorker: formatWorkerTimings(nativeOneShotCase.pushWarmWorkerTimings),
      pushWrapper: formatWrapperTimings(nativeOneShotCase.pushWrapperTimings),
      pushWarmWrapper: formatWrapperTimings(nativeOneShotCase.pushWarmWrapperTimings)
    },
    {
      mode: "native-persistent",
      pushPhases: formatPhaseTimings(nativePersistentCase.pushPhaseTimings),
      pushWarmPhases: formatPhaseTimings(nativePersistentCase.pushWarmPhaseTimings),
      pushBridge: formatBridgeTimings(nativePersistentCase.pushBridgeTimings),
      pushWarmBridge: formatBridgeTimings(nativePersistentCase.pushWarmBridgeTimings),
      pushWorker: formatWorkerTimings(nativePersistentCase.pushWorkerTimings),
      pushWarmWorker: formatWorkerTimings(nativePersistentCase.pushWarmWorkerTimings),
      pushWrapper: formatWrapperTimings(nativePersistentCase.pushWrapperTimings),
      pushWarmWrapper: formatWrapperTimings(nativePersistentCase.pushWarmWrapperTimings)
    }
  ]);

  console.log(
    `TypeScript primary delta vs ts: seed-plan ${Math.round(typescriptCase.seedPlanMs - typescriptPrimaryCase.seedPlanMs)}ms, push ${Math.round(
      typescriptCase.pushMs - typescriptPrimaryCase.pushMs
    )}ms, push-warm ${Math.round(typescriptCase.pushWarmMs - typescriptPrimaryCase.pushWarmMs)}ms, materialize ${Math.round(
      typescriptCase.materializeMs - typescriptPrimaryCase.materializeMs
    )}ms, pull ${Math.round(typescriptCase.pullMs - typescriptPrimaryCase.pullMs)}ms`
  );
  console.log(
    `Native oneshot delta vs ts: seed-plan ${Math.round(typescriptCase.seedPlanMs - nativeOneShotCase.seedPlanMs)}ms, push ${Math.round(
      typescriptCase.pushMs - nativeOneShotCase.pushMs
    )}ms, push-warm ${Math.round(typescriptCase.pushWarmMs - nativeOneShotCase.pushWarmMs)}ms, materialize ${Math.round(typescriptCase.materializeMs - nativeOneShotCase.materializeMs)}ms, pull ${Math.round(
      typescriptCase.pullMs - nativeOneShotCase.pullMs
    )}ms`
  );
  console.log(
    `Native persistent delta vs ts: seed-plan ${Math.round(typescriptCase.seedPlanMs - nativePersistentCase.seedPlanMs)}ms, push ${Math.round(
      typescriptCase.pushMs - nativePersistentCase.pushMs
    )}ms, push-warm ${Math.round(typescriptCase.pushWarmMs - nativePersistentCase.pushWarmMs)}ms, materialize ${Math.round(typescriptCase.materializeMs - nativePersistentCase.materializeMs)}ms, pull ${Math.round(
      typescriptCase.pullMs - nativePersistentCase.pullMs
    )}ms`
  );
  console.log(
    `Persistent gain vs oneshot: seed-plan ${Math.round(nativeOneShotCase.seedPlanMs - nativePersistentCase.seedPlanMs)}ms, push ${Math.round(
      nativeOneShotCase.pushMs - nativePersistentCase.pushMs
    )}ms, push-warm ${Math.round(nativeOneShotCase.pushWarmMs - nativePersistentCase.pushWarmMs)}ms, materialize ${Math.round(nativeOneShotCase.materializeMs - nativePersistentCase.materializeMs)}ms, pull ${Math.round(
      nativeOneShotCase.pullMs - nativePersistentCase.pullMs
    )}ms`
  );

  await shutdownNativeWorkspaceSyncWorkerPool();
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
