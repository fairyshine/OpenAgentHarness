import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

import {
  Sandbox as E2BSandbox,
  CommandExitError,
  FileType,
  Template,
  waitForTimeout,
  type BuildInfo,
  type BuildOptions,
  type ConnectionOpts,
  type SandboxConnectOpts,
  type SandboxInfo,
  type SandboxListOpts,
  type SandboxOpts,
  type TemplateClass
} from "e2b";

import type {
  WorkspaceBackgroundCommandExecutionResult,
  WorkspaceFileStat,
  WorkspaceFileSystemEntry,
  WorkspaceForegroundCommandExecutionResult,
  WorkspaceRecord
} from "@oah/engine-core";

import type { E2BCompatibleSandboxLease, E2BCompatibleSandboxService } from "./e2b-compatible-sandbox-host.js";
import { describeSandboxTopology } from "../sandbox-capabilities.js";
import { trimToUndefined } from "./string-utils.js";

const DEFAULT_E2B_TIMEOUT_MS = 300_000;
const DEFAULT_E2B_WORKSPACE_ROOT = "/workspace";
const DEFAULT_E2B_OAH_WORKER_TEMPLATE = "oah-worker";
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
  kill?(sandboxId: string, opts?: ConnectionOpts): Promise<boolean>;
}

interface NativeE2BTemplateSdk {
  exists(name: string, opts?: ConnectionOpts): Promise<boolean>;
  build(template: TemplateClass, name: string, opts?: Omit<BuildOptions, "alias">): Promise<BuildInfo>;
}

export interface NativeE2BSandboxServiceOptions {
  apiKey?: string | undefined;
  apiUrl?: string | undefined;
  domain?: string | undefined;
  headers?: Record<string, string> | undefined;
  ensureTemplate?: boolean | undefined;
  requestTimeoutMs?: number | undefined;
  template?: string | undefined;
  templateSdk?: NativeE2BTemplateSdk | undefined;
  timeoutMs?: number | undefined;
  maxWorkspacesPerSandbox?: number | undefined;
  ownerlessPool?: "shared" | "dedicated" | undefined;
  warmEmptyCount?: number | undefined;
  sdk?: NativeE2BSandboxSdk | undefined;
}

function buildOwnerSandboxGroupKey(workspace: WorkspaceRecord): string | undefined {
  const ownerId = trimToUndefined(workspace.ownerId);
  return ownerId ? `owner:${ownerId}` : undefined;
}

function buildWorkspaceSandboxRoot(workspace: WorkspaceRecord): string {
  return path.posix.join(DEFAULT_E2B_WORKSPACE_ROOT, workspace.id);
}

function findOahWorkerTemplateContextRoot(): string {
  const candidates = [
    trimToUndefined(process.env.OAH_E2B_TEMPLATE_CONTEXT_DIR),
    process.cwd(),
    path.resolve(process.cwd(), ".."),
    path.resolve(process.cwd(), "../.."),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..")
  ].filter((candidate): candidate is string => Boolean(candidate));
  const contextRoot = candidates.find(
    (candidate) =>
      existsSync(path.join(candidate, "package.json")) &&
      existsSync(path.join(candidate, "pnpm-lock.yaml")) &&
      existsSync(path.join(candidate, "apps/server/src/worker.ts")) &&
      existsSync(path.join(candidate, "scripts/build-runtime-bundles.mjs"))
  );
  if (!contextRoot) {
    throw new Error(
      "Unable to find an Open Agent Harness source tree for building the E2B oah-worker template. " +
        "Set OAH_E2B_TEMPLATE_CONTEXT_DIR to the repository root, or pre-create the oah-worker template."
    );
  }

  return contextRoot;
}

