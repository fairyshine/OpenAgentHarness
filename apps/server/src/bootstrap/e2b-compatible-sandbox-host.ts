import path from "node:path";
import { Readable } from "node:stream";

import {
  SANDBOX_ROOT_PATH,
  createSandboxHttpClient,
  type SandboxHttpTransport
} from "@oah/api-contracts";
import type {
  WorkspaceBackgroundCommandExecutionResult,
  WorkspaceCommandExecutor,
  WorkspaceExecutionLease,
  WorkspaceExecutionProvider,
  WorkspaceFileAccessLease,
  WorkspaceFileAccessProvider,
  WorkspaceFileStat,
  WorkspaceFileSystem,
  WorkspaceFileSystemEntry,
  WorkspaceForegroundCommandExecutionResult,
  WorkspaceRecord
} from "@oah/engine-core";

import type { SandboxHost } from "./sandbox-host.js";

const VIRTUAL_SANDBOX_ROOT = "/__oah_sandbox__";
const SANDBOX_LIST_PAGE_SIZE = 200;

export interface E2BCompatibleSandboxLease {
  sandboxId: string;
  rootPath: string;
  release(options?: { dirty?: boolean | undefined }): Promise<void> | void;
}

export interface E2BCompatibleSandboxService {
  acquireExecution(input: {
    workspace: WorkspaceRecord;
    run: { id: string; sessionId?: string | undefined };
    session?: { id: string } | undefined;
  }): Promise<E2BCompatibleSandboxLease>;
  acquireFileAccess(input: {
    workspace: WorkspaceRecord;
    access: "read" | "write";
    path?: string | undefined;
  }): Promise<E2BCompatibleSandboxLease>;
  runCommand(input: {
    sandboxId: string;
    rootPath: string;
    command: string;
    cwd?: string | undefined;
    env?: Record<string, string> | undefined;
    timeoutMs?: number | undefined;
    stdinText?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<WorkspaceForegroundCommandExecutionResult>;
  runProcess(input: {
    sandboxId: string;
    rootPath: string;
    executable: string;
    args: string[];
    cwd?: string | undefined;
    env?: Record<string, string> | undefined;
    timeoutMs?: number | undefined;
    stdinText?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<WorkspaceForegroundCommandExecutionResult>;
  runBackground(input: {
    sandboxId: string;
    rootPath: string;
    command: string;
    sessionId: string;
    description?: string | undefined;
    cwd?: string | undefined;
    env?: Record<string, string> | undefined;
  }): Promise<WorkspaceBackgroundCommandExecutionResult>;
  stat(input: { sandboxId: string; path: string }): Promise<WorkspaceFileStat>;
  readFile(input: { sandboxId: string; path: string }): Promise<Buffer>;
  openReadStream?(input: { sandboxId: string; path: string }): Readable;
  readdir(input: { sandboxId: string; path: string }): Promise<WorkspaceFileSystemEntry[]>;
  mkdir(input: { sandboxId: string; path: string; recursive?: boolean | undefined }): Promise<void>;
  writeFile(input: { sandboxId: string; path: string; data: Buffer; mtimeMs?: number | undefined }): Promise<void>;
  rm(input: {
    sandboxId: string;
    path: string;
    recursive?: boolean | undefined;
    force?: boolean | undefined;
  }): Promise<void>;
  rename(input: { sandboxId: string; sourcePath: string; targetPath: string }): Promise<void>;
  realpath?(input: { sandboxId: string; path: string }): Promise<string>;
  diagnostics?(): Record<string, unknown>;
  maintain?(options: { idleBefore: string }): Promise<void>;
  beginDrain?(): Promise<void>;
  close(): Promise<void>;
}

export interface HttpE2BCompatibleSandboxServiceOptions {
  baseUrl: string;
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  resolveCreateBaseUrl?: ((workspace: WorkspaceRecord) => Promise<string | undefined>) | undefined;
}

async function resolveHttpHeaders(
  input: HttpE2BCompatibleSandboxServiceOptions["headers"]
): Promise<Record<string, string> | undefined> {
  if (!input) {
    return undefined;
  }

  return typeof input === "function" ? await input() : input;
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(raw || `Sandbox backend request failed with status ${response.status}.`);
  }

  return JSON.parse(raw) as T;
}

function sandboxErrorHasCode(error: unknown, expectedCode: string): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  try {
    const payload = JSON.parse(error.message) as {
      error?: {
        code?: string | undefined;
      } | undefined;
    };
    return payload.error?.code === expectedCode;
  } catch {
    return false;
  }
}

function parseSandboxHttpBaseUrl(input: string): { baseUrl: string; routePrefix: "/api/v1" | "/internal/v1" | "" } {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed);
    const routePrefix = url.pathname.endsWith("/internal/v1")
      ? "/internal/v1"
      : url.pathname.endsWith("/api/v1")
        ? "/api/v1"
        : "";
    const normalizedPath = routePrefix ? url.pathname.slice(0, -routePrefix.length).replace(/\/+$/u, "") : url.pathname.replace(/\/+$/u, "");
    return {
      baseUrl: `${url.origin}${normalizedPath}`,
      routePrefix
    };
  } catch {
    const routePrefix = trimmed.endsWith("/internal/v1")
      ? "/internal/v1"
      : trimmed.endsWith("/api/v1")
        ? "/api/v1"
        : "";
    return {
      baseUrl: routePrefix ? trimmed.slice(0, -routePrefix.length).replace(/\/+$/u, "") : trimmed.replace(/\/+$/u, ""),
      routePrefix
    };
  }
}

