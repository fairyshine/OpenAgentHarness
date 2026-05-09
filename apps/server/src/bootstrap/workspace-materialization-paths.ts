import { createHash } from "node:crypto";
import path from "node:path";

import type { WorkspaceRecord } from "@oah/engine-core";

import type { WorkspaceMaterializationSource } from "./workspace-materialization-types.js";

export function normalizeRemotePrefix(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, "");
}

export function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "workspace";
}

export function buildCacheSuffix(input: { workspaceId: string; version: string; source: WorkspaceMaterializationSource }): string {
  const sourceKey = input.source.kind === "object_store" ? `${input.source.bucket ?? ""}:${input.source.remotePrefix}` : input.source.rootPath;
  return createHash("sha1").update(`${input.workspaceId}:${input.version}:${sourceKey}`).digest("hex").slice(0, 12);
}

export function inferWorkspaceRootFromCacheRoot(cacheRoot: string): string {
  const normalizedCacheRoot = path.resolve(cacheRoot);
  const cacheParent = path.dirname(normalizedCacheRoot);
  if (path.basename(normalizedCacheRoot) === "__materialized__" && path.basename(cacheParent) === ".openharness") {
    return path.dirname(cacheParent);
  }

  return normalizedCacheRoot;
}

export function parseExternalWorkspaceRef(externalRef: string): { bucket?: string | undefined; remotePrefix: string } {
  const parsed = new URL(externalRef);
  if (parsed.protocol !== "s3:") {
    throw new Error(`Unsupported workspace externalRef protocol: ${parsed.protocol}`);
  }

  return {
    bucket: parsed.hostname || undefined,
    remotePrefix: normalizeRemotePrefix(parsed.pathname)
  };
}

export function resolveWorkspaceMaterializationSource(
  workspace: Pick<WorkspaceRecord, "rootPath" | "externalRef">
): WorkspaceMaterializationSource {
  if (!workspace.externalRef) {
    return {
      kind: "local_directory",
      rootPath: workspace.rootPath
    };
  }

  const parsed = parseExternalWorkspaceRef(workspace.externalRef);
  return {
    kind: "object_store",
    bucket: parsed.bucket,
    remotePrefix: parsed.remotePrefix
  };
}
