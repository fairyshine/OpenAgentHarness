import path from "node:path";
import type { Readable } from "node:stream";

import { AppError } from "../errors.js";
import { createLocalWorkspaceFileSystem } from "./workspace-file-system.js";
import type { WorkspaceFileStat, WorkspaceFileSystem, WorkspaceFileSystemEntry, WorkspaceRecord } from "../types.js";
import { parseCursor } from "../utils.js";

export type WorkspaceEntrySortBy = "name" | "updatedAt" | "sizeBytes" | "type";
export type SortOrder = "asc" | "desc";

export interface WorkspaceEntry {
  path: string;
  name: string;
  type: "file" | "directory";
  sizeBytes?: number | undefined;
  mimeType?: string | undefined;
  etag?: string | undefined;
  updatedAt?: string | undefined;
  createdAt?: string | undefined;
  readOnly: boolean;
}

export interface WorkspaceEntryPage {
  workspaceId: string;
  path: string;
  items: WorkspaceEntry[];
  nextCursor?: string | undefined;
}

export interface WorkspaceDeleteResult {
  workspaceId: string;
  path: string;
  type: "file" | "directory";
  deleted: boolean;
}

export interface WorkspaceFileContentResult {
  workspaceId: string;
  path: string;
  encoding: "utf8" | "base64";
  content: string;
  truncated: boolean;
  sizeBytes?: number | undefined;
  mimeType?: string | undefined;
  etag?: string | undefined;
  updatedAt?: string | undefined;
  readOnly: boolean;
}

export interface WorkspaceFileDownloadResult {
  workspaceId: string;
  path: string;
  name: string;
  sizeBytes: number;
  mimeType?: string | undefined;
  etag: string;
  updatedAt?: string | undefined;
  readOnly: boolean;
  openReadStream(): Readable;
}

interface ResolvedWorkspacePath {
  absolutePath: string;
  relativePath: string;
}

interface DescendantMtimeScanContext {
  fileStatLimiter: AsyncLimiter;
  directoryReadLimiter: AsyncLimiter;
}

type AsyncLimiter = <T>(task: () => Promise<T>) => Promise<T>;

const DESCENDANT_MTIME_CACHE_TTL_MS = 15_000;
const DESCENDANT_MTIME_FILE_STAT_CONCURRENCY = 32;
const DESCENDANT_MTIME_DIRECTORY_READ_CONCURRENCY = 8;
const SLOW_WORKSPACE_LIST_LOG_THRESHOLD_MS = 250;

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

function createAsyncLimiter(maxConcurrency: number): AsyncLimiter {
  let activeCount = 0;
  const queue: Array<() => void> = [];

  function runNext(): void {
    const next = queue.shift();
    if (!next || activeCount >= maxConcurrency) {
      return;
    }

    activeCount += 1;
    next();
  }

  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      queue.push(resolve);
      runNext();
    });

    try {
      return await task();
    } finally {
      activeCount -= 1;
      runNext();
    }
  };
}

function createDescendantMtimeScanContext(): DescendantMtimeScanContext {
  return {
    fileStatLimiter: createAsyncLimiter(DESCENDANT_MTIME_FILE_STAT_CONCURRENCY),
    directoryReadLimiter: createAsyncLimiter(DESCENDANT_MTIME_DIRECTORY_READ_CONCURRENCY)
  };
}

