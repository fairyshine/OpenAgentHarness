import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import type { ServerConfig } from "@oah/config";
import {
  computeNativeDirectoryFingerprint,
  isNativeWorkspaceSyncEnabled,
  planNativeLocalToRemote,
  planNativeRemoteToLocal,
  scanNativeLocalTree
} from "@oah/native-bridge";

export type ManagedPathKey = "workspace" | "runtime" | "model" | "tool" | "skill";
type ObjectStorageConfig = NonNullable<ServerConfig["object_storage"]> & {
  managed_paths?: ManagedPathKey[] | undefined;
};

interface ObjectStorageEntry {
  key: string;
  size: number;
  lastModified?: Date | undefined;
}

export interface DirectoryObjectStore {
  listEntries(prefix: string): Promise<ObjectStorageEntry[]>;
  getObjectInfo?(
    key: string
  ): Promise<{ size?: number | undefined; lastModified?: Date | undefined; metadata?: Record<string, string> | undefined }>;
  getObject(key: string): Promise<{ body: Buffer; metadata?: Record<string, string> | undefined }>;
  putObject(key: string, body: Buffer, options?: { mtimeMs?: number | undefined }): Promise<void>;
  deleteObjects(keys: string[]): Promise<void>;
  bucket?: string | undefined;
}

export interface DirectorySyncResult {
  localFingerprint: string;
  uploadedFileCount: number;
  deletedRemoteCount: number;
  createdEmptyDirectoryCount: number;
}

interface LocalDirectorySnapshot {
  files: Map<string, { absolutePath: string; size: number; mtimeMs: number }>;
  emptyDirectories: Set<string>;
}

interface DirectorySyncOptions {
  excludeRelativePath?: ((relativePath: string) => boolean) | undefined;
  preserveTopLevelNames?: string[] | undefined;
}

interface ManagedPathMapping {
  key: ManagedPathKey;
  localDir: string;
  remotePrefix: string;
}

const DEFAULT_KEY_PREFIXES: Record<ManagedPathKey, string> = {
  workspace: "workspace",
  runtime: "runtime",
  model: "model",
  tool: "tool",
  skill: "skill"
};
const OBJECT_MTIME_METADATA_KEY = "oah-mtime-ms";
const DEFAULT_DIRECTORY_SYNC_CONCURRENCY = 8;

const DEFAULT_MANAGED_PATHS = Object.keys(DEFAULT_KEY_PREFIXES) as ManagedPathKey[];

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function normalizePrefix(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, "");
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll(path.sep, "/").replace(/^\/+|\/+$/g, "");
}

function buildRemoteKey(prefix: string, relativePath: string): string {
  const normalizedRelativePath = normalizeRelativePath(relativePath);
  return prefix.length === 0 ? normalizedRelativePath : `${prefix}/${normalizedRelativePath}`;
}

function relativePathFromRemoteKey(prefix: string, key: string): string | undefined {
  if (prefix.length === 0) {
    return normalizeRelativePath(key);
  }

  if (key === prefix) {
    return "";
  }

  if (!key.startsWith(`${prefix}/`)) {
    return undefined;
  }

  return normalizeRelativePath(key.slice(prefix.length + 1));
}

function shouldIgnoreRelativePath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) {
    return false;
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "__pycache__")) {
    return true;
  }

  const basename = segments.at(-1) ?? normalized;
  return (
    basename === ".DS_Store" ||
    basename.endsWith(".pyc") ||
    basename.endsWith(".db-shm") ||
    basename.endsWith(".db-wal")
  );
}

function parseObjectMtimeMs(metadata: Record<string, string> | undefined): number | undefined {
  const raw = metadata?.[OBJECT_MTIME_METADATA_KEY];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return undefined;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return Math.trunc(parsed);
}

function resolveDirectorySyncConcurrency(): number {
  const raw = process.env.OAH_OBJECT_STORAGE_SYNC_CONCURRENCY;
  if (!raw || raw.trim().length === 0) {
    return DEFAULT_DIRECTORY_SYNC_CONCURRENCY;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DIRECTORY_SYNC_CONCURRENCY;
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  const limit = Math.max(1, Math.min(items.length, concurrency));
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) {
          return;
        }

        await worker(items[index]!);
      }
    })
  );
}

function shouldPreserveTopLevelName(relativePath: string, options?: DirectorySyncOptions): boolean {
  if (!options?.preserveTopLevelNames || options.preserveTopLevelNames.length === 0) {
    return false;
  }

  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) {
    return false;
  }

  const topLevelName = normalized.split("/")[0];
  return topLevelName ? options.preserveTopLevelNames.includes(topLevelName) : false;
}

function addDirectoryWithParents(relativePath: string, directories: Set<string>): void {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) {
    return;
  }

  const segments = normalized.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    const candidate = segments.slice(0, index + 1).join("/");
    if (candidate) {
      directories.add(candidate);
    }
  }
}