function normalizeHttpSandboxPath(rootPath: string, targetPath: string): string {
  const normalizedRoot = path.posix.normalize(rootPath);
  const normalizedTarget = path.posix.normalize(targetPath);
  if (normalizedTarget === normalizedRoot) {
    return normalizedRoot;
  }

  if (normalizedTarget.startsWith(`${normalizedRoot}/`)) {
    return normalizedTarget;
  }

  return path.posix.join(normalizedRoot, normalizedTarget.replace(/^\/+/u, ""));
}

export function createHttpE2BCompatibleSandboxService(
  options: HttpE2BCompatibleSandboxServiceOptions
): E2BCompatibleSandboxService {
  const clientBySandboxId = new Map<string, ReturnType<typeof createSandboxHttpClient>>();

  const createClient = (inputBaseUrl: string) => {
    const { baseUrl, routePrefix } = parseSandboxHttpBaseUrl(inputBaseUrl);
    const mapRequestPath = (requestPath: string) =>
      routePrefix ? requestPath.replace(/^\/api\/v1(?=\/|$)/u, routePrefix) : requestPath;

    const transport: SandboxHttpTransport = {
      async requestJson<T>(requestPath: string, init?: RequestInit) {
        const headers = new Headers(await resolveHttpHeaders(options.headers));
        const inputHeaders = new Headers(init?.headers);
        for (const [name, value] of inputHeaders.entries()) {
          headers.set(name, value);
        }

        const response = await fetch(`${baseUrl}${mapRequestPath(requestPath)}`, {
          ...init,
          headers
        });
        return readJsonResponse<T>(response);
      },
      async requestBytes(requestPath: string, init?: RequestInit) {
        const headers = new Headers(await resolveHttpHeaders(options.headers));
        const inputHeaders = new Headers(init?.headers);
        for (const [name, value] of inputHeaders.entries()) {
          headers.set(name, value);
        }

        const response = await fetch(`${baseUrl}${mapRequestPath(requestPath)}`, {
          ...init,
          headers
        });
        if (!response.ok) {
          throw new Error((await response.text()) || `Sandbox backend request failed with status ${response.status}.`);
        }

        return new Uint8Array(await response.arrayBuffer());
      }
    };

    return createSandboxHttpClient(transport);
  };

  const defaultClient = createClient(options.baseUrl);
  const clientForSandbox = (sandboxId: string) => clientBySandboxId.get(sandboxId) ?? defaultClient;

  async function resolveSandboxForWorkspace(workspace: WorkspaceRecord) {
    const targetBaseUrl = (await options.resolveCreateBaseUrl?.(workspace)) ?? options.baseUrl;
    const createClientForWorkspace =
      targetBaseUrl.trim() === options.baseUrl.trim() ? defaultClient : createClient(targetBaseUrl);
    const sandbox = await createClientForWorkspace.createSandbox({
      workspaceId: workspace.id,
      ...(workspace.name ? { name: workspace.name } : {}),
      ...(workspace.runtime ? { runtime: workspace.runtime } : {}),
      ...(workspace.externalRef ? { externalRef: workspace.externalRef } : {}),
      ...(workspace.ownerId ? { ownerId: workspace.ownerId } : {}),
      ...(workspace.serviceName ? { serviceName: workspace.serviceName } : {}),
      executionPolicy: workspace.executionPolicy
    });
    if (sandbox.ownerBaseUrl?.trim()) {
      clientBySandboxId.set(sandbox.id, createClient(sandbox.ownerBaseUrl));
    }
    return sandbox;
  }

  async function ensureWorkspaceRoot(sandboxId: string, rootPath: string) {
    const client = clientForSandbox(sandboxId);

    try {
      await client.getFileStat(sandboxId, {
        path: rootPath
      });
      return;
    } catch (error) {
      if (
        !sandboxErrorHasCode(error, "workspace_not_found") &&
        !sandboxErrorHasCode(error, "workspace_entry_not_found") &&
        !sandboxErrorHasCode(error, "workspace_directory_not_found")
      ) {
        throw error;
      }
    }

    try {
      await client.createDirectory(sandboxId, {
        path: rootPath,
        createParents: true
      });
      return;
    } catch (error) {
      if (!sandboxErrorHasCode(error, "workspace_root_mutation_not_allowed")) {
        throw error;
      }
    }

    await client.createDirectory(sandboxId, {
      path: path.posix.join(rootPath, ".openharness"),
      createParents: true
    });
  }

  function relativeToSandboxRoot(rootPath: string, targetPath: string) {
    return normalizeHttpSandboxPath(rootPath, targetPath);
  }

  return {
    async acquireExecution(input) {
      const sandbox = await resolveSandboxForWorkspace(input.workspace);
      await ensureWorkspaceRoot(sandbox.id, sandbox.rootPath);
      return {
        sandboxId: sandbox.id,
        rootPath: sandbox.rootPath,
        async release() {
          return undefined;
        }
      };
    },
    async acquireFileAccess(input) {
      const sandbox = await resolveSandboxForWorkspace(input.workspace);
      await ensureWorkspaceRoot(sandbox.id, sandbox.rootPath);
      return {
        sandboxId: sandbox.id,
        rootPath: sandbox.rootPath,
        async release() {
          return undefined;
        }
      };
    },
    async runCommand(input) {
      return clientForSandbox(input.sandboxId).runForegroundCommand(input.sandboxId, {
        command: input.command,
        ...(input.cwd ? { cwd: relativeToSandboxRoot(input.rootPath, input.cwd) } : {}),
        ...(input.env ? { env: input.env } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.stdinText !== undefined ? { stdinText: input.stdinText } : {})
      });
    },
    async runProcess(input) {
      return clientForSandbox(input.sandboxId).runProcessCommand(input.sandboxId, {
        executable: input.executable,
        args: input.args,
        ...(input.cwd ? { cwd: relativeToSandboxRoot(input.rootPath, input.cwd) } : {}),
        ...(input.env ? { env: input.env } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.stdinText !== undefined ? { stdinText: input.stdinText } : {})
      });
    },
    async runBackground(input) {
      return clientForSandbox(input.sandboxId).runBackgroundCommand(input.sandboxId, {
        command: input.command,
        sessionId: input.sessionId,
        ...(input.description ? { description: input.description } : {}),
        ...(input.cwd ? { cwd: relativeToSandboxRoot(input.rootPath, input.cwd) } : {}),
        ...(input.env ? { env: input.env } : {})
      });
    },
    async stat(input) {
      return clientForSandbox(input.sandboxId).getFileStat(input.sandboxId, {
        path: input.path
      });
    },
    async readFile(input) {
      return Buffer.from(
        await clientForSandbox(input.sandboxId).downloadFile(input.sandboxId, {
          path: input.path
        })
      );
    },
    async readdir(input) {
      const items = [];
      let cursor: string | undefined;

      do {
        const page = await clientForSandbox(input.sandboxId).listEntries(input.sandboxId, {
          path: input.path,
          pageSize: SANDBOX_LIST_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
          sortBy: "name",
          sortOrder: "asc"
        });
        items.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);

      return items.map((entry) => ({
        name: path.posix.basename(entry.path),
        kind: entry.type,
        ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
        ...(entry.sizeBytes !== undefined ? { sizeBytes: entry.sizeBytes } : {})
      }));
    },
    async mkdir(input) {
      await clientForSandbox(input.sandboxId).createDirectory(input.sandboxId, {
        path: input.path,
        createParents: input.recursive ?? true
      });
    },
    async writeFile(input) {
      await clientForSandbox(input.sandboxId).uploadFile(input.sandboxId, {
        path: input.path,
        overwrite: true,
        data: input.data,
        contentType: "application/octet-stream",
        ...(typeof input.mtimeMs === "number" ? { mtimeMs: input.mtimeMs } : {})
      });
    },
    async rm(input) {
      await clientForSandbox(input.sandboxId).deleteEntry(input.sandboxId, {
        path: input.path,
        recursive: input.recursive ?? false
      });
    },
    async rename(input) {
      await clientForSandbox(input.sandboxId).moveEntry(input.sandboxId, {
        sourcePath: input.sourcePath,
        targetPath: input.targetPath,
        overwrite: true
      });
    },
    async realpath(input) {
      return normalizeHttpSandboxPath(SANDBOX_ROOT_PATH, input.path);
    },
    diagnostics() {
      return {
        transport: "http"
      };
    },
    async close() {
      return undefined;
    }
  };
}

