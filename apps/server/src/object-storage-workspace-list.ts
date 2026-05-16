import path from "node:path";

import type {
  SortOrder,
  WorkspaceEntry,
  WorkspaceEntryPage,
  WorkspaceEntrySortBy
} from "@oah/engine-core";
import { AppError } from "@oah/engine-core";

import {
  relativePathFromRemoteKey,
  shouldIgnoreRelativePath
} from "./object-storage-manifest.js";
import type { DirectoryObjectStore, ObjectStorageDirectoryEntry, ObjectStorageEntry } from "./object-storage.js";
import { resolveWorkspaceMaterializationSource } from "./bootstrap/workspace-materialization-paths.js";

type WorkspaceForObjectStoreList = {
  id: string;
  rootPath: string;
  externalRef?: string | undefined;
  readOnly: boolean;
};

type ObjectStoreDirectoryChild = {
  name: string;
  kind: "file" | "directory";
  sizeBytes?: number | undefined;
  updatedAt?: string | undefined;
};

function normalizeWorkspacePath(value: string | undefined): string {
  const normalized = (value ?? ".")
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
  const segments: string[] = [];
  for (const segment of normalized) {
    if (segment === "..") {
      segments.pop();
    } else {
      segments.push(segment);
    }
  }

  return segments.length > 0 ? segments.join("/") : ".";
}