async function collectLocalDirectorySnapshot(rootDir: string, options?: DirectorySyncOptions): Promise<LocalDirectorySnapshot> {
  const files = new Map<string, { absolutePath: string; size: number; mtimeMs: number }>();
  const emptyDirectories = new Set<string>();
  const rootExists = await stat(rootDir).catch((error) => {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  });

  if (!rootExists?.isDirectory()) {
    return { files, emptyDirectories };
  }

  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    });
    if (!entries) {
      return;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    let visibleChildren = 0;
    let suppressedChildren = false;

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = normalizeRelativePath(path.relative(rootDir, absolutePath));
      if (shouldIgnoreRelativePath(relativePath)) {
        suppressedChildren = true;
        continue;
      }
      if (options?.excludeRelativePath?.(relativePath)) {
        suppressedChildren = true;
        continue;
      }

      visibleChildren += 1;
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }

      if (entry.isFile()) {
        const entryStat = await stat(absolutePath).catch((error) => {
          if (isNotFoundError(error)) {
            return null;
          }
          throw error;
        });
        if (!entryStat?.isFile()) {
          continue;
        }

        files.set(relativePath, {
          absolutePath,
          size: entryStat.size,
          mtimeMs: entryStat.mtimeMs
        });
      }
    }

    const relativeDirectory = normalizeRelativePath(path.relative(rootDir, directory));
    if (visibleChildren === 0 && relativeDirectory && !suppressedChildren) {
      emptyDirectories.add(relativeDirectory);
    }
  };

  await walk(rootDir);
  return { files, emptyDirectories };
}

function createSnapshotFromNativeScan(input: Awaited<ReturnType<typeof scanNativeLocalTree>>): LocalDirectorySnapshot {
  return {
    files: new Map(
      input.files.map((file) => [
        file.relativePath,
        {
          absolutePath: file.absolutePath,
          size: file.size,
          mtimeMs: file.mtimeMs
        }
      ])
    ),
    emptyDirectories: new Set(input.emptyDirectories)
  };
}