function createOahWorkerTemplate(): TemplateClass {
  const contextRoot = findOahWorkerTemplateContextRoot();
  return Template({
    fileContextPath: contextRoot,
    fileIgnorePatterns: [
      ".git",
      ".turbo",
      ".vite",
      "**/.DS_Store",
      "**/node_modules",
      "**/dist",
      "release",
      "tmp",
      ".oah-runtime-bundles"
    ]
  })
    .fromNodeImage("24")
    .setWorkdir("/app")
    .copy(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "tsconfig.base.json"], "/app/")
    .copy("apps/server", "/app/apps/server")
    .copy("apps/worker", "/app/apps/worker")
    .copy("packages", "/app/packages")
    .copy("scripts", "/app/scripts")
    .copy("docs/schemas", "/app/docs/schemas")
    .runCmd("corepack enable", { user: "root" })
    .runCmd("pnpm install --frozen-lockfile")
    .runCmd("node ./scripts/build-runtime-bundles.mjs /opt/oah/runtime-bundles")
    .runCmd("mkdir -p /app/dist /etc/oah /var/lib/oah/workspaces /var/lib/oah/runtimes /var/lib/oah/models /var/lib/oah/tools /var/lib/oah/skills")
    .runCmd("cp -R /opt/oah/runtime-bundles/worker/. /app/dist/")
    .runCmd(
      "printf '%s\\n' '#!/usr/bin/env sh' 'exec node /app/dist/worker.js \"$@\"' > /usr/local/bin/oah-worker && chmod +x /usr/local/bin/oah-worker",
      {
        user: "root"
      }
    )
    .setStartCmd("sh -lc 'if [ -f /etc/oah/server.yaml ]; then oah-worker --config /etc/oah/server.yaml; else sleep infinity; fi'", waitForTimeout(1000));
}

function resolveE2BApiUrl(input: { apiUrl?: string | undefined; domain?: string | undefined }): string | undefined {
  const apiUrl = trimToUndefined(input.apiUrl);
  if (apiUrl) {
    return apiUrl;
  }

  const domain = trimToUndefined(input.domain);
  return domain ? `https://api.${domain}` : undefined;
}

