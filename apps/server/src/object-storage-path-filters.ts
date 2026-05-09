import { normalizeRelativePath } from "./object-storage-manifest.js";

export function shouldExcludeWorkspaceMirrorRelativePath(relativePath: string): boolean {
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
