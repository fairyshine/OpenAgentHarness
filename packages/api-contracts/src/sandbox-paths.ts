export const SANDBOX_ROOT_PATH = "/workspace";

function splitNormalizedPathSegments(value: string): string[] {
  return value
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== ".");
}

function applyPathSegments(baseSegments: string[], value: string): string[] {
  const segments = [...baseSegments];
  for (const segment of splitNormalizedPathSegments(value)) {
    if (segment === "..") {
      segments.pop();
      continue;
    }

    segments.push(segment);
  }

  return segments;
}

export function normalizeWorkspaceRelativePath(value: string): string {
  const segments = applyPathSegments([], value);
  return segments.length > 0 ? segments.join("/") : ".";
}

export function joinWorkspaceRelativePath(basePath: string, childPath: string): string {
  return normalizeWorkspaceRelativePath(basePath === "." ? childPath : `${basePath}/${childPath}`);
}

export function parentWorkspaceRelativePath(value: string): string {
  const normalized = normalizeWorkspaceRelativePath(value);
  if (normalized === ".") {
    return ".";
  }

  const segments = normalized.split("/");
  return segments.length > 1 ? segments.slice(0, -1).join("/") : ".";
}

export function normalizeSandboxPath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  if (!normalized || normalized === "." || normalized === "/") {
    return SANDBOX_ROOT_PATH;
  }

  const segments = applyPathSegments(normalized.startsWith("/") ? [] : [SANDBOX_ROOT_PATH.slice(1)], normalized);
  if (segments.length === 0) {
    return SANDBOX_ROOT_PATH;
  }

  if (segments[0] !== SANDBOX_ROOT_PATH.slice(1)) {
    throw new Error(`Path ${value} is outside sandbox root ${SANDBOX_ROOT_PATH}.`);
  }

  return `/${segments.join("/")}`;
}

export function workspaceRelativePathToSandboxPath(value: string): string {
  return normalizeSandboxPath(value);
}

export function sandboxPathToWorkspaceRelativePath(value: string): string {
  const normalized = normalizeSandboxPath(value);
  if (normalized === SANDBOX_ROOT_PATH) {
    return ".";
  }

  return normalizeWorkspaceRelativePath(normalized.slice(`${SANDBOX_ROOT_PATH}/`.length));
}

export function buildSandboxApiPath(sandboxId: string, suffix?: string): string {
  const basePath = `/api/v1/sandboxes/${encodeURIComponent(sandboxId.trim())}`;
  if (!suffix) {
    return basePath;
  }

  return suffix.startsWith("/") ? `${basePath}${suffix}` : `${basePath}/${suffix}`;
}

export function buildSandboxCollectionApiPath(): string {
  return "/api/v1/sandboxes";
}