function createDirectoryFingerprint(snapshot: LocalDirectorySnapshot): string {
  const hash = createHash("sha1");
  for (const [relativePath, file] of [...snapshot.files.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(`file:${relativePath}:${file.size}:${Math.trunc(file.mtimeMs)}\n`);
  }
  for (const relativePath of [...snapshot.emptyDirectories].sort((left, right) => left.localeCompare(right))) {
    hash.update(`dir:${relativePath}\n`);
  }
  return hash.digest("hex");
}

function resolveNativeFingerprintExcludes(options?: DirectorySyncOptions): string[] | undefined {
  const exclude = options?.excludeRelativePath;
  if (!exclude) {
    return [];
  }

  if (exclude === shouldExcludeWorkspaceMirrorRelativePath) {
    return [".openharness"];
  }

  if (exclude === shouldExcludeWorkspaceBackingStoreRelativePath) {
    return [".openharness/state", ".openharness/__materialized__"];
  }

  return undefined;
}

function buildNormalizedRemoteEntryMap(
  remotePrefix: string,
  remoteEntries: ObjectStorageEntry[],
  options?: DirectorySyncOptions
): Map<string, ObjectStorageEntry> {
  const remoteByRelativePath = new Map<string, ObjectStorageEntry>();
  for (const entry of remoteEntries) {
    const relativePath = relativePathFromRemoteKey(remotePrefix, entry.key);
    if (relativePath === undefined || shouldIgnoreRelativePath(relativePath)) {
      continue;
    }
    if (options?.excludeRelativePath?.(relativePath)) {
      continue;
    }
    remoteByRelativePath.set(relativePath || "/", entry);
  }

  return remoteByRelativePath;
}

export async function computeLocalDirectoryFingerprint(rootDir: string, options?: DirectorySyncOptions): Promise<string> {
  const nativeExcludes = resolveNativeFingerprintExcludes(options);
  if (isNativeWorkspaceSyncEnabled() && nativeExcludes !== undefined) {
    try {
      const result = await computeNativeDirectoryFingerprint({
        rootDir,
        ...(nativeExcludes.length > 0 ? { excludeRelativePaths: nativeExcludes } : {})
      });
      return result.fingerprint;
    } catch (error) {
      console.warn(
        `[oah-native] Falling back to TypeScript directory fingerprint for ${rootDir}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return createDirectoryFingerprint(await collectLocalDirectorySnapshot(rootDir, options));
}

async function collectNativeSnapshotIfAvailable(
  rootDir: string,
  options?: DirectorySyncOptions
): Promise<{ snapshot: LocalDirectorySnapshot; fingerprint: string } | undefined> {
  const nativeExcludes = resolveNativeFingerprintExcludes(options);
  if (!isNativeWorkspaceSyncEnabled() || nativeExcludes === undefined) {
    return undefined;
  }

  try {
    const result = await scanNativeLocalTree({
      rootDir,
      ...(nativeExcludes.length > 0 ? { excludeRelativePaths: nativeExcludes } : {})
    });
    return {
      snapshot: createSnapshotFromNativeScan(result),
      fingerprint: result.fingerprint
    };
  } catch (error) {
    console.warn(
      `[oah-native] Falling back to TypeScript local snapshot for ${rootDir}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return undefined;
  }
}

async function collectNativeLocalToRemotePlanIfAvailable(
  localDir: string,
  remotePrefix: string,
  remoteEntries: ObjectStorageEntry[],
  options?: DirectorySyncOptions
): Promise<Awaited<ReturnType<typeof planNativeLocalToRemote>> | undefined> {
  const nativeExcludes = resolveNativeFingerprintExcludes(options);
  if (!isNativeWorkspaceSyncEnabled() || nativeExcludes === undefined) {
    return undefined;
  }

  try {
    return await planNativeLocalToRemote({
      rootDir: localDir,
      ...(nativeExcludes.length > 0 ? { excludeRelativePaths: nativeExcludes } : {}),
      remoteEntries: remoteEntries
        .map((entry) => {
          const relativePath = relativePathFromRemoteKey(remotePrefix, entry.key);
          if (relativePath === undefined || shouldIgnoreRelativePath(relativePath)) {
            return undefined;
          }
          if (options?.excludeRelativePath?.(relativePath)) {
            return undefined;
          }
          return {
            relativePath: relativePath || "/",
            key: entry.key,
            size: entry.size,
            ...(entry.lastModified ? { lastModifiedMs: entry.lastModified.getTime() } : {}),
            isDirectory: entry.key.endsWith("/")
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    });
  } catch (error) {
    console.warn(
      `[oah-native] Falling back to TypeScript local->remote planning for ${localDir}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return undefined;
  }
}

async function collectNativeRemoteToLocalPlanIfAvailable(
  localDir: string,
  remotePrefix: string,
  remoteEntries: ObjectStorageEntry[],
  options?: DirectorySyncOptions
): Promise<Awaited<ReturnType<typeof planNativeRemoteToLocal>> | undefined> {
  const nativeExcludes = resolveNativeFingerprintExcludes(options);
  if (!isNativeWorkspaceSyncEnabled() || nativeExcludes === undefined) {
    return undefined;
  }

  try {
    return await planNativeRemoteToLocal({
      rootDir: localDir,
      ...(nativeExcludes.length > 0 ? { excludeRelativePaths: nativeExcludes } : {}),
      remoteEntries: remoteEntries
        .map((entry) => {
          const relativePath = relativePathFromRemoteKey(remotePrefix, entry.key);
          if (relativePath === undefined || shouldIgnoreRelativePath(relativePath)) {
            return undefined;
          }
          if (options?.excludeRelativePath?.(relativePath)) {
            return undefined;
          }
          return {
            relativePath: relativePath || "/",
            key: entry.key,
            size: entry.size,
            ...(entry.lastModified ? { lastModifiedMs: entry.lastModified.getTime() } : {}),
            isDirectory: entry.key.endsWith("/")
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    });
  } catch (error) {
    console.warn(
      `[oah-native] Falling back to TypeScript remote->local planning for ${localDir}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return undefined;
  }
}

async function removeUnexpectedLocalEntries(
  rootDir: string,
  remoteFiles: Set<string>,
  remoteDirectories: Set<string>,
  options?: DirectorySyncOptions
): Promise<void> {
  const rootExists = await stat(rootDir).catch((error) => {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  });
  if (!rootExists?.isDirectory()) {
    await mkdir(rootDir, { recursive: true });
    return;
  }

  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    });
    if (!entries) {
      return;
    }

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = normalizeRelativePath(path.relative(rootDir, absolutePath));

      if (options?.excludeRelativePath?.(relativePath)) {
        continue;
      }

      if (shouldIgnoreRelativePath(relativePath)) {
        await rm(absolutePath, { recursive: true, force: true });
        continue;
      }

      if (entry.isDirectory()) {
        await walk(absolutePath);
        if (shouldPreserveTopLevelName(relativePath, options) || remoteDirectories.has(relativePath)) {
          continue;
        }

        const remainingEntries = await readdir(absolutePath).catch((error) => {
          if (isNotFoundError(error)) {
            return null;
          }
          throw error;
        });
        if (remainingEntries && remainingEntries.length === 0) {
          await rm(absolutePath, { recursive: true, force: true });
        }
        continue;
      }

      if (!remoteFiles.has(relativePath)) {
        await rm(absolutePath, { recursive: true, force: true });
      }
    }
  };

  await walk(rootDir);
}

async function statIfExists(targetPath: string) {
  return stat(targetPath).catch((error) => {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  });
}

function resolveTargetMtimeMs(input: {
  metadata?: Record<string, string> | undefined;
  lastModified?: Date | undefined;
}): number | undefined {
  return parseObjectMtimeMs(input.metadata) ?? (input.lastModified ? Math.trunc(input.lastModified.getTime()) : undefined);
}

function shouldExcludeWorkspaceMirrorRelativePath(relativePath: string): boolean {
  return relativePath === ".openharness" || relativePath.startsWith(".openharness/");
}

export function shouldExcludeWorkspaceBackingStoreRelativePath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  return (
    normalized === ".openharness/state" ||
    normalized.startsWith(".openharness/state/") ||
    normalized === ".openharness/__materialized__" ||
    normalized.startsWith(".openharness/__materialized__/")
  );
}

async function pruneEmptyDirectories(rootDir: string): Promise<void> {
  const rootExists = await stat(rootDir).catch((error) => {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  });
  if (!rootExists?.isDirectory()) {
    return;
  }

  const walk = async (directory: string): Promise<boolean> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    });
    if (!entries) {
      return false;
    }

    let hasChildren = false;
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const keep = await walk(absolutePath);
        if (!keep) {
          await rm(absolutePath, { recursive: true, force: true });
          continue;
        }
      }

      hasChildren = true;
    }

    return hasChildren;
  };

  await walk(rootDir);
}