function isSamePathOrAncestor(ancestorPath: string, targetPath: string): boolean {
  const relativePath = path.relative(ancestorPath, targetPath);
  return relativePath.length === 0 || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

async function resolveWorkspaceFsPath(
  fileSystem: WorkspaceFileSystem,
  workspaceRoot: string,
  targetPath: string,
  options?: { allowRoot?: boolean; defaultPath?: string }
): Promise<ResolvedWorkspacePath> {
  const normalizedTarget = targetPath.trim().length > 0 ? targetPath.trim() : (options?.defaultPath ?? ".");
  const absolutePath = path.resolve(workspaceRoot, normalizedTarget);

  // Resolve symlinks to prevent symlink-based path traversal.
  // If the target does not exist yet (e.g., a write path for a new file),
  // resolve the nearest existing ancestor and validate that, then re-append the remainder.
  let realWorkspaceRoot: string;
  try {
    realWorkspaceRoot = await fileSystem.realpath(workspaceRoot);
  } catch {
    realWorkspaceRoot = workspaceRoot;
  }

  let realAbsolutePath: string;
  try {
    realAbsolutePath = await fileSystem.realpath(absolutePath);
  } catch {
    // Target doesn't exist — resolve the deepest existing ancestor
    let current = absolutePath;
    const trailingParts: string[] = [];
    while (true) {
      try {
        const resolved = await fileSystem.realpath(current);
        realAbsolutePath = trailingParts.length > 0 ? path.join(resolved, ...trailingParts) : resolved;
        break;
      } catch {
        trailingParts.unshift(path.basename(current));
        const parent = path.dirname(current);
        if (parent === current) {
          // Reached filesystem root without finding an existing ancestor — fail safe
          throw new AppError(403, "workspace_path_not_allowed", `Path ${targetPath} is outside the workspace root.`);
        }
        current = parent;
      }
    }
  }

  const relativePath = path.relative(realWorkspaceRoot, realAbsolutePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new AppError(403, "workspace_path_not_allowed", `Path ${targetPath} is outside the workspace root.`);
  }

  const publicPath = relativePath.length > 0 ? normalizeRelativePath(relativePath) : ".";
  if (publicPath === "." && !options?.allowRoot) {
    throw new AppError(400, "workspace_root_mutation_not_allowed", "The workspace root cannot be modified directly.");
  }

  return {
    absolutePath,
    relativePath: publicPath
  };
}

function createStatEtag(entry: { size: number; mtimeMs: number; ino?: number | bigint | undefined }): string {
  const ino = typeof entry.ino === "bigint" ? Number(entry.ino) : (entry.ino ?? 0);
  return `W/"${entry.size.toString(16)}-${Math.floor(entry.mtimeMs).toString(16)}-${ino.toString(16)}"`;
}

function guessMimeType(filePath: string): string | undefined {
  switch (path.extname(filePath).toLowerCase()) {
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".md":
      return "text/markdown; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".ts":
      return "text/plain; charset=utf-8";
    case ".tsx":
      return "text/plain; charset=utf-8";
    case ".jsx":
      return "text/javascript; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".tif":
    case ".tiff":
      return "image/tiff";
    case ".avif":
      return "image/avif";
    case ".heic":
      return "image/heic";
    case ".heif":
      return "image/heif";
    case ".pdf":
      return "application/pdf";
    default:
      return undefined;
  }
}

function compareNumbers(left: number | undefined, right: number | undefined): number {
  if (left === right) {
    return 0;
  }

  if (left === undefined) {
    return 1;
  }

  if (right === undefined) {
    return -1;
  }

  return left - right;
}

function compareListedEntries(
  left: { name: string; kind: string },
  right: { name: string; kind: string },
  input: { sortBy: WorkspaceEntrySortBy; sortOrder: SortOrder }
): number {
  let comparison =
    input.sortBy === "type" ? (left.kind === "directory" ? 0 : 1) - (right.kind === "directory" ? 0 : 1) : 0;

  if (comparison === 0) {
    comparison = left.name.localeCompare(right.name);
  }

  return input.sortOrder === "desc" ? comparison * -1 : comparison;
}

function canPageBeforeStat(input: { sortBy: WorkspaceEntrySortBy }): boolean {
  return input.sortBy === "name" || input.sortBy === "type";
}

function toOptionalIsoTimestamp(epochMs: number | undefined): string | undefined {
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs) || epochMs <= 0) {
    return undefined;
  }

  return new Date(epochMs).toISOString();
}

function maxTimestamp(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) {
    return right;
  }

  if (right === undefined) {
    return left;
  }

  return Math.max(left, right);
}

