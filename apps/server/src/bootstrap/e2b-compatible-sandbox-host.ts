import path from "node:path";
import { Readable } from "node:stream";

import {
  sandboxBackgroundCommandResultSchema,
  sandboxCommandResultSchema,
  sandboxFileStatSchema,
  sandboxSchema,
  workspaceEntryPageSchema
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
} from "@oah/runtime-core";

import type { SandboxHost } from "./sandbox-host.js";

const VIRTUAL_SANDBOX_ROOT = "/__oah_sandbox__";

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
  writeFile(input: { sandboxId: string; path: string; data: Buffer }): Promise<void>;
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
  const baseUrl = options.baseUrl.replace(/\/+$/u, "");

  async function requestJson<T>(input: {
    path: string;
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    query?: URLSearchParams | undefined;
    body?: unknown;
  }): Promise<T> {
    const headers = new Headers(await resolveHttpHeaders(options.headers));
    if (input.body !== undefined) {
      headers.set("content-type", "application/json");
    }

    const querySuffix = input.query && Array.from(input.query.keys()).length > 0 ? `?${input.query.toString()}` : "";
    const response = await fetch(`${baseUrl}${input.path}${querySuffix}`, {
      method: input.method ?? "GET",
      headers,
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {})
    });
    return readJsonResponse<T>(response);
  }

  async function requestBytes(input: { path: string; query: URLSearchParams }): Promise<Buffer> {
    const resolvedHeaders = await resolveHttpHeaders(options.headers);
    const response = await fetch(`${baseUrl}${input.path}?${input.query.toString()}`, {
      method: "GET",
      ...(resolvedHeaders ? { headers: resolvedHeaders } : {})
    });
    if (!response.ok) {
      throw new Error((await response.text()) || `Sandbox backend request failed with status ${response.status}.`);
    }

    return Buffer.from(await response.arrayBuffer());
  }

  async function loadSandbox(sandboxId: string) {
    return sandboxSchema.parse(await requestJson<unknown>({ path: `/sandboxes/${encodeURIComponent(sandboxId)}` }));
  }

  function relativeToSandboxRoot(rootPath: string, targetPath: string) {
    return normalizeHttpSandboxPath(rootPath, targetPath);
  }

  return {
    async acquireExecution(input) {
      const sandbox = await loadSandbox(input.workspace.id);
      return {
        sandboxId: sandbox.id,
        rootPath: sandbox.rootPath,
        async release() {
          return undefined;
        }
      };
    },
    async acquireFileAccess(input) {
      const sandbox = await loadSandbox(input.workspace.id);
      return {
        sandboxId: sandbox.id,
        rootPath: sandbox.rootPath,
        async release() {
          return undefined;
        }
      };
    },
    async runCommand(input) {
      return sandboxCommandResultSchema.parse(
        await requestJson<unknown>({
          path: `/sandboxes/${encodeURIComponent(input.sandboxId)}/commands/foreground`,
          method: "POST",
          body: {
            command: input.command,
            ...(input.cwd ? { cwd: relativeToSandboxRoot(input.rootPath, input.cwd) } : {}),
            ...(input.env ? { env: input.env } : {}),
            ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
            ...(input.stdinText !== undefined ? { stdinText: input.stdinText } : {})
          }
        })
      );
    },
    async runProcess(input) {
      return sandboxCommandResultSchema.parse(
        await requestJson<unknown>({
          path: `/sandboxes/${encodeURIComponent(input.sandboxId)}/commands/process`,
          method: "POST",
          body: {
            executable: input.executable,
            args: input.args,
            ...(input.cwd ? { cwd: relativeToSandboxRoot(input.rootPath, input.cwd) } : {}),
            ...(input.env ? { env: input.env } : {}),
            ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
            ...(input.stdinText !== undefined ? { stdinText: input.stdinText } : {})
          }
        })
      );
    },
    async runBackground(input) {
      return sandboxBackgroundCommandResultSchema.parse(
        await requestJson<unknown>({
          path: `/sandboxes/${encodeURIComponent(input.sandboxId)}/commands/background`,
          method: "POST",
          body: {
            command: input.command,
            sessionId: input.sessionId,
            ...(input.description ? { description: input.description } : {}),
            ...(input.cwd ? { cwd: relativeToSandboxRoot(input.rootPath, input.cwd) } : {}),
            ...(input.env ? { env: input.env } : {})
          }
        })
      );
    },
    async stat(input) {
      const query = new URLSearchParams({
        path: input.path
      });
      return sandboxFileStatSchema.parse(
        await requestJson<unknown>({
          path: `/sandboxes/${encodeURIComponent(input.sandboxId)}/files/stat`,
          query
        })
      );
    },
    async readFile(input) {
      const query = new URLSearchParams({
        path: input.path
      });
      return requestBytes({
        path: `/sandboxes/${encodeURIComponent(input.sandboxId)}/files/download`,
        query
      });
    },
    async readdir(input) {
      const query = new URLSearchParams({
        path: input.path,
        pageSize: "1000",
        sortBy: "name",
        sortOrder: "asc"
      });
      const page = workspaceEntryPageSchema.parse(
        await requestJson<unknown>({
          path: `/sandboxes/${encodeURIComponent(input.sandboxId)}/files/entries`,
          query
        })
      );
      return page.items.map((entry) => ({
        name: path.posix.basename(entry.path),
        kind: entry.type,
        ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
        ...(entry.sizeBytes !== undefined ? { sizeBytes: entry.sizeBytes } : {})
      }));
    },
    async mkdir(input) {
      await requestJson<unknown>({
        path: `/sandboxes/${encodeURIComponent(input.sandboxId)}/directories`,
        method: "POST",
        body: {
          path: input.path,
          createParents: input.recursive ?? true
        }
      });
    },
    async writeFile(input) {
      const headers = new Headers(await resolveHttpHeaders(options.headers));
      headers.set("content-type", "application/octet-stream");
      const query = new URLSearchParams({
        path: input.path,
        overwrite: "true"
      });
      const response = await fetch(`${baseUrl}/sandboxes/${encodeURIComponent(input.sandboxId)}/files/upload?${query.toString()}`, {
        method: "PUT",
        headers,
        body: input.data
      });
      if (!response.ok) {
        throw new Error((await response.text()) || `Sandbox backend request failed with status ${response.status}.`);
      }
    },
    async rm(input) {
      const query = new URLSearchParams({
        path: input.path,
        recursive: String(input.recursive ?? false)
      });
      await requestJson<unknown>({
        path: `/sandboxes/${encodeURIComponent(input.sandboxId)}/files/entry`,
        method: "DELETE",
        query
      });
    },
    async rename(input) {
      await requestJson<unknown>({
        path: `/sandboxes/${encodeURIComponent(input.sandboxId)}/files/move`,
        method: "PATCH",
        body: {
          sourcePath: input.sourcePath,
          targetPath: input.targetPath,
          overwrite: true
        }
      });
    },
    async realpath(input) {
      return normalizeHttpSandboxPath("/workspace", input.path);
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
    async writeFile(targetPath, data) {
      const parsed = parseVirtualSandboxPath(targetPath);
      await service.writeFile({
        sandboxId: parsed.sandboxId,
        path: parsed.remotePath,
        data
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
    providerKind: "e2b_compatible",
    workspaceCommandExecutor,
    workspaceFileSystem,
    workspaceExecutionProvider,
    workspaceFileAccessProvider,
    diagnostics() {
      return {
        ...(options.service.diagnostics ? options.service.diagnostics() : options.diagnostics ?? {})
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
