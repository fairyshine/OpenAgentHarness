import path from "node:path";
import type { Readable } from "node:stream";

import { AppError } from "./errors.js";
import { createLocalWorkspaceFileSystem } from "./workspace-file-system.js";
import type { WorkspaceFileStat, WorkspaceFileSystem, WorkspaceRecord } from "./types.js";
import { parseCursor } from "./utils.js";

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
  updatedAt: string;
  readOnly: boolean;
  openReadStream(): Readable;
}

interface ResolvedWorkspacePath {
  absolutePath: string;
  relativePath: string;
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/");
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

export class WorkspaceFileService {
  readonly #fileSystem: WorkspaceFileSystem;

  constructor(fileSystem: WorkspaceFileSystem = createLocalWorkspaceFileSystem()) {
    this.#fileSystem = fileSystem;
  }

  assertWorkspaceMutable(workspace: WorkspaceRecord): void {
    if (workspace.readOnly) {
      throw new AppError(403, "workspace_read_only", `Workspace ${workspace.id} is read-only.`);
    }
  }

  async buildWorkspaceEntry(workspace: WorkspaceRecord, resolved: ResolvedWorkspacePath): Promise<WorkspaceEntry> {
    const entry = await this.#fileSystem.stat(resolved.absolutePath).catch(() => null);
    if (!entry) {
      throw new AppError(404, "workspace_entry_not_found", `Path ${resolved.relativePath} was not found.`);
    }

    return {
      path: resolved.relativePath,
      name: resolved.relativePath === "." ? path.basename(workspace.rootPath) : path.basename(resolved.absolutePath),
      type: entry.kind === "directory" ? "directory" : "file",
      ...(entry.kind === "file"
        ? {
            sizeBytes: entry.size,
            mimeType: guessMimeType(resolved.absolutePath),
            etag: createStatEtag(entry)
          }
        : {}),
      updatedAt: new Date(entry.mtimeMs).toISOString(),
      createdAt: new Date(entry.birthtimeMs).toISOString(),
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
    await this.#fileSystem.writeFile(resolved.absolutePath, input.bytes);
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
    }
  ): Promise<WorkspaceEntryPage> {
    const resolved = await resolveWorkspaceFsPath(this.#fileSystem, workspace.rootPath, input.path ?? ".", {
      allowRoot: true,
      defaultPath: "."
    });
    const directoryEntry = await this.#fileSystem.stat(resolved.absolutePath).catch(() => null);
    if (directoryEntry?.kind !== "directory") {
      throw new AppError(404, "workspace_directory_not_found", `Directory ${resolved.relativePath} was not found.`);
    }

    const entries = await this.#fileSystem.readdir(resolved.absolutePath);
    const items = await Promise.all(
      entries.map(async (entry) =>
        this.buildWorkspaceEntry(workspace, {
          absolutePath: path.join(resolved.absolutePath, entry.name),
          relativePath:
            resolved.relativePath === "."
              ? normalizeRelativePath(entry.name)
              : normalizeRelativePath(path.posix.join(resolved.relativePath, entry.name))
        })
      )
    );

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

    const startIndex = parseCursor(input.cursor);
    const pageItems = items.slice(startIndex, startIndex + input.pageSize);
    const nextCursor = startIndex + input.pageSize < items.length ? String(startIndex + input.pageSize) : undefined;

    return nextCursor === undefined
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
        };
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

    const raw = await this.#fileSystem.readFile(resolved.absolutePath);
    const truncated = input.maxBytes !== undefined && raw.length > input.maxBytes;
    const contentBytes = truncated ? raw.subarray(0, input.maxBytes) : raw;
    return {
      workspaceId: workspace.id,
      path: resolved.relativePath,
      encoding: input.encoding,
      content: input.encoding === "base64" ? contentBytes.toString("base64") : contentBytes.toString("utf8"),
      truncated,
      sizeBytes: raw.length,
      mimeType: guessMimeType(resolved.absolutePath),
      etag: createStatEtag(entry),
      updatedAt: new Date(entry.mtimeMs).toISOString(),
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
    input: { path: string; data: Buffer; overwrite?: boolean | undefined; ifMatch?: string | undefined }
  ): Promise<WorkspaceEntry> {
    return this.writeWorkspaceFileBytes(workspace, {
      path: input.path,
      bytes: input.data,
      overwrite: input.overwrite,
      ifMatch: input.ifMatch
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
    return this.buildWorkspaceEntry(workspace, target);
  }

  async getFileDownload(workspace: WorkspaceRecord, targetPath: string): Promise<WorkspaceFileDownloadResult> {
    const resolved = await resolveWorkspaceFsPath(this.#fileSystem, workspace.rootPath, targetPath);
    const entry = await this.#fileSystem.stat(resolved.absolutePath).catch(() => null);
    if (entry?.kind !== "file") {
      throw new AppError(404, "workspace_file_not_found", `File ${resolved.relativePath} was not found.`);
    }

    return {
      workspaceId: workspace.id,
      path: resolved.relativePath,
      name: path.basename(resolved.absolutePath),
      sizeBytes: entry.size,
      mimeType: guessMimeType(resolved.absolutePath),
      etag: createStatEtag(entry),
      updatedAt: new Date(entry.mtimeMs).toISOString(),
      readOnly: workspace.readOnly,
      openReadStream: () => this.#fileSystem.openReadStream(resolved.absolutePath)
    };
  }
}
