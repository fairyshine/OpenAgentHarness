import path from "node:path";
import { Readable } from "node:stream";

import {
  Sandbox as E2BSandbox,
  CommandExitError,
  FileType,
  type ConnectionOpts,
  type SandboxConnectOpts,
  type SandboxInfo,
  type SandboxListOpts,
  type SandboxOpts
} from "e2b";

import type {
  WorkspaceBackgroundCommandExecutionResult,
  WorkspaceFileStat,
  WorkspaceFileSystemEntry,
  WorkspaceForegroundCommandExecutionResult,
  WorkspaceRecord
} from "@oah/runtime-core";

import type { E2BCompatibleSandboxLease, E2BCompatibleSandboxService } from "./e2b-compatible-sandbox-host.js";

const DEFAULT_E2B_TIMEOUT_MS = 300_000;
const DEFAULT_E2B_WORKSPACE_ROOT = "/workspace";
const SANDBOX_GROUP_METADATA_KEY = "oahSandboxGroup";
const OWNER_METADATA_KEY = "oahOwnerId";

type NativeE2BSandboxInstance = E2BSandbox;
type NativeE2BFileEntry = Awaited<ReturnType<NativeE2BSandboxInstance["files"]["list"]>>[number];

interface NativeE2BSandboxPaginator {
  hasNext: boolean;
  nextItems(): Promise<SandboxInfo[]>;
}

interface NativeE2BSandboxSdk {
  create(opts?: SandboxOpts): Promise<NativeE2BSandboxInstance>;
  create(template: string, opts?: SandboxOpts): Promise<NativeE2BSandboxInstance>;
  connect(sandboxId: string, opts?: SandboxConnectOpts & { timeoutMs?: number | undefined }): Promise<NativeE2BSandboxInstance>;
  list(opts?: SandboxListOpts): NativeE2BSandboxPaginator;
}

export interface NativeE2BSandboxServiceOptions {
  apiKey?: string | undefined;
  apiUrl?: string | undefined;
  domain?: string | undefined;
  headers?: Record<string, string> | undefined;
  requestTimeoutMs?: number | undefined;
  template?: string | undefined;
  timeoutMs?: number | undefined;
  sdk?: NativeE2BSandboxSdk | undefined;
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function buildSandboxGroupKey(workspace: WorkspaceRecord): string {
  const ownerId = trimToUndefined(workspace.ownerId);
  return ownerId ? `owner:${ownerId}` : "shared";
}

function buildWorkspaceSandboxRoot(workspace: WorkspaceRecord): string {
  return path.posix.join(DEFAULT_E2B_WORKSPACE_ROOT, workspace.id);
}

export function normalizeE2BApiUrl(baseUrl: string | undefined): string | undefined {
  const trimmed = trimToUndefined(baseUrl);
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = new URL(trimmed);
    parsed.pathname = parsed.pathname.replace(/\/internal\/v1\/?$/u, "").replace(/\/+$/u, "");
    return parsed.toString().replace(/\/+$/u, "");
  } catch {
    return trimmed.replace(/\/internal\/v1\/?$/u, "").replace(/\/+$/u, "");
  }
}