function toVirtualWorkspaceRoot(lease: E2BCompatibleSandboxLease): string {
  const normalizedRoot = lease.rootPath.startsWith("/")
    ? path.posix.normalize(lease.rootPath)
    : path.posix.join("/", lease.rootPath);
  return path.posix.join(VIRTUAL_SANDBOX_ROOT, encodeURIComponent(lease.sandboxId), normalizedRoot);
}

function parseVirtualSandboxPath(targetPath: string): { sandboxId: string; remotePath: string } {
  const normalized = path.posix.normalize(targetPath);
  if (!normalized.startsWith(`${VIRTUAL_SANDBOX_ROOT}/`)) {
    throw new Error(`Path ${targetPath} is not an E2B-compatible sandbox path.`);
  }

  const parts = normalized.split("/").filter((part) => part.length > 0);
  const encodedSandboxId = parts[1];
  if (!encodedSandboxId) {
    throw new Error(`Path ${targetPath} is missing a sandbox id.`);
  }

  return {
    sandboxId: decodeURIComponent(encodedSandboxId),
    remotePath: `/${parts.slice(2).join("/")}`
  };
}

function decodeWorkspaceContext(workspace: WorkspaceRecord, cwd?: string | undefined) {
  const root = parseVirtualSandboxPath(workspace.rootPath);
  const currentPath = cwd ? parseVirtualSandboxPath(cwd) : root;
  if (currentPath.sandboxId !== root.sandboxId) {
    throw new Error(`Path ${cwd} does not belong to sandbox ${root.sandboxId}.`);
  }

  return {
    sandboxId: root.sandboxId,
    rootPath: root.remotePath,
    cwd: currentPath.remotePath
  };
}