function joinWorkspacePath(basePath: string, childName: string): string {
  return basePath === "." ? childName : `${basePath}/${childName}`;
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

function compareEntries(
  left: ObjectStoreDirectoryChild,
  right: ObjectStoreDirectoryChild,
  input: { sortBy: WorkspaceEntrySortBy; sortOrder: SortOrder }
): number {
  let comparison = 0;
  if (input.sortBy === "type") {
    comparison = (left.kind === "directory" ? 0 : 1) - (right.kind === "directory" ? 0 : 1);
  } else if (input.sortBy === "sizeBytes") {
    comparison = compareNumbers(left.sizeBytes, right.sizeBytes);
  } else if (input.sortBy === "updatedAt") {
    comparison = (left.updatedAt ?? "").localeCompare(right.updatedAt ?? "");
  }

  if (comparison === 0) {
    comparison = left.name.localeCompare(right.name);
  }

  return input.sortOrder === "desc" ? comparison * -1 : comparison;
}

function parseCursor(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function toIsoTimestamp(entry: ObjectStorageEntry): string | undefined {
  return entry.lastModified ? entry.lastModified.toISOString() : undefined;
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
    case ".jsx":
      return "text/javascript; charset=utf-8";
    case ".ts":
    case ".tsx":
      return "text/plain; charset=utf-8";
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

function collectObjectStoreDirectoryChildren(input: {
  remotePrefix: string;
  entries: ObjectStorageEntry[];
  directoryPath: string;
  includeDirectoryDescendantUpdatedAt: boolean;
}): ObjectStoreDirectoryChild[] {
  const children = new Map<string, ObjectStoreDirectoryChild>();
  const directoryPrefix = input.directoryPath === "." ? "" : `${input.directoryPath}/`;

  for (const entry of input.entries) {
    const relativePath = relativePathFromRemoteKey(input.remotePrefix, entry.key);
    if (relativePath === undefined || relativePath.length === 0 || shouldIgnoreRelativePath(relativePath)) {
      continue;
    }
    if (input.directoryPath !== "." && !relativePath.startsWith(directoryPrefix)) {
      continue;
    }

    const remainder = input.directoryPath === "." ? relativePath : relativePath.slice(directoryPrefix.length);
    if (!remainder || remainder.startsWith("/")) {
      continue;
    }
    const [name, ...descendantSegments] = remainder.split("/");
    if (!name) {
      continue;
    }

    const updatedAt = toIsoTimestamp(entry);
    if (descendantSegments.length === 0) {
      children.set(name, {
        name,
        kind: "file",
        sizeBytes: entry.size,
        ...(updatedAt ? { updatedAt } : {})
      });
      continue;
    }

    const existing = children.get(name);
    if (existing?.kind === "file") {
      continue;
    }
    const nextUpdatedAt =
      input.includeDirectoryDescendantUpdatedAt && updatedAt && (!existing?.updatedAt || updatedAt > existing.updatedAt)
        ? updatedAt
        : existing?.updatedAt;
    children.set(name, {
      name,
      kind: "directory",
      ...(nextUpdatedAt ? { updatedAt: nextUpdatedAt } : {})
    });
  }

  return [...children.values()];
}

function collectListedDirectoryChildren(entries: ObjectStorageDirectoryEntry[]): ObjectStoreDirectoryChild[] {
  return entries
    .filter((entry) => entry.name.trim().length > 0 && !entry.name.includes("/") && !shouldIgnoreRelativePath(entry.name))
    .map((entry) => ({
      name: entry.name,
      kind: entry.kind,
      ...(entry.kind === "file" && typeof entry.size === "number" ? { sizeBytes: entry.size } : {}),
      ...(entry.lastModified ? { updatedAt: entry.lastModified.toISOString() } : {})
    }));
}

export function createObjectStorageWorkspaceEntryLister(input: {
  store: DirectoryObjectStore;
  getWorkspaceRecord(workspaceId: string): Promise<WorkspaceForObjectStoreList | undefined>;
  shouldUseObjectStoreList?(workspaceId: string): boolean;
  prewarmWorkspace?: ((workspaceId: string) => void) | undefined;
  logger?: ((message: string) => void) | undefined;
}) {
  return async function listWorkspaceEntriesFast(query: {
    workspaceId: string;
    path?: string | undefined;
    pageSize: number;
    cursor?: string | undefined;
    sortBy: WorkspaceEntrySortBy;
    sortOrder: SortOrder;
    includeDirectoryDescendantUpdatedAt?: boolean | undefined;
    includeEntryMetadata?: boolean | undefined;
  }): Promise<WorkspaceEntryPage | undefined> {
    const workspace = await input.getWorkspaceRecord(query.workspaceId);
    if (!workspace?.externalRef) {
      return undefined;
    }
    if (input.shouldUseObjectStoreList && !input.shouldUseObjectStoreList(query.workspaceId)) {
      return undefined;
    }

    const source = resolveWorkspaceMaterializationSource(workspace);
    if (source.kind !== "object_store") {
      return undefined;
    }
    if (source.bucket && input.store.bucket && source.bucket !== input.store.bucket) {
      return undefined;
    }

    const directoryPath = normalizeWorkspacePath(query.path);
    const includeMetadata = query.includeEntryMetadata !== false;
    const includeDirectoryDescendantUpdatedAt = query.includeDirectoryDescendantUpdatedAt !== false;
    const needsDescendantDirectoryTimes = includeMetadata && includeDirectoryDescendantUpdatedAt;
    const useFlatListing = !input.store.listDirectoryEntries || needsDescendantDirectoryTimes;
    const entries = useFlatListing ? await input.store.listEntries(source.remotePrefix) : undefined;
    const children = (
      useFlatListing
        ? collectObjectStoreDirectoryChildren({
            remotePrefix: source.remotePrefix,
            entries: entries ?? [],
            directoryPath,
            includeDirectoryDescendantUpdatedAt
          })
        : input.store.listDirectoryEntries
        ? collectListedDirectoryChildren(await input.store.listDirectoryEntries(source.remotePrefix, directoryPath === "." ? "" : directoryPath))
        : []
    ).sort((left, right) => compareEntries(left, right, query));

    if (children.length === 0 && directoryPath !== "." && entries) {
      const hasDescendant = entries.some((entry) => {
        const relativePath = relativePathFromRemoteKey(source.remotePrefix, entry.key);
        return relativePath !== undefined && relativePath.startsWith(`${directoryPath}/`) && !shouldIgnoreRelativePath(relativePath);
      });
      if (!hasDescendant) {
        throw new AppError(404, "workspace_directory_not_found", `Directory ${directoryPath} was not found.`);
      }
    }

    const startIndex = parseCursor(query.cursor);
    const pagedChildren = children.slice(startIndex, startIndex + query.pageSize);
    const nextIndex = startIndex + query.pageSize;
    const items = pagedChildren.map((entry): WorkspaceEntry => {
      const entryPath = joinWorkspacePath(directoryPath, entry.name);
      return {
        path: entryPath,
        name: entry.name,
        type: entry.kind === "directory" ? "directory" : "file",
        readOnly: workspace.readOnly,
        ...(includeMetadata && entry.kind === "file" ? { sizeBytes: entry.sizeBytes } : {}),
        ...(includeMetadata && entry.kind === "file" ? { mimeType: guessMimeType(entryPath) } : {}),
        ...(includeMetadata && entry.updatedAt ? { updatedAt: entry.updatedAt } : {})
      };
    });

    input.prewarmWorkspace?.(query.workspaceId);
    input.logger?.(
      `[oah-object-storage] Served workspace ${query.workspaceId} directory ${directoryPath} from object storage without materialization`
    );

    return {
      workspaceId: workspace.id,
      path: directoryPath,
      items,
      ...(nextIndex < children.length ? { nextCursor: String(nextIndex) } : {})
    };
  };
}