function toArrayBuffer(data: Buffer): ArrayBuffer {
  const bytes = new Uint8Array(data.byteLength);
  bytes.set(data);
  return bytes.buffer;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function buildShellCommand(command: string, stdinText?: string): string {
  if (stdinText === undefined) {
    return command;
  }

  const sentinel = `__OAH_STDIN_${Math.random().toString(36).slice(2, 10)}__`;
  return `cat <<'${sentinel}' | (${command})
${stdinText}
${sentinel}`;
}

function buildProcessCommand(executable: string, args: string[], stdinText?: string): string {
  const command = [executable, ...args].map((segment) => shellQuote(segment)).join(" ");
  return buildShellCommand(command, stdinText);
}

function buildBackgroundOutputPaths(rootPath: string, sessionId: string): { directory: string; taskId: string; outputPath: string } {
  const taskId = `task-e2b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const directory = path.posix.join(rootPath, ".openharness", "state", "background", sessionId);
  const outputPath = path.posix.join(directory, `${taskId}.log`);
  return { directory, taskId, outputPath };
}

function toWorkspaceEntryKind(type: FileType | undefined): "file" | "directory" {
  return type === FileType.DIR ? "directory" : "file";
}

function toWorkspaceFileStat(entry: Awaited<ReturnType<NativeE2BSandboxInstance["files"]["getInfo"]>>): WorkspaceFileStat {
  const modifiedTimeMs = entry.modifiedTime?.getTime() ?? 0;
  return {
    kind: toWorkspaceEntryKind(entry.type),
    size: entry.size,
    mtimeMs: modifiedTimeMs,
    birthtimeMs: modifiedTimeMs
  };
}

function toWorkspaceFileEntries(
  entries: Awaited<ReturnType<NativeE2BSandboxInstance["files"]["list"]>>
): WorkspaceFileSystemEntry[] {
  return entries.map((entry: NativeE2BFileEntry) => ({
    name: entry.name,
    kind: toWorkspaceEntryKind(entry.type),
    ...(entry.modifiedTime ? { updatedAt: entry.modifiedTime.toISOString() } : {}),
    ...(entry.type === FileType.FILE ? { sizeBytes: entry.size } : {})
  }));
}

function toCommandResult(
  result:
    | WorkspaceForegroundCommandExecutionResult
    | Pick<CommandExitError, "stdout" | "stderr" | "exitCode">
): WorkspaceForegroundCommandExecutionResult {
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode
  };
}

export function createNativeE2BSandboxService(options: NativeE2BSandboxServiceOptions): E2BCompatibleSandboxService {
  const sdk = options.sdk ?? (E2BSandbox as unknown as NativeE2BSandboxSdk);
  const sandboxIdsByGroupKey = new Map<string, string>();
  const sandboxesById = new Map<string, NativeE2BSandboxInstance>();

  const connectionOpts: ConnectionOpts = {
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
    ...(options.domain ? { domain: options.domain } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {})
  };
  const sandboxTimeoutMs = options.timeoutMs ?? DEFAULT_E2B_TIMEOUT_MS;

  function rememberSandbox(groupKey: string, sandbox: NativeE2BSandboxInstance): NativeE2BSandboxInstance {
    sandboxIdsByGroupKey.set(groupKey, sandbox.sandboxId);
    sandboxesById.set(sandbox.sandboxId, sandbox);
    return sandbox;
  }

  async function connectSandbox(groupKey: string, sandboxId: string): Promise<NativeE2BSandboxInstance> {
    return rememberSandbox(
      groupKey,
      await sdk.connect(sandboxId, {
        ...connectionOpts,
        timeoutMs: sandboxTimeoutMs
      })
    );
  }

  async function ensureWorkspaceRoot(sandbox: NativeE2BSandboxInstance, workspace: WorkspaceRecord): Promise<string> {
    const workspaceRoot = buildWorkspaceSandboxRoot(workspace);
    await sandbox.files.makeDir(DEFAULT_E2B_WORKSPACE_ROOT);
    await sandbox.files.makeDir(workspaceRoot);
    return workspaceRoot;
  }

  async function loadListedSandbox(groupKey: string): Promise<NativeE2BSandboxInstance | undefined> {
    const paginator = sdk.list({
      ...connectionOpts,
      limit: 1,
      query: {
        metadata: {
          [SANDBOX_GROUP_METADATA_KEY]: groupKey
        },
        state: ["running", "paused"]
      }
    });
    const items = paginator.hasNext ? await paginator.nextItems() : [];
    const listed = items[0];
    if (!listed) {
      return undefined;
    }

    return connectSandbox(groupKey, listed.sandboxId);
  }

  async function createSandbox(groupKey: string, workspace: WorkspaceRecord): Promise<NativeE2BSandboxInstance> {
    const metadata: Record<string, string> = {
      [SANDBOX_GROUP_METADATA_KEY]: groupKey
    };
    const ownerId = trimToUndefined(workspace.ownerId);
    if (ownerId) {
      metadata[OWNER_METADATA_KEY] = ownerId;
    }

    const sandboxOpts = {
      ...connectionOpts,
      timeoutMs: sandboxTimeoutMs,
      metadata
    };
    const sandbox = options.template
      ? await sdk.create(options.template, sandboxOpts)
      : await sdk.create(sandboxOpts);
    return rememberSandbox(groupKey, sandbox);
  }

  async function resolveSandbox(workspace: WorkspaceRecord): Promise<{ sandbox: NativeE2BSandboxInstance; rootPath: string }> {
    const groupKey = buildSandboxGroupKey(workspace);
    const cachedSandboxId = sandboxIdsByGroupKey.get(groupKey);
    if (cachedSandboxId) {
      try {
        const cachedSandbox = sandboxesById.get(cachedSandboxId) ?? (await connectSandbox(groupKey, cachedSandboxId));
        return {
          sandbox: cachedSandbox,
          rootPath: await ensureWorkspaceRoot(cachedSandbox, workspace)
        };
      } catch {
        sandboxIdsByGroupKey.delete(groupKey);
        sandboxesById.delete(cachedSandboxId);
      }
    }

    const sandbox = (await loadListedSandbox(groupKey)) ?? (await createSandbox(groupKey, workspace));
    return {
      sandbox,
      rootPath: await ensureWorkspaceRoot(sandbox, workspace)
    };
  }

  function getConnectedSandbox(sandboxId: string): NativeE2BSandboxInstance {
    const sandbox = sandboxesById.get(sandboxId);
    if (!sandbox) {
      throw new Error(`Sandbox ${sandboxId} is not connected.`);
    }

    return sandbox;
  }

  return {
    async acquireExecution(input): Promise<E2BCompatibleSandboxLease> {
      const { sandbox, rootPath } = await resolveSandbox(input.workspace);
      return {
        sandboxId: sandbox.sandboxId,
        rootPath,
        async release() {
          return undefined;
        }
      };
    },
    async acquireFileAccess(input): Promise<E2BCompatibleSandboxLease> {
      const { sandbox, rootPath } = await resolveSandbox(input.workspace);
      return {
        sandboxId: sandbox.sandboxId,
        rootPath,
        async release() {
          return undefined;
        }
      };
    },
    async runCommand(input): Promise<WorkspaceForegroundCommandExecutionResult> {
      const sandbox = getConnectedSandbox(input.sandboxId);
      try {
        return toCommandResult(
          await sandbox.commands.run(buildShellCommand(input.command, input.stdinText), {
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(input.env ? { envs: input.env } : {}),
            ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {})
          })
        );
      } catch (error) {
        if (error instanceof CommandExitError) {
          return toCommandResult(error);
        }

        throw error;
      }
    },
    async runProcess(input): Promise<WorkspaceForegroundCommandExecutionResult> {
      const sandbox = getConnectedSandbox(input.sandboxId);
      try {
        return toCommandResult(
          await sandbox.commands.run(buildProcessCommand(input.executable, input.args, input.stdinText), {
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(input.env ? { envs: input.env } : {}),
            ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {})
          })
        );
      } catch (error) {
        if (error instanceof CommandExitError) {
          return toCommandResult(error);
        }

        throw error;
      }
    },
    async runBackground(input): Promise<WorkspaceBackgroundCommandExecutionResult> {
      const sandbox = getConnectedSandbox(input.sandboxId);
      const { directory, taskId, outputPath } = buildBackgroundOutputPaths(input.rootPath, input.sessionId);
      const handle = await sandbox.commands.run(
        `sh -lc ${shellQuote(`mkdir -p ${shellQuote(directory)} && (${input.command}) >> ${shellQuote(outputPath)} 2>&1`)}`,
        {
          background: true,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.env ? { envs: input.env } : {})
        }
      );

      return {
        outputPath,
        taskId,
        pid: handle.pid
      };
    },
    async stat(input): Promise<WorkspaceFileStat> {
      const sandbox = getConnectedSandbox(input.sandboxId);
      return toWorkspaceFileStat(await sandbox.files.getInfo(input.path));
    },
    async readFile(input): Promise<Buffer> {
      const sandbox = getConnectedSandbox(input.sandboxId);
      return Buffer.from(await sandbox.files.read(input.path, { format: "bytes" }));
    },
    openReadStream(input): Readable {
      const sandbox = getConnectedSandbox(input.sandboxId);
      return Readable.from(
        (async function* () {
          const webStream = await sandbox.files.read(input.path, { format: "stream" });
          const reader = webStream.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }

              if (value) {
                yield value;
              }
            }
          } finally {
            reader.releaseLock();
          }
        })()
      );
    },
    async readdir(input): Promise<WorkspaceFileSystemEntry[]> {
      const sandbox = getConnectedSandbox(input.sandboxId);
      return toWorkspaceFileEntries(await sandbox.files.list(input.path));
    },
    async mkdir(input): Promise<void> {
      const sandbox = getConnectedSandbox(input.sandboxId);
      await sandbox.files.makeDir(input.path);
    },
    async writeFile(input): Promise<void> {
      const sandbox = getConnectedSandbox(input.sandboxId);
      await sandbox.files.write(input.path, toArrayBuffer(input.data));
    },
    async rm(input): Promise<void> {
      const sandbox = getConnectedSandbox(input.sandboxId);
      if (input.recursive) {
        await sandbox.commands.run(`rm -rf -- ${shellQuote(input.path)}`);
        return;
      }

      await sandbox.files.remove(input.path);
    },
    async rename(input): Promise<void> {
      const sandbox = getConnectedSandbox(input.sandboxId);
      await sandbox.files.rename(input.sourcePath, input.targetPath);
    },
    async realpath(input): Promise<string> {
      return path.posix.normalize(input.path);
    },
    diagnostics() {
      return {
        provider: "e2b",
        transport: "native_e2b",
        layout: "multi_workspace_sandbox",
        executionModel: "sandbox_hosted",
        workerPlacement: "inside_sandbox",
        ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
        ...(options.domain ? { domain: options.domain } : {}),
        ...(options.template ? { template: options.template } : {}),
        timeoutMs: sandboxTimeoutMs
      };
    },
    async maintain() {
      return undefined;
    },
    async beginDrain() {
      return undefined;
    },
    async close() {
      sandboxesById.clear();
      sandboxIdsByGroupKey.clear();
    }
  };
}