function createE2BCompatibleWorkspaceCommandExecutor(service: E2BCompatibleSandboxService): WorkspaceCommandExecutor {
  return {
    async runForeground(input) {
      const context = decodeWorkspaceContext(input.workspace, input.cwd);
      return service.runCommand({
        ...context,
        command: input.command,
        ...(input.env ? { env: input.env } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.stdinText !== undefined ? { stdinText: input.stdinText } : {}),
        ...(input.signal ? { signal: input.signal } : {})
      });
    },
    async runProcess(input) {
      const context = decodeWorkspaceContext(input.workspace, input.cwd);
      return service.runProcess({
        ...context,
        executable: input.executable,
        args: input.args,
        ...(input.env ? { env: input.env } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.stdinText !== undefined ? { stdinText: input.stdinText } : {}),
        ...(input.signal ? { signal: input.signal } : {})
      });
    },
    async runBackground(input) {
      const context = decodeWorkspaceContext(input.workspace, input.cwd);
      return service.runBackground({
        ...context,
        command: input.command,
        sessionId: input.sessionId,
        ...(input.description ? { description: input.description } : {}),
        ...(input.env ? { env: input.env } : {})
      });
    }
  };
}

function createE2BCompatibleWorkspaceFileSystem(service: E2BCompatibleSandboxService): WorkspaceFileSystem {
  return {
    async realpath(targetPath) {
      const parsed = parseVirtualSandboxPath(targetPath);
      if (service.realpath) {
        const resolved = await service.realpath({
          sandboxId: parsed.sandboxId,
          path: parsed.remotePath
        });
        return path.posix.join(VIRTUAL_SANDBOX_ROOT, encodeURIComponent(parsed.sandboxId), resolved);
      }

      return targetPath;
    },
    async stat(targetPath) {
      const parsed = parseVirtualSandboxPath(targetPath);
      return service.stat({
        sandboxId: parsed.sandboxId,
        path: parsed.remotePath
      });
    },
    async readFile(targetPath) {
      const parsed = parseVirtualSandboxPath(targetPath);
      return service.readFile({
        sandboxId: parsed.sandboxId,
        path: parsed.remotePath
      });
    },
    openReadStream(targetPath) {
      const parsed = parseVirtualSandboxPath(targetPath);
      if (service.openReadStream) {
        return service.openReadStream({
          sandboxId: parsed.sandboxId,
          path: parsed.remotePath
        });
      }

      return Readable.from(
        (async function* () {
          yield await service.readFile({
            sandboxId: parsed.sandboxId,
            path: parsed.remotePath
          });
        })()
      );
    },
    async readdir(targetPath) {
      const parsed = parseVirtualSandboxPath(targetPath);
      return service.readdir({
        sandboxId: parsed.sandboxId,
        path: parsed.remotePath
      });
    },
    async mkdir(targetPath, options) {
      const parsed = parseVirtualSandboxPath(targetPath);
      await service.mkdir({
        sandboxId: parsed.sandboxId,
        path: parsed.remotePath,
        recursive: options?.recursive
      });
    },
    async writeFile(targetPath, data, options) {
      const parsed = parseVirtualSandboxPath(targetPath);
      await service.writeFile({
        sandboxId: parsed.sandboxId,
        path: parsed.remotePath,
        data,
        ...(typeof options?.mtimeMs === "number" ? { mtimeMs: options.mtimeMs } : {})
      });
    },
    async rm(targetPath, options) {
      const parsed = parseVirtualSandboxPath(targetPath);
      await service.rm({
        sandboxId: parsed.sandboxId,
        path: parsed.remotePath,
        recursive: options?.recursive,
        force: options?.force
      });
    },
    async rename(sourcePath, targetPath) {
      const source = parseVirtualSandboxPath(sourcePath);
      const target = parseVirtualSandboxPath(targetPath);
      if (source.sandboxId !== target.sandboxId) {
        throw new Error("Cross-sandbox rename is not supported.");
      }

      await service.rename({
        sandboxId: source.sandboxId,
        sourcePath: source.remotePath,
        targetPath: target.remotePath
      });
    }
  };
}