async function streamBodyToBuffer(body: unknown): Promise<Buffer> {
  if (!body) {
    return Buffer.alloc(0);
  }

  if (typeof body === "string") {
    return Buffer.from(body);
  }

  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }

  if (typeof body === "object" && body !== null && "transformToByteArray" in body) {
    const bytes = await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
    return Buffer.from(bytes);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array | Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

class S3DirectoryStore implements DirectoryObjectStore {
  readonly #bucket: string;
  readonly #client: S3Client;

  constructor(config: ObjectStorageConfig) {
    this.#bucket = config.bucket;
    this.#client = new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      ...(config.force_path_style !== undefined ? { forcePathStyle: config.force_path_style } : {}),
      ...(config.access_key || config.secret_key || config.session_token
        ? {
            credentials: {
              accessKeyId: config.access_key ?? "",
              secretAccessKey: config.secret_key ?? "",
              ...(config.session_token ? { sessionToken: config.session_token } : {})
            }
          }
        : {})
    });
  }

  get bucket(): string {
    return this.#bucket;
  }

  async listEntries(prefix: string): Promise<ObjectStorageEntry[]> {
    const entries: ObjectStorageEntry[] = [];
    let continuationToken: string | undefined;

    do {
      const response = await this.#client.send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          ...(prefix ? { Prefix: `${prefix}/` } : {}),
          ...(continuationToken ? { ContinuationToken: continuationToken } : {})
        })
      );

      for (const item of response.Contents ?? []) {
        if (!item.Key) {
          continue;
        }

        entries.push({
          key: item.Key,
          size: item.Size ?? 0,
          ...(item.LastModified ? { lastModified: item.LastModified } : {})
        });
      }

      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);

    return entries.sort((left, right) => left.key.localeCompare(right.key));
  }

  async getObject(key: string): Promise<{ body: Buffer; metadata?: Record<string, string> | undefined }> {
    const response = await this.#client.send(
      new GetObjectCommand({
        Bucket: this.#bucket,
        Key: key
      })
    );
    return {
      body: await streamBodyToBuffer(response.Body),
      metadata: response.Metadata
    };
  }

  async getObjectInfo(
    key: string
  ): Promise<{ size?: number | undefined; lastModified?: Date | undefined; metadata?: Record<string, string> | undefined }> {
    const response = await this.#client.send(
      new HeadObjectCommand({
        Bucket: this.#bucket,
        Key: key
      })
    );

    return {
      ...(typeof response.ContentLength === "number" ? { size: response.ContentLength } : {}),
      ...(response.LastModified ? { lastModified: response.LastModified } : {}),
      ...(response.Metadata ? { metadata: response.Metadata } : {})
    };
  }

  async putObject(key: string, body: Buffer, options?: { mtimeMs?: number | undefined }): Promise<void> {
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: body,
        ...(typeof options?.mtimeMs === "number" && Number.isFinite(options.mtimeMs) && options.mtimeMs > 0
          ? {
              Metadata: {
                [OBJECT_MTIME_METADATA_KEY]: String(Math.trunc(options.mtimeMs))
              }
            }
          : {})
      })
    );
  }

  async deleteObjects(keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }

    for (let index = 0; index < keys.length; index += 1000) {
      const chunk = keys.slice(index, index + 1000);
      await this.#client.send(
        new DeleteObjectsCommand({
          Bucket: this.#bucket,
          Delete: {
            Objects: chunk.map((key) => ({ Key: key })),
            Quiet: true
          }
        })
      );
    }
  }

  async close(): Promise<void> {
    this.#client.destroy();
  }
}

export function createDirectoryObjectStore(config: ObjectStorageConfig): DirectoryObjectStore {
  return new S3DirectoryStore(config);
}

export class ObjectStorageMirrorController {
  readonly #store: DirectoryObjectStore & { close(): Promise<void> };
  readonly #mappings: ManagedPathMapping[];
  readonly #pollIntervalMs: number;
  readonly #syncOnBoot: boolean;
  readonly #syncOnChange: boolean;
  readonly #fingerprints = new Map<ManagedPathKey, string>();
  readonly #logger: (message: string) => void;
  #pollTimer: NodeJS.Timeout | undefined;
  #syncInFlight: Promise<void> | undefined;
  #localPreparationPromise: Promise<void> | undefined;
  #initializationPromise: Promise<void> | undefined;
  #backgroundInitializationObserved = false;
  #initializationError: unknown;

