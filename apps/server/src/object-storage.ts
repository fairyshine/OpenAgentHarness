import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { ServerConfig } from "@oah/config";

export type ManagedPathKey = "workspace" | "blueprint" | "model" | "tool" | "skill";
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
  getObject(key: string): Promise<Buffer>;
  putObject(key: string, body: Buffer): Promise<void>;
  deleteObjects(keys: string[]): Promise<void>;
  bucket?: string | undefined;
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
  blueprint: "blueprint",
  model: "model",
  tool: "tool",
  skill: "skill"
};

const DEFAULT_MANAGED_PATHS = Object.keys(DEFAULT_KEY_PREFIXES) as ManagedPathKey[];

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

async function collectLocalDirectorySnapshot(rootDir: string, options?: DirectorySyncOptions): Promise<LocalDirectorySnapshot> {
  const files = new Map<string, { absolutePath: string; size: number; mtimeMs: number }>();
  const emptyDirectories = new Set<string>();
  const rootExists = await stat(rootDir).catch(() => null);

  if (!rootExists?.isDirectory()) {
    return { files, emptyDirectories };
  }

  const walk = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    let visibleChildren = 0;

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = normalizeRelativePath(path.relative(rootDir, absolutePath));
      if (shouldIgnoreRelativePath(relativePath)) {
        continue;
      }
      if (options?.excludeRelativePath?.(relativePath)) {
        continue;
      }

      visibleChildren += 1;
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }

      if (entry.isFile()) {
        const entryStat = await stat(absolutePath);
        files.set(relativePath, {
          absolutePath,
          size: entryStat.size,
          mtimeMs: entryStat.mtimeMs
        });
      }
    }

    const relativeDirectory = normalizeRelativePath(path.relative(rootDir, directory));
    if (visibleChildren === 0 && relativeDirectory) {
      emptyDirectories.add(relativeDirectory);
    }
  };

  await walk(rootDir);
  return { files, emptyDirectories };
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

export async function computeLocalDirectoryFingerprint(rootDir: string): Promise<string> {
  return createDirectoryFingerprint(await collectLocalDirectorySnapshot(rootDir));
}

async function removeDirectoryContents(rootDir: string, options?: DirectorySyncOptions): Promise<void> {
  const rootExists = await stat(rootDir).catch(() => null);
  if (!rootExists?.isDirectory()) {
    await mkdir(rootDir, { recursive: true });
    return;
  }

  const entries = await readdir(rootDir, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      if (options?.preserveTopLevelNames?.includes(entry.name)) {
        return;
      }
      await rm(path.join(rootDir, entry.name), { recursive: true, force: true });
    })
  );
}

function shouldExcludeWorkspaceMirrorRelativePath(relativePath: string): boolean {
  return relativePath === ".openharness" || relativePath.startsWith(".openharness/");
}

async function pruneEmptyDirectories(rootDir: string): Promise<void> {
  const rootExists = await stat(rootDir).catch(() => null);
  if (!rootExists?.isDirectory()) {
    return;
  }

  const walk = async (directory: string): Promise<boolean> => {
    const entries = await readdir(directory, { withFileTypes: true });
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

  async getObject(key: string): Promise<Buffer> {
    const response = await this.#client.send(
      new GetObjectCommand({
        Bucket: this.#bucket,
        Key: key
      })
    );
    return streamBodyToBuffer(response.Body);
  }

  async putObject(key: string, body: Buffer): Promise<void> {
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: body
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
  readonly #store: S3DirectoryStore;
  readonly #mappings: ManagedPathMapping[];
  readonly #pollIntervalMs: number;
  readonly #syncOnBoot: boolean;
  readonly #syncOnChange: boolean;
  readonly #fingerprints = new Map<ManagedPathKey, string>();
  readonly #logger: (message: string) => void;
  #pollTimer: NodeJS.Timeout | undefined;
  #syncInFlight: Promise<void> | undefined;

  constructor(config: ObjectStorageConfig, paths: ServerConfig["paths"], logger?: (message: string) => void) {
    this.#store = new S3DirectoryStore(config);
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

  async initialize(): Promise<void> {
    for (const mapping of this.#mappings) {
      await mkdir(mapping.localDir, { recursive: true });
    }

    if (this.#syncOnBoot) {
      for (const mapping of this.#mappings) {
        await this.#syncRemoteToLocal(mapping);
      }
    }

    for (const mapping of this.#mappings) {
      this.#fingerprints.set(mapping.key, await this.#captureFingerprint(mapping.localDir));
    }

    if (this.#syncOnChange) {
      this.#pollTimer = setInterval(() => {
        void this.syncChangedMappings();
      }, this.#pollIntervalMs);
      this.#pollTimer.unref();
    }
  }

  async close(): Promise<void> {
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = undefined;
    }

    await this.syncChangedMappings();
    await this.#store.close();
  }

  async syncChangedMappings(): Promise<void> {
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
  await removeDirectoryContents(localDir, options);
  await mkdir(localDir, { recursive: true });

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

    const targetPath = path.join(localDir, relativePath);
    if (entry.key.endsWith("/")) {
      await mkdir(targetPath, { recursive: true });
      continue;
    }

    await mkdir(path.dirname(targetPath), { recursive: true });
    const body = await store.getObject(entry.key);
    await writeFile(targetPath, body);
  }
}

export async function syncLocalDirectoryToRemote(
  store: DirectoryObjectStore,
  remotePrefix: string,
  localDir: string,
  logger?: (message: string) => void,
  label?: string,
  options?: DirectorySyncOptions
): Promise<void> {
  logger?.(`syncing local changes in ${localDir} back to object storage (${(label ?? remotePrefix) || "."})`);
  const [snapshot, remoteEntries] = await Promise.all([collectLocalDirectorySnapshot(localDir, options), store.listEntries(remotePrefix)]);

  const remoteByRelativePath = new Map<string, ObjectStorageEntry>();
  for (const entry of remoteEntries) {
    const relativePath = relativePathFromRemoteKey(remotePrefix, entry.key);
    if (relativePath === undefined || shouldIgnoreRelativePath(relativePath)) {
      continue;
    }
    remoteByRelativePath.set(relativePath || "/", entry);
  }

  const seenRemoteRelativePaths = new Set<string>();

  for (const [relativePath, file] of snapshot.files.entries()) {
    const remoteEntry = remoteByRelativePath.get(relativePath);
    seenRemoteRelativePaths.add(relativePath);
    if (
      remoteEntry &&
      !remoteEntry.key.endsWith("/") &&
      remoteEntry.size === file.size &&
      remoteEntry.lastModified &&
      remoteEntry.lastModified.getTime() >= Math.trunc(file.mtimeMs)
    ) {
      continue;
    }

    await store.putObject(buildRemoteKey(remotePrefix, relativePath), await readFile(file.absolutePath));
  }

  for (const relativePath of snapshot.emptyDirectories) {
    seenRemoteRelativePaths.add(relativePath);
    const remoteEntry = remoteByRelativePath.get(relativePath);
    if (remoteEntry?.key.endsWith("/")) {
      continue;
    }
    await store.putObject(`${buildRemoteKey(remotePrefix, relativePath)}/`, Buffer.alloc(0));
  }

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
}