export function createE2BCompatibleSandboxHost(options: {
  service: E2BCompatibleSandboxService;
  diagnostics?: Record<string, unknown> | undefined;
  providerKind?: "self_hosted" | "e2b" | undefined;
}): SandboxHost {
  const workspaceCommandExecutor = createE2BCompatibleWorkspaceCommandExecutor(options.service);
  const workspaceFileSystem = createE2BCompatibleWorkspaceFileSystem(options.service);
  const workspaceExecutionProvider: WorkspaceExecutionProvider = {
    async acquire(input) {
      const lease = await options.service.acquireExecution(input);
      return {
        workspace: {
          ...input.workspace,
          rootPath: toVirtualWorkspaceRoot(lease)
        },
        async release(releaseOptions?: { dirty?: boolean | undefined }) {
          await lease.release(releaseOptions);
        }
      } satisfies WorkspaceExecutionLease;
    }
  };
  const workspaceFileAccessProvider: WorkspaceFileAccessProvider = {
    async acquire(input) {
      const lease = await options.service.acquireFileAccess(input);
      return {
        workspace: {
          ...input.workspace,
          rootPath: toVirtualWorkspaceRoot(lease)
        },
        async release(releaseOptions?: { dirty?: boolean | undefined }) {
          await lease.release(releaseOptions);
        }
      } satisfies WorkspaceFileAccessLease;
    }
  };

  return {
    providerKind: options.providerKind ?? "e2b",
    workspaceCommandExecutor,
    workspaceFileSystem,
    workspaceExecutionProvider,
    workspaceFileAccessProvider,
    diagnostics() {
      return {
        executionModel: "sandbox_hosted",
        workerPlacement: "inside_sandbox",
        ...(options.diagnostics ?? {}),
        ...(options.service.diagnostics ? options.service.diagnostics() : {})
      };
    },
    async maintain({ idleBefore }) {
      await options.service.maintain?.({ idleBefore });
    },
    async beginDrain() {
      await options.service.beginDrain?.();
    },
    async close() {
      await options.service.close();
    }
  };
}