function elapsedMs(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

function logSlowWorkspaceList(input: {
  workspaceId: string;
  path: string;
  pageSize: number;
  cursor?: string | undefined;
  totalMs: number;
  resolveMs: number;
  rootStatMs: number;
  readMs: number;
  buildMs: number;
  entriesSeen: number;
  itemsReturned: number;
  paged: boolean;
  metadata: boolean;
}): void {
  if (input.totalMs < SLOW_WORKSPACE_LIST_LOG_THRESHOLD_MS) {
    return;
  }

  console.warn(
    `[oah-workspace-files] Slow list workspace=${input.workspaceId} path=${input.path} totalMs=${input.totalMs.toFixed(1)} resolveMs=${input.resolveMs.toFixed(1)} rootStatMs=${input.rootStatMs.toFixed(1)} readMs=${input.readMs.toFixed(1)} buildMs=${input.buildMs.toFixed(1)} entriesSeen=${input.entriesSeen} itemsReturned=${input.itemsReturned} pageSize=${input.pageSize} cursor=${input.cursor ? "yes" : "no"} paged=${input.paged} metadata=${input.metadata}`
  );
}

export class WorkspaceFileService {
  readonly #fileSystem: WorkspaceFileSystem;
  readonly #descendantMtimeCache = new Map<string, { value: number | undefined; expiresAtMs: number }>();

  constructor(fileSystem: WorkspaceFileSystem = createLocalWorkspaceFileSystem()) {
    this.#fileSystem = fileSystem;
  }

  #clearDescendantMtimeCacheForPath(absolutePath: string): void {
    for (const cachedPath of this.#descendantMtimeCache.keys()) {
      if (isSamePathOrAncestor(cachedPath, absolutePath) || isSamePathOrAncestor(absolutePath, cachedPath)) {
        this.#descendantMtimeCache.delete(cachedPath);
      }
    }
  }

  #setCachedDescendantMtime(directoryPath: string, value: number | undefined): void {
    this.#descendantMtimeCache.set(directoryPath, {
      value,
      expiresAtMs: Date.now() + DESCENDANT_MTIME_CACHE_TTL_MS
    });
  }

  #getCachedDescendantMtime(directoryPath: string): number | undefined | null {
    const cached = this.#descendantMtimeCache.get(directoryPath);
    if (!cached) {
      return null;
    }

    if (cached.expiresAtMs <= Date.now()) {
      this.#descendantMtimeCache.delete(directoryPath);
      return null;
    }

    return cached.value;
  }

  async getLatestDescendantFileMtimeMs(
    directoryPath: string,
    context: DescendantMtimeScanContext = createDescendantMtimeScanContext()
  ): Promise<number | undefined> {
    const cached = this.#getCachedDescendantMtime(directoryPath);
    if (cached !== null) {
      return cached;
    }

    const entries = await context.directoryReadLimiter(() => this.#fileSystem.readdir(directoryPath));
    let latest: number | undefined;

    const timestamps = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(directoryPath, entry.name);
        if (entry.kind === "file") {
          const fileStat = await context.fileStatLimiter(() => this.#fileSystem.stat(entryPath));
          if (fileStat.kind !== "file") {
            return undefined;
          }

          return fileStat.mtimeMs;
        }

        if (entry.kind !== "directory") {
          return undefined;
        }

        return this.getLatestDescendantFileMtimeMs(entryPath, context);
      })
    );

    for (const timestamp of timestamps) {
      latest = maxTimestamp(latest, timestamp);
    }

    this.#setCachedDescendantMtime(directoryPath, latest);
    return latest;
  }

  async resolveWorkspaceEntryUpdatedAt(
    entry: WorkspaceFileStat,
    resolved: ResolvedWorkspacePath,
    listedEntry?: { updatedAt?: string | undefined },
    options?: {
      includeDirectoryDescendantUpdatedAt?: boolean | undefined;
      descendantMtimeScanContext?: DescendantMtimeScanContext | undefined;
    }
  ): Promise<string | undefined> {
    if (typeof listedEntry?.updatedAt === "string" && listedEntry.updatedAt.trim().length > 0) {
      return listedEntry.updatedAt;
    }

    if (entry.kind !== "directory" || options?.includeDirectoryDescendantUpdatedAt === false) {
      return toOptionalIsoTimestamp(entry.mtimeMs);
    }

    const latestDescendantFileMtimeMs = await this.getLatestDescendantFileMtimeMs(
      resolved.absolutePath,
      options?.descendantMtimeScanContext
    );
    return toOptionalIsoTimestamp(latestDescendantFileMtimeMs ?? entry.mtimeMs);
  }

  assertWorkspaceMutable(workspace: WorkspaceRecord): void {
    if (workspace.readOnly) {
      throw new AppError(403, "workspace_read_only", `Workspace ${workspace.id} is read-only.`);
    }
  }

  async buildWorkspaceEntry(
    workspace: WorkspaceRecord,
    resolved: ResolvedWorkspacePath,
    listedEntry?: { sizeBytes?: number | undefined; updatedAt?: string | undefined },
    options?: {
      includeDirectoryDescendantUpdatedAt?: boolean | undefined;
      descendantMtimeScanContext?: DescendantMtimeScanContext | undefined;
    }
  ): Promise<WorkspaceEntry> {
    const entry = await this.#fileSystem.stat(resolved.absolutePath).catch(() => null);
    if (!entry) {
      throw new AppError(404, "workspace_entry_not_found", `Path ${resolved.relativePath} was not found.`);
    }

    const updatedAt = await this.resolveWorkspaceEntryUpdatedAt(entry, resolved, listedEntry, options);
    return {
      path: resolved.relativePath,
      name: resolved.relativePath === "." ? path.basename(workspace.rootPath) : path.basename(resolved.absolutePath),
      type: entry.kind === "directory" ? "directory" : "file",
      ...(entry.kind === "file"
        ? {
            sizeBytes: listedEntry?.sizeBytes ?? entry.size,
            mimeType: guessMimeType(resolved.absolutePath),
            etag: createStatEtag(entry)
          }
        : {}),
      ...(updatedAt ? { updatedAt } : {}),
      readOnly: workspace.readOnly
    };
  }

  async writeWorkspaceFileBytes(
    workspace: WorkspaceRecord,
    input: {
      path: string;
      bytes: Buffer;
      overwrite?: boolean | undefined;
      ifMatch?: string | undefined;
      mtimeMs?: number | undefined;
    }
  ): Promise<WorkspaceEntry> {
    this.assertWorkspaceMutable(workspace);
    const resolved = await resolveWorkspaceFsPath(this.#fileSystem, workspace.rootPath, input.path);
    const existing = await this.#fileSystem.stat(resolved.absolutePath).catch(() => null);

    if (existing?.kind === "directory") {
      throw new AppError(409, "workspace_entry_conflict", `Path ${resolved.relativePath} already exists as a directory.`);
    }

    if (input.ifMatch !== undefined) {
      if (existing?.kind !== "file") {
        throw new AppError(
          412,
          "workspace_precondition_failed",
          `Path ${resolved.relativePath} does not match the requested precondition.`
        );
      }

      const currentEtag = createStatEtag(existing);
      if (currentEtag !== input.ifMatch) {
        throw new AppError(
          412,
          "workspace_precondition_failed",
          `Path ${resolved.relativePath} has changed since it was last read.`
        );
      }
    }

    if (existing?.kind === "file" && input.overwrite === false) {
      throw new AppError(409, "workspace_entry_exists", `Path ${resolved.relativePath} already exists.`);
    }

    await this.#fileSystem.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
    await this.#fileSystem.writeFile(resolved.absolutePath, input.bytes, {
      ...(typeof input.mtimeMs === "number" ? { mtimeMs: input.mtimeMs } : {})
    });
    this.#clearDescendantMtimeCacheForPath(resolved.absolutePath);
    return this.buildWorkspaceEntry(workspace, resolved);
  }

  async listEntries(
    workspace: WorkspaceRecord,
    input: {
      path?: string | undefined;
      pageSize: number;
      cursor?: string | undefined;
      sortBy: WorkspaceEntrySortBy;
      sortOrder: SortOrder;
      includeDirectoryDescendantUpdatedAt?: boolean | undefined;
      includeEntryMetadata?: boolean | undefined;
    }
  ): Promise<WorkspaceEntryPage> {
    const startedAt = process.hrtime.bigint();
    let resolvedPath = input.path ?? ".";
    let resolveMs = 0;
    let rootStatMs = 0;
    let readMs = 0;
    let buildMs = 0;
    let entriesSeen = 0;
    let itemsReturned = 0;
    let usedPagedFileSystem = false;

    const finish = <T extends WorkspaceEntryPage>(page: T): T => {
      itemsReturned = page.items.length;
      logSlowWorkspaceList({
        workspaceId: workspace.id,
        path: resolvedPath,
        pageSize: input.pageSize,
        cursor: input.cursor,
        totalMs: elapsedMs(startedAt),
        resolveMs,
        rootStatMs,
        readMs,
        buildMs,
        entriesSeen,
        itemsReturned,
        paged: usedPagedFileSystem,
        metadata: input.includeEntryMetadata !== false
      });
      return page;
    };

    const resolveStartedAt = process.hrtime.bigint();
    const resolved = await resolveWorkspaceFsPath(this.#fileSystem, workspace.rootPath, input.path ?? ".", {
      allowRoot: true,
      defaultPath: "."
    });
    resolveMs = elapsedMs(resolveStartedAt);
    resolvedPath = resolved.relativePath;

    const rootStatStartedAt = process.hrtime.bigint();
    const directoryEntry = await this.#fileSystem.stat(resolved.absolutePath).catch(() => null);
    rootStatMs = elapsedMs(rootStatStartedAt);
    if (directoryEntry?.kind !== "directory") {
      throw new AppError(404, "workspace_directory_not_found", `Directory ${resolved.relativePath} was not found.`);
    }

    const startIndex = parseCursor(input.cursor);
    let entries: WorkspaceFileSystemEntry[];
    let pageNextCursor: string | undefined;
    let entriesForStat: WorkspaceFileSystemEntry[];
    const canUsePagedFileSystem = this.#fileSystem.readdirPage !== undefined && canPageBeforeStat(input);
    if (canUsePagedFileSystem) {
      usedPagedFileSystem = true;
      const readStartedAt = process.hrtime.bigint();
      const page = await this.#fileSystem.readdirPage!(resolved.absolutePath, {
        pageSize: input.pageSize,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        sortBy: input.sortBy === "type" ? "type" : "name",
        sortOrder: input.sortOrder,
        includeMetadata: input.includeEntryMetadata !== false,
        includeDirectoryDescendantUpdatedAt: input.includeDirectoryDescendantUpdatedAt
      });
      entries = page.items;
      entriesForStat = page.items;
      pageNextCursor = page.nextCursor;
      readMs = elapsedMs(readStartedAt);
    } else {
      const readStartedAt = process.hrtime.bigint();
      entries = await this.#fileSystem.readdir(resolved.absolutePath);
      readMs = elapsedMs(readStartedAt);
      entriesForStat = canPageBeforeStat(input)
        ? [...entries].sort((left, right) => compareListedEntries(left, right, input)).slice(startIndex, startIndex + input.pageSize)
        : entries;
    }
    entriesSeen = entries.length;

    if (input.includeEntryMetadata === false && canPageBeforeStat(input)) {
      const buildStartedAt = process.hrtime.bigint();
      const items = entriesForStat.map((entry) => {
        const relativePath =
          resolved.relativePath === "."
            ? normalizeRelativePath(entry.name)
            : normalizeRelativePath(path.posix.join(resolved.relativePath, entry.name));

        return {
          path: relativePath,
          name: entry.name,
          type: entry.kind === "directory" ? "directory" : "file",
          readOnly: workspace.readOnly
        } satisfies WorkspaceEntry;
      });
      const nextCursor = canUsePagedFileSystem
        ? pageNextCursor
        : startIndex + input.pageSize < entries.length
          ? String(startIndex + input.pageSize)
          : undefined;
      buildMs = elapsedMs(buildStartedAt);

      return finish(nextCursor === undefined
        ? {
            workspaceId: workspace.id,
            path: resolved.relativePath,
            items
          }
        : {
            workspaceId: workspace.id,
            path: resolved.relativePath,
            items,
            nextCursor
          });
    }

    const descendantMtimeScanContext =
      input.includeDirectoryDescendantUpdatedAt === false ? undefined : createDescendantMtimeScanContext();
    const buildStartedAt = process.hrtime.bigint();
    const items = await Promise.all(
      entriesForStat.map(async (entry) => {
        const relativePath =
          resolved.relativePath === "."
            ? normalizeRelativePath(entry.name)
            : normalizeRelativePath(path.posix.join(resolved.relativePath, entry.name));

        return this.buildWorkspaceEntry(
          workspace,
          {
            absolutePath: path.join(resolved.absolutePath, entry.name),
            relativePath
          },
          {
            ...(typeof entry.sizeBytes === "number" ? { sizeBytes: entry.sizeBytes } : {}),
            ...(typeof entry.updatedAt === "string" && entry.updatedAt.trim().length > 0
              ? { updatedAt: entry.updatedAt }
              : {})
          },
          {
            includeDirectoryDescendantUpdatedAt: input.includeDirectoryDescendantUpdatedAt,
            descendantMtimeScanContext
          }
        );
      })
    );
    buildMs = elapsedMs(buildStartedAt);

    items.sort((left, right) => {
      let comparison = 0;
      switch (input.sortBy) {
        case "updatedAt":
          comparison = compareNumbers(
            left.updatedAt ? Date.parse(left.updatedAt) : undefined,
            right.updatedAt ? Date.parse(right.updatedAt) : undefined
          );
          break;
        case "sizeBytes":
          comparison = compareNumbers(left.sizeBytes, right.sizeBytes);
          break;
        case "type":
          comparison =
            (left.type === "directory" ? 0 : 1) - (right.type === "directory" ? 0 : 1) ||
            left.name.localeCompare(right.name);
          break;
        case "name":
        default:
          comparison = left.name.localeCompare(right.name);
          break;
      }

      if (comparison === 0) {
        comparison = left.path.localeCompare(right.path);
      }

      return input.sortOrder === "desc" ? comparison * -1 : comparison;
    });

    if (canPageBeforeStat(input)) {
      const nextCursor = canUsePagedFileSystem
        ? pageNextCursor
        : startIndex + input.pageSize < entries.length
          ? String(startIndex + input.pageSize)
          : undefined;

      return finish(nextCursor === undefined
        ? {
            workspaceId: workspace.id,
            path: resolved.relativePath,
            items
          }
        : {
            workspaceId: workspace.id,
            path: resolved.relativePath,
            items,
            nextCursor
          });
    }

    const pageItems = items.slice(startIndex, startIndex + input.pageSize);
    const nextCursor = startIndex + input.pageSize < items.length ? String(startIndex + input.pageSize) : undefined;

    return finish(nextCursor === undefined
      ? {
          workspaceId: workspace.id,
          path: resolved.relativePath,
          items: pageItems
        }
      : {
          workspaceId: workspace.id,
          path: resolved.relativePath,
          items: pageItems,
          nextCursor
        });
  }

  async getFileContent(
    workspace: WorkspaceRecord,
    input: { path: string; encoding: "utf8" | "base64"; maxBytes?: number | undefined }
  ): Promise<WorkspaceFileContentResult> {
    const resolved = await resolveWorkspaceFsPath(this.#fileSystem, workspace.rootPath, input.path);
    const entry = await this.#fileSystem.stat(resolved.absolutePath).catch(() => null);
    if (entry?.kind !== "file") {
      throw new AppError(404, "workspace_file_not_found", `File ${resolved.relativePath} was not found.`);
    }

    const truncated = input.maxBytes !== undefined && entry.size > input.maxBytes;
    const contentBytes =
      input.maxBytes !== undefined && truncated
        ? await (this.#fileSystem.readFileRange?.(resolved.absolutePath, input.maxBytes) ??
            this.#fileSystem.readFile(resolved.absolutePath).then((raw) => raw.subarray(0, input.maxBytes)))
        : await this.#fileSystem.readFile(resolved.absolutePath);
    return {
      workspaceId: workspace.id,
      path: resolved.relativePath,
      encoding: input.encoding,
      content: input.encoding === "base64" ? contentBytes.toString("base64") : contentBytes.toString("utf8"),
      truncated,
      sizeBytes: entry.size,
      mimeType: guessMimeType(resolved.absolutePath),
      etag: createStatEtag(entry),
      ...(toOptionalIsoTimestamp(entry.mtimeMs) ? { updatedAt: toOptionalIsoTimestamp(entry.mtimeMs) } : {}),
      readOnly: workspace.readOnly
    };
  }

  async putFileContent(
    workspace: WorkspaceRecord,
    input: {
      path: string;
      content: string;
      encoding: "utf8" | "base64";
      overwrite?: boolean | undefined;
      ifMatch?: string | undefined;
    }
  ): Promise<WorkspaceEntry> {
    return this.writeWorkspaceFileBytes(workspace, {
      path: input.path,
      bytes: Buffer.from(input.content, input.encoding),
      overwrite: input.overwrite,
      ifMatch: input.ifMatch
    });
  }

  async uploadFile(
    workspace: WorkspaceRecord,
    input: { path: string; data: Buffer; overwrite?: boolean | undefined; ifMatch?: string | undefined; mtimeMs?: number | undefined }
  ): Promise<WorkspaceEntry> {
    return this.writeWorkspaceFileBytes(workspace, {
      path: input.path,
      bytes: input.data,
      overwrite: input.overwrite,
      ifMatch: input.ifMatch,
      ...(typeof input.mtimeMs === "number" ? { mtimeMs: input.mtimeMs } : {})
    });
  }

  async createDirectory(
    workspace: WorkspaceRecord,
    input: { path: string; createParents: boolean }
  ): Promise<WorkspaceEntry> {
    this.assertWorkspaceMutable(workspace);
    const resolved = await resolveWorkspaceFsPath(this.#fileSystem, workspace.rootPath, input.path);
    const existing = await this.#fileSystem.stat(resolved.absolutePath).catch(() => null);

    if (existing?.kind === "file") {
      throw new AppError(409, "workspace_entry_conflict", `Path ${resolved.relativePath} already exists as a file.`);
    }

    await this.#fileSystem.mkdir(resolved.absolutePath, { recursive: input.createParents });
    this.#clearDescendantMtimeCacheForPath(resolved.absolutePath);
    return this.buildWorkspaceEntry(workspace, resolved);
  }

  async deleteEntry(
    workspace: WorkspaceRecord,
    input: { path: string; recursive: boolean }
  ): Promise<WorkspaceDeleteResult> {
    this.assertWorkspaceMutable(workspace);
    const resolved = await resolveWorkspaceFsPath(this.#fileSystem, workspace.rootPath, input.path);
    const existing = await this.#fileSystem.stat(resolved.absolutePath).catch(() => null);
    if (!existing) {
      throw new AppError(404, "workspace_entry_not_found", `Path ${resolved.relativePath} was not found.`);
    }

    const type = existing.kind === "directory" ? "directory" : "file";
    if (existing.kind === "directory" && !input.recursive) {
      const children = await this.#fileSystem.readdir(resolved.absolutePath);
      if (children.length > 0) {
        throw new AppError(
          409,
          "workspace_directory_not_empty",
          `Directory ${resolved.relativePath} is not empty. Set recursive=true to delete it.`
        );
      }
    }

    await this.#fileSystem.rm(resolved.absolutePath, {
      recursive: input.recursive,
      force: false
    });
    this.#clearDescendantMtimeCacheForPath(resolved.absolutePath);

    return {
      workspaceId: workspace.id,
      path: resolved.relativePath,
      type,
      deleted: true
    };
  }

  async moveEntry(
    workspace: WorkspaceRecord,
    input: { sourcePath: string; targetPath: string; overwrite: boolean }
  ): Promise<WorkspaceEntry> {
    this.assertWorkspaceMutable(workspace);
    const source = await resolveWorkspaceFsPath(this.#fileSystem, workspace.rootPath, input.sourcePath);
    const target = await resolveWorkspaceFsPath(this.#fileSystem, workspace.rootPath, input.targetPath);

    const existingSource = await this.#fileSystem.stat(source.absolutePath).catch(() => null);
    if (!existingSource) {
      throw new AppError(404, "workspace_entry_not_found", `Path ${source.relativePath} was not found.`);
    }

    if (source.relativePath === target.relativePath) {
      return this.buildWorkspaceEntry(workspace, target);
    }

    const existingTarget = await this.#fileSystem.stat(target.absolutePath).catch(() => null);
    if (existingTarget && !input.overwrite) {
      throw new AppError(409, "workspace_entry_exists", `Path ${target.relativePath} already exists.`);
    }

    if (existingTarget) {
      await this.#fileSystem.rm(target.absolutePath, {
        recursive: true,
        force: true
      });
    }

    await this.#fileSystem.mkdir(path.dirname(target.absolutePath), { recursive: true });
    await this.#fileSystem.rename(source.absolutePath, target.absolutePath);
    this.#clearDescendantMtimeCacheForPath(source.absolutePath);
    this.#clearDescendantMtimeCacheForPath(target.absolutePath);
    return this.buildWorkspaceEntry(workspace, target);
  }

  async getFileDownload(workspace: WorkspaceRecord, targetPath: string): Promise<WorkspaceFileDownloadResult> {
    const resolved = await resolveWorkspaceFsPath(this.#fileSystem, workspace.rootPath, targetPath);
    const entry = await this.#fileSystem.stat(resolved.absolutePath).catch(() => null);
    if (entry?.kind !== "file") {
      throw new AppError(404, "workspace_file_not_found", `File ${resolved.relativePath} was not found.`);
    }

    const updatedAt = toOptionalIsoTimestamp(entry.mtimeMs);

    return {
      workspaceId: workspace.id,
      path: resolved.relativePath,
      name: path.basename(resolved.absolutePath),
      sizeBytes: entry.size,
      mimeType: guessMimeType(resolved.absolutePath),
      etag: createStatEtag(entry),
      ...(updatedAt ? { updatedAt } : {}),
      readOnly: workspace.readOnly,
      openReadStream: () => this.#fileSystem.openReadStream(resolved.absolutePath)
    };
  }
}