function listedTemplateMatchesName(template: unknown, name: string): boolean {
  if (!template || typeof template !== "object") {
    return false;
  }

  const record = template as Record<string, unknown>;
  if (record.templateID === name || record.name === name) {
    return true;
  }

  for (const key of ["aliases", "names"]) {
    const values = record[key];
    if (Array.isArray(values) && values.some((value) => value === name)) {
      return true;
    }
  }

  return false;
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
  const templateSdk = options.templateSdk ?? Template;
  const sandboxIdsByGroupKey = new Map<string, string>();
  const sandboxesById = new Map<string, NativeE2BSandboxInstance>();
  const ownerlessWorkspaceGroups = new Map<string, string>();
  const ownerlessWorkspaceIdsByGroupKey = new Map<string, Set<string>>();
  const warmOwnerlessGroupKeys = new Set<string>();
  const sandboxCreationByGroupKey = new Map<string, Promise<NativeE2BSandboxInstance>>();
  let warmOwnerlessEnsurePromise: Promise<void> | undefined;

  const connectionOpts: ConnectionOpts = {
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
    ...(options.domain ? { domain: options.domain } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {})
  };
  const sandboxTimeoutMs = options.timeoutMs ?? DEFAULT_E2B_TIMEOUT_MS;
  const templateName = trimToUndefined(options.template) ?? DEFAULT_E2B_OAH_WORKER_TEMPLATE;
  const shouldEnsureTemplate = options.ensureTemplate ?? true;
  const maxWorkspacesPerSandbox = Math.max(1, Math.floor(options.maxWorkspacesPerSandbox ?? 32));
  const ownerlessPool = options.ownerlessPool ?? "shared";
  const warmEmptyCount = Math.max(0, Math.floor(options.warmEmptyCount ?? 0));
  let templateEnsurePromise: Promise<void> | undefined;

  async function templateExistsByListApi(): Promise<boolean | undefined> {
    const apiUrl = resolveE2BApiUrl(options);
    if (!apiUrl) {
      return undefined;
    }

    const response = await fetch(`${apiUrl.replace(/\/+$/u, "")}/templates`, {
      headers: {
        ...(options.apiKey ? { "X-API-KEY": options.apiKey } : {}),
        ...(options.headers ?? {})
      },
      ...(options.requestTimeoutMs !== undefined ? { signal: AbortSignal.timeout(options.requestTimeoutMs) } : {})
    });
    if (!response.ok) {
      return undefined;
    }

    const templates = await response.json();
    return Array.isArray(templates) ? templates.some((template) => listedTemplateMatchesName(template, templateName)) : undefined;
  }

  async function ensureTemplate(): Promise<void> {
    if (!shouldEnsureTemplate) {
      return;
    }

    templateEnsurePromise ??= (async () => {
      const listedExists = await templateExistsByListApi();
      const exists = listedExists ?? (await templateSdk.exists(templateName, connectionOpts));
      if (exists) {
        return;
      }

      await templateSdk.build(createOahWorkerTemplate(), templateName, {
        ...connectionOpts,
        cpuCount: 2,
        memoryMB: 2048
      });
    })();

    return templateEnsurePromise;
  }

  function rememberSandbox(groupKey: string, sandbox: NativeE2BSandboxInstance): NativeE2BSandboxInstance {
    sandboxIdsByGroupKey.set(groupKey, sandbox.sandboxId);
    sandboxesById.set(sandbox.sandboxId, sandbox);
    return sandbox;
  }

  function rememberOwnerlessWorkspace(groupKey: string, workspaceId: string): string {
    warmOwnerlessGroupKeys.delete(groupKey);
    ownerlessWorkspaceGroups.set(workspaceId, groupKey);
    const workspaceIds = ownerlessWorkspaceIdsByGroupKey.get(groupKey) ?? new Set<string>();
    workspaceIds.add(workspaceId);
    ownerlessWorkspaceIdsByGroupKey.set(groupKey, workspaceIds);
    return groupKey;
  }

  function forgetOwnerlessWorkspace(workspaceId: string): string | undefined {
    const groupKey = ownerlessWorkspaceGroups.get(workspaceId);
    if (!groupKey) {
      return undefined;
    }

    ownerlessWorkspaceGroups.delete(workspaceId);
    const workspaceIds = ownerlessWorkspaceIdsByGroupKey.get(groupKey);
    workspaceIds?.delete(workspaceId);
    if (workspaceIds && workspaceIds.size === 0) {
      ownerlessWorkspaceIdsByGroupKey.delete(groupKey);
      if (ownerlessPool === "shared" && isOwnerlessSharedGroupKey(groupKey)) {
        warmOwnerlessGroupKeys.add(groupKey);
      }
    }

    return groupKey;
  }

  async function killRememberedSandbox(groupKey: string): Promise<void> {
    const sandboxId = sandboxIdsByGroupKey.get(groupKey);
    if (!sandboxId) {
      return;
    }

    sandboxIdsByGroupKey.delete(groupKey);
    sandboxesById.delete(sandboxId);
    warmOwnerlessGroupKeys.delete(groupKey);
    ownerlessWorkspaceIdsByGroupKey.delete(groupKey);
    sandboxCreationByGroupKey.delete(groupKey);
    if (sdk.kill) {
      await sdk.kill(sandboxId, connectionOpts);
    }
  }

  function ownerlessSharedGroupOrdinal(groupKey: string): number | undefined {
    if (groupKey === "shared") {
      return 1;
    }

    const match = /^shared:(\d+)$/u.exec(groupKey);
    if (!match) {
      return undefined;
    }

    const value = Number.parseInt(match[1]!, 10);
    return Number.isFinite(value) && value > 1 ? value : undefined;
  }

  function isOwnerlessSharedGroupKey(groupKey: string): boolean {
    return ownerlessSharedGroupOrdinal(groupKey) !== undefined;
  }

  function ownerlessSharedGroupKeyForOrdinal(ordinal: number): string {
    return ordinal <= 1 ? "shared" : `shared:${ordinal}`;
  }

  function allOwnerlessSharedGroupKeys(): string[] {
    return [
      ...new Set([
        ...ownerlessWorkspaceIdsByGroupKey.keys(),
        ...warmOwnerlessGroupKeys,
        ...sandboxCreationByGroupKey.keys(),
        ...sandboxIdsByGroupKey.keys()
      ])
    ].filter(isOwnerlessSharedGroupKey);
  }

  function nextOwnerlessSharedGroupKey(): string {
    const ordinals = allOwnerlessSharedGroupKeys()
      .map((groupKey) => ownerlessSharedGroupOrdinal(groupKey))
      .filter((value): value is number => typeof value === "number");
    const nextOrdinal = ordinals.length === 0 ? 1 : Math.max(...ordinals) + 1;
    return ownerlessSharedGroupKeyForOrdinal(nextOrdinal);
  }

  function resolveOwnerlessSandboxGroupKey(workspace: WorkspaceRecord): string {
    if (ownerlessPool === "dedicated") {
      return rememberOwnerlessWorkspace(`workspace:${workspace.id}`, workspace.id);
    }

    const existingGroupKey = ownerlessWorkspaceGroups.get(workspace.id);
    if (existingGroupKey) {
      return existingGroupKey;
    }

    const existingGroupKeys = [...ownerlessWorkspaceIdsByGroupKey.keys()]
      .filter((groupKey) => (ownerlessWorkspaceIdsByGroupKey.get(groupKey)?.size ?? 0) > 0)
      .sort((left, right) => {
      const leftCount = ownerlessWorkspaceIdsByGroupKey.get(left)?.size ?? 0;
      const rightCount = ownerlessWorkspaceIdsByGroupKey.get(right)?.size ?? 0;
      return leftCount - rightCount || left.localeCompare(right);
    });
    const availableGroupKey = existingGroupKeys.find(
      (groupKey) => (ownerlessWorkspaceIdsByGroupKey.get(groupKey)?.size ?? 0) < maxWorkspacesPerSandbox
    );
    if (availableGroupKey) {
      return rememberOwnerlessWorkspace(availableGroupKey, workspace.id);
    }

    const warmGroupKey = [...new Set([...warmOwnerlessGroupKeys, ...sandboxCreationByGroupKey.keys()])]
      .filter((groupKey) => isOwnerlessSharedGroupKey(groupKey) && (ownerlessWorkspaceIdsByGroupKey.get(groupKey)?.size ?? 0) === 0)
      .sort((left, right) => (ownerlessSharedGroupOrdinal(left) ?? 0) - (ownerlessSharedGroupOrdinal(right) ?? 0))[0];
    return rememberOwnerlessWorkspace(warmGroupKey ?? nextOwnerlessSharedGroupKey(), workspace.id);
  }

  function resolveSandboxGroupKey(workspace: WorkspaceRecord): string {
    return buildOwnerSandboxGroupKey(workspace) ?? resolveOwnerlessSandboxGroupKey(workspace);
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

  async function createSandbox(groupKey: string, workspace?: WorkspaceRecord | undefined): Promise<NativeE2BSandboxInstance> {
    await ensureTemplate();
    const metadata: Record<string, string> = {
      [SANDBOX_GROUP_METADATA_KEY]: groupKey
    };
    const ownerId = workspace ? trimToUndefined(workspace.ownerId) : undefined;
    if (ownerId) {
      metadata[OWNER_METADATA_KEY] = ownerId;
    }

    const sandboxOpts = {
      ...connectionOpts,
      timeoutMs: sandboxTimeoutMs,
      metadata
    };
    const sandbox = await sdk.create(templateName, sandboxOpts);
    return rememberSandbox(groupKey, sandbox);
  }

  async function loadOrCreateSandbox(groupKey: string, workspace?: WorkspaceRecord | undefined): Promise<NativeE2BSandboxInstance> {
    const cachedSandboxId = sandboxIdsByGroupKey.get(groupKey);
    if (cachedSandboxId) {
      try {
        return sandboxesById.get(cachedSandboxId) ?? (await connectSandbox(groupKey, cachedSandboxId));
      } catch {
        sandboxIdsByGroupKey.delete(groupKey);
        sandboxesById.delete(cachedSandboxId);
      }
    }

    const pending = sandboxCreationByGroupKey.get(groupKey);
    if (pending) {
      return pending;
    }

    const created = (async () => (await loadListedSandbox(groupKey)) ?? (await createSandbox(groupKey, workspace)))();
    sandboxCreationByGroupKey.set(groupKey, created);
    try {
      return await created;
    } finally {
      sandboxCreationByGroupKey.delete(groupKey);
    }
  }

  async function ensureWarmOwnerlessSandboxes(): Promise<void> {
    if (warmOwnerlessEnsurePromise) {
      return warmOwnerlessEnsurePromise;
    }

    warmOwnerlessEnsurePromise = ensureWarmOwnerlessSandboxesOnce().finally(() => {
      warmOwnerlessEnsurePromise = undefined;
    });
    return warmOwnerlessEnsurePromise;
  }

  async function ensureWarmOwnerlessSandboxesOnce(): Promise<void> {
    if (ownerlessPool !== "shared" || warmEmptyCount <= 0) {
      return;
    }

    while (warmOwnerlessGroupKeys.size < warmEmptyCount) {
      const groupKey = nextOwnerlessSharedGroupKey();
      await loadOrCreateSandbox(groupKey);
      if ((ownerlessWorkspaceIdsByGroupKey.get(groupKey)?.size ?? 0) === 0) {
        warmOwnerlessGroupKeys.add(groupKey);
      }
    }
  }

  async function resolveSandbox(workspace: WorkspaceRecord): Promise<{ sandbox: NativeE2BSandboxInstance; rootPath: string }> {
    const groupKey = resolveSandboxGroupKey(workspace);
    const sandbox = await loadOrCreateSandbox(groupKey, workspace);
    const rootPath = await ensureWorkspaceRoot(sandbox, workspace);
    if (!buildOwnerSandboxGroupKey(workspace) && ownerlessPool === "shared") {
      void ensureWarmOwnerlessSandboxes().catch(() => undefined);
    }
    return {
      sandbox,
      rootPath
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
      if (typeof input.mtimeMs === "number" && Number.isFinite(input.mtimeMs) && input.mtimeMs > 0) {
        await sandbox.commands.run(
          `touch -m -d ${shellQuote(new Date(input.mtimeMs).toISOString())} -- ${shellQuote(input.path)}`
        );
      }
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
    async deleteWorkspace(workspace): Promise<void> {
      const ownerGroupKey = buildOwnerSandboxGroupKey(workspace);
      if (ownerGroupKey) {
        return;
      }

      const groupKey = forgetOwnerlessWorkspace(workspace.id);
      if (!groupKey) {
        return;
      }

      if (ownerlessPool === "dedicated") {
        await killRememberedSandbox(groupKey);
      } else {
        void ensureWarmOwnerlessSandboxes().catch(() => undefined);
      }
    },
    diagnostics() {
      const topology = describeSandboxTopology("e2b");
      return {
        provider: topology.provider,
        transport: "native_e2b",
        layout: "multi_workspace_sandbox",
        executionModel: topology.executionModel,
        workerPlacement: topology.workerPlacement,
        ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
        ...(options.domain ? { domain: options.domain } : {}),
        template: templateName,
        ensureTemplate: shouldEnsureTemplate,
        timeoutMs: sandboxTimeoutMs,
        warmEmptyCount,
        warmOwnerlessSandboxes: warmOwnerlessGroupKeys.size
      };
    },
    async maintain() {
      await ensureWarmOwnerlessSandboxes();
    },
    async beginDrain() {
      return undefined;
    },
    async close() {
      sandboxesById.clear();
      sandboxIdsByGroupKey.clear();
      warmOwnerlessGroupKeys.clear();
      sandboxCreationByGroupKey.clear();
    }
  };
}
