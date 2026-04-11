import { realpathSync } from "node:fs";
import path from "node:path";

import { AppError } from "../errors.js";

export function normalizePathForMatch(value: string): string {
  return value.split(path.sep).join("/");
}

export function resolveWorkspacePath(workspaceRoot: string, targetPath: string): { absolutePath: string; relativePath: string } {
  const absolutePath = path.resolve(workspaceRoot, targetPath);

  // Resolve symlinks to prevent symlink-based path traversal.
  let realWorkspaceRoot: string;
  try {
    realWorkspaceRoot = realpathSync(workspaceRoot);
  } catch {
    realWorkspaceRoot = workspaceRoot;
  }

  let realAbsolutePath: string;
  try {
    realAbsolutePath = realpathSync(absolutePath);
  } catch {
    // Target doesn't exist — resolve the deepest existing ancestor
    let current = absolutePath;
    const trailingParts: string[] = [];
    while (true) {
      try {
        const resolved = realpathSync(current);
        realAbsolutePath = trailingParts.length > 0 ? path.join(resolved, ...trailingParts) : resolved;
        break;
      } catch {
        trailingParts.unshift(path.basename(current));
        const parent = path.dirname(current);
        if (parent === current) {
          throw new AppError(403, "native_tool_path_not_allowed", `Path ${targetPath} is outside the workspace root.`);
        }
        current = parent;
      }
    }
  }

  const relativePath = path.relative(realWorkspaceRoot, realAbsolutePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new AppError(403, "native_tool_path_not_allowed", `Path ${targetPath} is outside the workspace root.`);
  }

  return {
    absolutePath,
    relativePath: relativePath.length > 0 ? relativePath.split(path.sep).join("/") : "."
  };
}