  constructor(
    config: ObjectStorageConfig,
    paths: ServerConfig["paths"],
    logger?: (message: string) => void,
    options?: {
      store?: (DirectoryObjectStore & { close(): Promise<void> }) | undefined;
    }
  ) {
    this.#store = options?.store ?? new S3DirectoryStore(config);
    this.#pollIntervalMs = config.poll_interval_ms ?? 5000;
    this.#syncOnBoot = config.sync_on_boot ?? true;
    this.#syncOnChange = config.sync_on_change ?? true;
    this.#logger = logger ?? (() => undefined);

    const configuredPrefixes = config.key_prefixes ?? {};
    const managedPaths: ManagedPathKey[] = config.managed_paths ?? DEFAULT_MANAGED_PATHS;
    this.#mappings = managedPaths.map((key: ManagedPathKey) => ({
      key,
      localDir: paths[`${key}_dir` as keyof ServerConfig["paths"]] as string,
      remotePrefix: normalizePrefix(configuredPrefixes[key] ?? DEFAULT_KEY_PREFIXES[key])
    }));
  }

  get enabled(): boolean {
    return this.#mappings.length > 0;
  }

  managedWorkspaceExternalRef(rootPath: string, kind: "project", paths: Pick<ServerConfig["paths"], "workspace_dir">): string | undefined {
    const mapping = this.#mappings.find((candidate) => candidate.key === "workspace");
    if (!mapping) {
      return undefined;
    }

    const baseDir = paths.workspace_dir;
    const relative = path.relative(baseDir, rootPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return undefined;
    }

    const normalizedRelative = normalizeRelativePath(relative);
    const key = buildRemoteKey(mapping.remotePrefix, normalizedRelative);
    return `s3://${this.#store.bucket}/${key}`;
  }

  async initialize(options?: { awaitInitialSync?: boolean | undefined }): Promise<void> {
    const awaitInitialSync = options?.awaitInitialSync ?? true;
    const localPreparation = this.#ensureLocalPreparation();
    const initialization = this.#ensureInitialization();

    if (awaitInitialSync) {
      await initialization;
      return;
    }

    if (!this.#backgroundInitializationObserved) {
      this.#backgroundInitializationObserved = true;
      void initialization.catch((error) => {
        this.#logger(
          `background mirror initialization failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    }

    await localPreparation;
  }

  async close(): Promise<void> {
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = undefined;
    }

    await this.#initializationPromise?.catch(() => undefined);
    if (this.#initializationError === undefined) {
      await this.syncChangedMappings();
    }
    await this.#store.close();
  }

  async syncChangedMappings(): Promise<void> {
    await this.#initializationPromise;

    if (this.#syncInFlight) {
      return this.#syncInFlight;
    }

    this.#syncInFlight = (async () => {
      try {
        for (const mapping of this.#mappings) {
          const nextFingerprint = await this.#captureFingerprint(mapping.localDir);
          const previousFingerprint = this.#fingerprints.get(mapping.key);
          if (previousFingerprint === nextFingerprint) {
            continue;
          }

          await this.#syncLocalToRemote(mapping);
          this.#fingerprints.set(mapping.key, await this.#captureFingerprint(mapping.localDir));
        }
      } finally {
        this.#syncInFlight = undefined;
      }
    })();

    return this.#syncInFlight;
  }

  async #captureFingerprint(directory: string): Promise<string> {
    const mapping = this.#mappings.find((candidate) => candidate.localDir === directory);
    return createDirectoryFingerprint(
      await collectLocalDirectorySnapshot(directory, mapping?.key === "workspace"
        ? {
            excludeRelativePath: shouldExcludeWorkspaceMirrorRelativePath
          }
        : undefined)
    );
  }

  async #syncRemoteToLocal(mapping: ManagedPathMapping): Promise<void> {
    await syncRemotePrefixToLocal(
      this.#store,
      mapping.remotePrefix,
      mapping.localDir,
      this.#logger,
      mapping.key,
      mapping.key === "workspace"
        ? {
            excludeRelativePath: shouldExcludeWorkspaceMirrorRelativePath,
            preserveTopLevelNames: [".openharness"]
          }
        : undefined
    );
  }

  async #syncLocalToRemote(mapping: ManagedPathMapping): Promise<void> {
    await syncLocalDirectoryToRemote(
      this.#store,
      mapping.remotePrefix,
      mapping.localDir,
      this.#logger,
      mapping.key,
      mapping.key === "workspace"
        ? {
            excludeRelativePath: shouldExcludeWorkspaceMirrorRelativePath
          }
        : undefined
    );
  }

  #ensureLocalPreparation(): Promise<void> {
    if (!this.#localPreparationPromise) {
      this.#localPreparationPromise = (async () => {
        for (const mapping of this.#mappings) {
          await mkdir(mapping.localDir, { recursive: true });
        }
      })();
    }

    return this.#localPreparationPromise;
  }

  #ensureInitialization(): Promise<void> {
    if (!this.#initializationPromise) {
      this.#initializationPromise = (async () => {
        await this.#ensureLocalPreparation();

        if (this.#syncOnBoot) {
          for (const mapping of this.#mappings) {
            await this.#syncRemoteToLocal(mapping);
          }
        }

        for (const mapping of this.#mappings) {
          this.#fingerprints.set(mapping.key, await this.#captureFingerprint(mapping.localDir));
        }

        if (this.#syncOnChange && !this.#pollTimer) {
          this.#pollTimer = setInterval(() => {
            void this.syncChangedMappings();
          }, this.#pollIntervalMs);
          this.#pollTimer.unref();
        }
      })().catch((error) => {
        this.#initializationError = error;
        throw error;
      });
    }

    return this.#initializationPromise;
  }
}

export async function syncWorkspaceRootToObjectStore(
  store: DirectoryObjectStore,
  remotePrefix: string,
  localDir: string,
  logger?: (message: string) => void,
  label?: string
): Promise<void> {
  await syncLocalDirectoryToRemote(store, remotePrefix, localDir, logger, label, {
    excludeRelativePath: shouldExcludeWorkspaceBackingStoreRelativePath
  });
}

export async function deleteRemotePrefixFromObjectStore(
  store: DirectoryObjectStore,
  remotePrefix: string,
  logger?: (message: string) => void,
  label?: string
): Promise<void> {
  const normalizedPrefix = normalizePrefix(remotePrefix);
  if (!normalizedPrefix) {
    throw new Error("Refusing to delete an empty object storage prefix.");
  }

  logger?.(`scanning object storage prefix ${(label ?? normalizedPrefix) || "."} for deletion`);
  const entries = await store.listEntries(normalizedPrefix);
  const keys = [...new Set([normalizedPrefix, `${normalizedPrefix}/`, ...entries.map((entry) => entry.key)])];
  logger?.(
    `deleting ${keys.length} object storage entr${keys.length === 1 ? "y" : "ies"} from ${(label ?? normalizedPrefix) || "."}`
  );
  if (keys.length > 0) {
    await store.deleteObjects(keys);
  }
  logger?.(`deleted object storage prefix ${(label ?? normalizedPrefix) || "."}`);
}

export async function deleteWorkspaceExternalRefFromObjectStore(
  config: ObjectStorageConfig,
  externalRef: string,
  logger?: (message: string) => void
): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(externalRef);
  } catch {
    return false;
  }

  if (parsed.protocol !== "s3:") {
    return false;
  }

  if (parsed.hostname && parsed.hostname !== config.bucket) {
    throw new Error(
      `Workspace externalRef bucket ${parsed.hostname} does not match configured object storage bucket ${config.bucket}.`
    );
  }

  const remotePrefix = normalizePrefix(parsed.pathname);
  if (!remotePrefix) {
    throw new Error(`Workspace externalRef ${externalRef} does not resolve to a deletable object storage prefix.`);
  }

  const store = new S3DirectoryStore(config);
  try {
    await deleteRemotePrefixFromObjectStore(store, remotePrefix, logger, path.basename(remotePrefix) || remotePrefix);
    return true;
  } finally {
    await store.close();
  }
}

export async function seedWorkspaceRootToExternalRef(
  config: ObjectStorageConfig,
  externalRef: string,
  localDir: string,
  logger?: (message: string) => void
): Promise<void> {
  const parsed = new URL(externalRef);
  if (parsed.protocol !== "s3:") {
    return;
  }

  if (parsed.hostname && parsed.hostname !== config.bucket) {
    throw new Error(
      `Workspace externalRef bucket ${parsed.hostname} does not match configured object storage bucket ${config.bucket}.`
    );
  }

  const remotePrefix = normalizePrefix(parsed.pathname);
  const store = new S3DirectoryStore(config);
  try {
    await syncWorkspaceRootToObjectStore(store, remotePrefix, localDir, logger, path.basename(localDir) || remotePrefix);
  } finally {
    await store.close();
  }
}

export async function syncRemotePrefixToLocal(
  store: DirectoryObjectStore,
  remotePrefix: string,
  localDir: string,
  logger?: (message: string) => void,
  label?: string,
  options?: DirectorySyncOptions
): Promise<void> {
  logger?.(`syncing ${(label ?? remotePrefix) || "."} from object storage into ${localDir}`);
  const entries = await store.listEntries(remotePrefix);
  await mkdir(localDir, { recursive: true });

  const remoteDirectories = new Set<string>();
  const remoteFiles = new Map<string, ObjectStorageEntry>();

  for (const entry of entries) {
    const relativePath = relativePathFromRemoteKey(remotePrefix, entry.key);
    if (relativePath === undefined || shouldIgnoreRelativePath(relativePath)) {
      continue;
    }
    if (options?.excludeRelativePath?.(relativePath)) {
      continue;
    }

    if (!relativePath) {
      continue;
    }

    if (entry.key.endsWith("/")) {
      addDirectoryWithParents(relativePath, remoteDirectories);
      continue;
    }

    remoteFiles.set(relativePath, entry);
    const parentDirectory = normalizeRelativePath(path.posix.dirname(relativePath));
    if (parentDirectory && parentDirectory !== ".") {
      addDirectoryWithParents(parentDirectory, remoteDirectories);
    }
  }

  await removeUnexpectedLocalEntries(localDir, new Set(remoteFiles.keys()), remoteDirectories, options);

  const concurrency = resolveDirectorySyncConcurrency();
  const nativePlan = await collectNativeRemoteToLocalPlanIfAvailable(localDir, remotePrefix, entries, options);
  const orderedDirectories = nativePlan?.directoriesToCreate ?? [...remoteDirectories].sort((left, right) => {
    const depthDifference = left.split("/").length - right.split("/").length;
    return depthDifference !== 0 ? depthDifference : left.localeCompare(right);
  });
  await runWithConcurrency(orderedDirectories, concurrency, async (relativePath) => {
    const targetPath = path.join(localDir, relativePath);
    const existing = await statIfExists(targetPath);
    if (existing && !existing.isDirectory()) {
      await rm(targetPath, { recursive: true, force: true });
    }
    await mkdir(targetPath, { recursive: true });
  });

  const nativeDownloadCandidates =
    nativePlan?.downloadCandidates.map((candidate) => ({
      relativePath: candidate.relativePath,
      targetPath: candidate.targetPath,
      entry: remoteFiles.get(candidate.relativePath)
    })) ??
    [...remoteFiles.entries()].map(([relativePath, entry]) => ({
      relativePath,
      targetPath: path.join(localDir, relativePath),
      entry
    }));

  await runWithConcurrency(nativeDownloadCandidates, concurrency, async ({ targetPath, entry }) => {
    if (!entry) {
      return;
    }
    const existing = await statIfExists(targetPath);
    if (existing && !existing.isFile()) {
      await rm(targetPath, { recursive: true, force: true });
    }

    await mkdir(path.dirname(targetPath), { recursive: true });

    const currentFile = existing?.isFile() ? existing : null;
    if (currentFile && currentFile.size === entry.size) {
      const objectInfo = await store.getObjectInfo?.(entry.key);
      const targetMtimeMs = resolveTargetMtimeMs({
        metadata: objectInfo?.metadata,
        lastModified: objectInfo?.lastModified ?? entry.lastModified
      });
      if (typeof targetMtimeMs === "number" && Math.trunc(currentFile.mtimeMs) === targetMtimeMs) {
        return;
      }
    }

    const object = await store.getObject(entry.key);
    await writeFile(targetPath, object.body);
    const targetMtimeMs = resolveTargetMtimeMs({
      metadata: object.metadata,
      lastModified: entry.lastModified
    });
    if (typeof targetMtimeMs === "number") {
      const preservedDate = new Date(targetMtimeMs);
      await utimes(targetPath, preservedDate, preservedDate);
    }
  });

  if (nativePlan) {
    await runWithConcurrency(nativePlan.infoCheckCandidates, concurrency, async (candidate) => {
      const entry = remoteFiles.get(candidate.relativePath);
      if (!entry) {
        return;
      }

      const targetPath = candidate.targetPath;
      const existing = await statIfExists(targetPath);
      if (existing && !existing.isFile()) {
        await rm(targetPath, { recursive: true, force: true });
      }

      await mkdir(path.dirname(targetPath), { recursive: true });

      const currentFile = existing?.isFile() ? existing : null;
      if (currentFile && currentFile.size === entry.size) {
        const objectInfo = await store.getObjectInfo?.(entry.key);
        const targetMtimeMs = resolveTargetMtimeMs({
          metadata: objectInfo?.metadata,
          lastModified: objectInfo?.lastModified ?? entry.lastModified
        });
        if (typeof targetMtimeMs === "number" && Math.trunc(currentFile.mtimeMs) === targetMtimeMs) {
          return;
        }
      }

      const object = await store.getObject(entry.key);
      await writeFile(targetPath, object.body);
      const targetMtimeMs = resolveTargetMtimeMs({
        metadata: object.metadata,
        lastModified: entry.lastModified
      });
      if (typeof targetMtimeMs === "number") {
        const preservedDate = new Date(targetMtimeMs);
        await utimes(targetPath, preservedDate, preservedDate);
      }
    });
  }
}

export async function syncLocalDirectoryToRemote(
  store: DirectoryObjectStore,
  remotePrefix: string,
  localDir: string,
  logger?: (message: string) => void,
  label?: string,
  options?: DirectorySyncOptions
): Promise<DirectorySyncResult> {
  logger?.(`syncing local changes in ${localDir} back to object storage (${(label ?? remotePrefix) || "."})`);
  const remoteEntries = await store.listEntries(remotePrefix);
  const remoteByRelativePath = buildNormalizedRemoteEntryMap(remotePrefix, remoteEntries, options);
  let uploadedFileCount = 0;
  let createdEmptyDirectoryCount = 0;
  const concurrency = resolveDirectorySyncConcurrency();
  const nativePlan = await collectNativeLocalToRemotePlanIfAvailable(localDir, remotePrefix, remoteEntries, options);

  if (nativePlan) {
    await runWithConcurrency(nativePlan.uploadCandidates, concurrency, async (candidate) => {
      const body = await readFile(candidate.absolutePath).catch((error) => {
        if (isNotFoundError(error)) {
          return null;
        }
        throw error;
      });
      if (!body) {
        return;
      }

      await store.putObject(buildRemoteKey(remotePrefix, candidate.relativePath), body, { mtimeMs: candidate.mtimeMs });
      uploadedFileCount += 1;
    });

    await runWithConcurrency(nativePlan.infoCheckCandidates, concurrency, async (candidate) => {
      const remoteEntry = remoteByRelativePath.get(candidate.relativePath);
      if (!remoteEntry || remoteEntry.key.endsWith("/")) {
        const body = await readFile(candidate.absolutePath).catch((error) => {
          if (isNotFoundError(error)) {
            return null;
          }
          throw error;
        });
        if (!body) {
          return;
        }

        await store.putObject(buildRemoteKey(remotePrefix, candidate.relativePath), body, { mtimeMs: candidate.mtimeMs });
        uploadedFileCount += 1;
        return;
      }

      const remoteInfo = await store.getObjectInfo?.(remoteEntry.key);
      const remoteMtimeMs = resolveTargetMtimeMs({
        metadata: remoteInfo?.metadata,
        lastModified: remoteInfo?.lastModified ?? remoteEntry.lastModified
      });
      if (typeof remoteMtimeMs === "number" && remoteMtimeMs === Math.trunc(candidate.mtimeMs)) {
        return;
      }
      if (!remoteInfo && remoteEntry.lastModified && remoteEntry.lastModified.getTime() >= Math.trunc(candidate.mtimeMs)) {
        return;
      }

      const body = await readFile(candidate.absolutePath).catch((error) => {
        if (isNotFoundError(error)) {
          return null;
        }
        throw error;
      });
      if (!body) {
        return;
      }

      await store.putObject(buildRemoteKey(remotePrefix, candidate.relativePath), body, { mtimeMs: candidate.mtimeMs });
      uploadedFileCount += 1;
    });

    await runWithConcurrency(nativePlan.emptyDirectoriesToCreate, concurrency, async (relativePath) => {
      await store.putObject(`${buildRemoteKey(remotePrefix, relativePath)}/`, Buffer.alloc(0));
      createdEmptyDirectoryCount += 1;
    });

    if (nativePlan.keysToDelete.length > 0) {
      await store.deleteObjects(nativePlan.keysToDelete);
    }

    await pruneEmptyDirectories(localDir);
    return {
      localFingerprint: nativePlan.fingerprint,
      uploadedFileCount,
      deletedRemoteCount: nativePlan.keysToDelete.length,
      createdEmptyDirectoryCount
    };
  }

  const nativeSnapshot = await collectNativeSnapshotIfAvailable(localDir, options);
  const snapshot = nativeSnapshot?.snapshot ?? (await collectLocalDirectorySnapshot(localDir, options));
  const localFingerprint = nativeSnapshot?.fingerprint ?? createDirectoryFingerprint(snapshot);

  const seenRemoteRelativePaths = new Set<string>();

  await runWithConcurrency([...snapshot.files.entries()], concurrency, async ([relativePath, file]) => {
    const remoteEntry = remoteByRelativePath.get(relativePath);
    seenRemoteRelativePaths.add(relativePath);
    if (remoteEntry && !remoteEntry.key.endsWith("/") && remoteEntry.size === file.size) {
      const remoteInfo = await store.getObjectInfo?.(remoteEntry.key);
      const remoteMtimeMs = resolveTargetMtimeMs({
        metadata: remoteInfo?.metadata,
        lastModified: remoteInfo?.lastModified ?? remoteEntry.lastModified
      });
      if (typeof remoteMtimeMs === "number" && remoteMtimeMs === Math.trunc(file.mtimeMs)) {
        return;
      }
      if (!remoteInfo && remoteEntry.lastModified && remoteEntry.lastModified.getTime() >= Math.trunc(file.mtimeMs)) {
        return;
      }
    }

    const body = await readFile(file.absolutePath).catch((error) => {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    });
    if (!body) {
      return;
    }

    await store.putObject(buildRemoteKey(remotePrefix, relativePath), body, { mtimeMs: file.mtimeMs });
    uploadedFileCount += 1;
  });

  await runWithConcurrency([...snapshot.emptyDirectories], concurrency, async (relativePath) => {
    seenRemoteRelativePaths.add(relativePath);
    const remoteEntry = remoteByRelativePath.get(relativePath);
    if (remoteEntry?.key.endsWith("/")) {
      return;
    }
    await store.putObject(`${buildRemoteKey(remotePrefix, relativePath)}/`, Buffer.alloc(0));
    createdEmptyDirectoryCount += 1;
  });

  const keysToDelete: string[] = [];
  for (const [relativePath, remoteEntry] of remoteByRelativePath.entries()) {
    if (relativePath === "/") {
      continue;
    }
    if (!seenRemoteRelativePaths.has(relativePath)) {
      keysToDelete.push(remoteEntry.key);
    }
  }

  if (keysToDelete.length > 0) {
    await store.deleteObjects(keysToDelete);
  }

  await pruneEmptyDirectories(localDir);
  return {
    localFingerprint,
    uploadedFileCount,
    deletedRemoteCount: keysToDelete.length,
    createdEmptyDirectoryCount
  };
}
