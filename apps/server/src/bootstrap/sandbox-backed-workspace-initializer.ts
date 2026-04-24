import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { sandboxSchema, type CreateWorkspaceRequest } from "@oah/api-contracts";
import { discoverWorkspace, initializeWorkspaceFromRuntime, type DiscoveredAgent, type PlatformModelRegistry } from "@oah/config";
import { createId, type WorkspaceInitializationResult } from "@oah/engine-core";
import * as nativeBridge from "@oah/native-bridge";

import {
  observeNativeWorkspaceSyncOperation,
  recordNativeWorkspaceSyncFallback
} from "../observability/native-workspace-sync.js";
import type { SandboxHost } from "./sandbox-host.js";
import { enrichWorkspaceModelsWithDiscoveredMetadata } from "./model-metadata-discovery.js";

const SANDBOX_WORKSPACE_ROOT = "/workspace";
const DEFAULT_SEED_UPLOAD_CONCURRENCY = 8;
const preparedSeedCache = new Map<string, Promise<{ preparedWorkspaceRoot: string; discovered: WorkspaceInitializationResult }>>();

export const nativeWorkspaceSyncAdapter = {
  isEnabled: nativeBridge.isNativeWorkspaceSyncEnabled,
  computeDirectoryFingerprint: nativeBridge.computeNativeDirectoryFingerprint,
  planSeedUpload: nativeBridge.planNativeSeedUpload,
  syncLocalToSandboxHttp: nativeBridge.syncNativeLocalToSandboxHttp
};

function resolveSeedUploadConcurrency(): number {
  const raw = process.env.OAH_SANDBOX_SEED_UPLOAD_CONCURRENCY;
  if (!raw || raw.trim().length === 0) {
    return DEFAULT_SEED_UPLOAD_CONCURRENCY;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SEED_UPLOAD_CONCURRENCY;
}

async function collectDirectoryFingerprint(rootPath: string): Promise<string> {
  if (nativeWorkspaceSyncAdapter.isEnabled()) {
    try {
      const result = await observeNativeWorkspaceSyncOperation({
        operation: "fingerprint",
        implementation: "rust",
        target: rootPath,
        logFailure: false,
        action: () => nativeWorkspaceSyncAdapter.computeDirectoryFingerprint({ rootDir: rootPath })
      });
      return result.fingerprint;
    } catch (error) {
      recordNativeWorkspaceSyncFallback({
        operation: "fingerprint",
        target: rootPath,
        error
      });
    }
  }

  return observeNativeWorkspaceSyncOperation({
    operation: "fingerprint",
    implementation: "ts",
    target: rootPath,
    logSuccess: false,
    logFailure: false,
    action: async () => {
      const hash = createHash("sha1");
      const visit = async (currentPath: string): Promise<void> => {
        const entries = await readdir(currentPath, { withFileTypes: true }).catch(() => []);
        entries.sort((left, right) => left.name.localeCompare(right.name));

        for (const entry of entries) {
          const absolutePath = path.join(currentPath, entry.name);
          const relativePath = path.relative(rootPath, absolutePath).replaceAll(path.sep, "/");
          const entryStat = await stat(absolutePath).catch(() => null);
          if (!entryStat) {
            continue;
          }

          hash.update(
            `${entry.isDirectory() ? "dir" : "file"}:${relativePath}:${entryStat.size}:${Math.trunc(entryStat.mtimeMs)}\n`
          );
          if (entry.isDirectory()) {
            await visit(absolutePath);
          }
        }
      };

      await visit(rootPath);
      return hash.digest("hex");
    }
  });
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(",")}}`;
}

async function buildPreparedSeedCacheKey(input: {
  runtimeDir: string;
  runtimeName: string;
  platformToolDir: string;
  platformSkillDir: string;
  toolDir: string;
  agentsMd?: string | undefined;
  toolServers?: Record<string, Record<string, unknown>> | undefined;
  skills?: Array<{ name: string; content: string }> | undefined;
}): Promise<string> {
  const runtimeRoot = path.join(input.runtimeDir, input.runtimeName);
  const fingerprintInputs = [
    { key: "runtimeRoot", rootDir: runtimeRoot },
    { key: "platformToolDir", rootDir: input.platformToolDir },
    { key: "platformSkillDir", rootDir: input.platformSkillDir },
    { key: "toolDir", rootDir: input.toolDir }
  ] as const;

  const directoryFingerprints = new Map<string, string>();
  if (nativeWorkspaceSyncAdapter.isEnabled()) {
    try {
      const results = await Promise.all(
        fingerprintInputs.map(async (entry) => {
          const result = await observeNativeWorkspaceSyncOperation({
            operation: "fingerprint",
            implementation: "rust",
            target: entry.rootDir,
            logFailure: false,
            metadata: {
              fingerprintKey: entry.key
            },
            action: () => nativeWorkspaceSyncAdapter.computeDirectoryFingerprint({ rootDir: entry.rootDir })
          });
          return {
            key: entry.key,
            fingerprint: result.fingerprint
          };
        })
      );
      for (const result of results) {
        directoryFingerprints.set(result.key, result.fingerprint);
      }
    } catch (error) {
      recordNativeWorkspaceSyncFallback({
        operation: "fingerprint",
        target: runtimeRoot,
        error,
        metadata: {
          directoryCount: fingerprintInputs.length
        }
      });
    }
  }

  const hash = createHash("sha1");
  hash.update(input.runtimeName);
  hash.update("\n");
  hash.update(directoryFingerprints.get("runtimeRoot") ?? (await collectDirectoryFingerprint(runtimeRoot)));
  hash.update("\n");
  hash.update(directoryFingerprints.get("platformToolDir") ?? (await collectDirectoryFingerprint(input.platformToolDir).catch(() => "")));
  hash.update("\n");
  hash.update(
    directoryFingerprints.get("platformSkillDir") ?? (await collectDirectoryFingerprint(input.platformSkillDir).catch(() => ""))
  );
  hash.update("\n");
  hash.update(directoryFingerprints.get("toolDir") ?? (await collectDirectoryFingerprint(input.toolDir).catch(() => "")));
  hash.update("\n");
  hash.update(input.agentsMd?.trim() ?? "");
  hash.update("\n");
  hash.update(stableJson(input.toolServers ?? {}));
  hash.update("\n");
  hash.update(stableJson(input.skills ?? []));
  return hash.digest("hex");
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  const limit = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) {
          return;
        }
        await worker(items[index]!);
      }
    })
  );
}

async function collectDirectoryUploadPlan(input: {
  currentLocalPath: string;
  currentRemotePath: string;
}): Promise<{
  directories: string[];
  files: Array<{ localPath: string; remotePath: string; mtimeMs?: number | undefined }>;
}> {
  const directories: string[] = [];
  const files: Array<{ localPath: string; remotePath: string; mtimeMs?: number | undefined }> = [];
  const entries = await readdir(input.currentLocalPath, { withFileTypes: true });
  for (const entry of entries) {
    const localPath = path.join(input.currentLocalPath, entry.name);
    const remotePath = path.posix.join(input.currentRemotePath, entry.name);

    if (entry.isDirectory()) {
      directories.push(remotePath);
      const nested = await collectDirectoryUploadPlan({
        ...input,
        currentLocalPath: localPath,
        currentRemotePath: remotePath
      });
      directories.push(...nested.directories);
      files.push(...nested.files);
      continue;
    }

    if (entry.isFile()) {
      files.push({
        localPath,
        remotePath
      });
    }
  }

  return {
    directories,
    files
  };
}

async function collectNativeDirectoryUploadPlan(input: {
  currentLocalPath: string;
  currentRemotePath: string;
}): Promise<{
  directories: string[];
  files: Array<{ localPath: string; remotePath: string; mtimeMs?: number | undefined }>;
} | undefined> {
  if (!nativeWorkspaceSyncAdapter.isEnabled()) {
    return undefined;
  }

  try {
    const result = await observeNativeWorkspaceSyncOperation({
      operation: "plan_seed_upload",
      implementation: "rust",
      target: input.currentLocalPath,
      logFailure: false,
      metadata: {
        remoteRootPath: input.currentRemotePath
      },
      action: () =>
        nativeWorkspaceSyncAdapter.planSeedUpload({
          rootDir: input.currentLocalPath,
          remoteBasePath: input.currentRemotePath
        })
    });
    return {
      directories: result.directories,
      files: result.files.map((file) => ({
        localPath: file.absolutePath,
        remotePath: file.remotePath,
        mtimeMs: file.mtimeMs
      }))
    };
  } catch (error) {
    recordNativeWorkspaceSyncFallback({
      operation: "plan_seed_upload",
      target: input.currentLocalPath,
      error,
      metadata: {
        remoteRootPath: input.currentRemotePath
      }
    });
    return undefined;
  }
}

async function uploadDirectoryTree(input: {
  currentLocalPath: string;
  currentRemotePath: string;
  sandboxHost: SandboxHost;
}): Promise<void> {
  return observeNativeWorkspaceSyncOperation({
    operation: "sync_local_to_sandbox_http",
    implementation: "ts",
    target: input.currentLocalPath,
    logSuccess: false,
    logFailure: false,
    metadata: {
      remoteRootPath: input.currentRemotePath
    },
    action: async () => {
      const plan =
        (await collectNativeDirectoryUploadPlan(input)) ??
        (await observeNativeWorkspaceSyncOperation({
          operation: "plan_seed_upload",
          implementation: "ts",
          target: input.currentLocalPath,
          logSuccess: false,
          logFailure: false,
          metadata: {
            remoteRootPath: input.currentRemotePath
          },
          action: () => collectDirectoryUploadPlan(input)
        }));
      const concurrency = resolveSeedUploadConcurrency();

      await runWithConcurrency(plan.directories, concurrency, async (remotePath) => {
        await input.sandboxHost.workspaceFileSystem.mkdir(remotePath, { recursive: true });
      });

      await runWithConcurrency(plan.files, concurrency, async ({ localPath, remotePath, mtimeMs }) => {
        const data = await readFile(localPath);
        const resolvedMtimeMs =
          typeof mtimeMs === "number" && Number.isFinite(mtimeMs) && mtimeMs > 0
            ? mtimeMs
            : (await stat(localPath)).mtimeMs;
        await input.sandboxHost.workspaceFileSystem.writeFile(remotePath, data, {
          ...(Number.isFinite(resolvedMtimeMs) && resolvedMtimeMs > 0 ? { mtimeMs: Number(resolvedMtimeMs) } : {})
        });
      });
    }
  });
}

async function uploadDirectoryTreeToSelfHostedSandboxNative(input: {
  currentLocalPath: string;
  currentRemotePath: string;
  sandbox: {
    id: string;
    baseUrl: string;
    headers?: Record<string, string> | undefined;
  };
}): Promise<void> {
  const maxConcurrency = resolveSeedUploadConcurrency();
  await observeNativeWorkspaceSyncOperation({
    operation: "sync_local_to_sandbox_http",
    implementation: "rust",
    target: input.currentLocalPath,
    logFailure: false,
    metadata: {
      remoteRootPath: input.currentRemotePath,
      sandboxId: input.sandbox.id,
      maxConcurrency
    },
    action: () =>
      nativeWorkspaceSyncAdapter.syncLocalToSandboxHttp({
        rootDir: input.currentLocalPath,
        remoteRootPath: input.currentRemotePath,
        maxConcurrency,
        sandbox: {
          baseUrl: input.sandbox.baseUrl,
          sandboxId: input.sandbox.id,
          ...(input.sandbox.headers ? { headers: input.sandbox.headers } : {})
        }
      })
  });
}

async function uploadWorkspaceSeed(input: {
  workspaceId: string;
  request: CreateWorkspaceRequest;
  initialized: WorkspaceInitializationResult;
  stagingWorkspaceRoot: string;
  sandboxHost: SandboxHost;
  remoteRootPath?: string | undefined;
  selfHostedSandbox?:
    | {
        id: string;
        baseUrl: string;
        headers?: Record<string, string> | undefined;
      }
    | undefined;
}): Promise<void> {
  const lease = await input.sandboxHost.workspaceFileAccessProvider.acquire({
    workspace: createSandboxSeedWorkspace({
      workspaceId: input.workspaceId,
      request: input.request,
      initialized: input.initialized,
      remoteRootPath: input.remoteRootPath
    }),
    access: "write"
  });

  try {
    await input.sandboxHost.workspaceFileSystem.stat(lease.workspace.rootPath).catch(async () => {
      if (lease.workspace.rootPath !== SANDBOX_WORKSPACE_ROOT) {
        await input.sandboxHost.workspaceFileSystem.mkdir(lease.workspace.rootPath, { recursive: true });
      }
    });
    if (input.selfHostedSandbox && nativeWorkspaceSyncAdapter.isEnabled()) {
      try {
        await uploadDirectoryTreeToSelfHostedSandboxNative({
          currentLocalPath: input.stagingWorkspaceRoot,
          currentRemotePath: input.remoteRootPath ?? SANDBOX_WORKSPACE_ROOT,
          sandbox: input.selfHostedSandbox
        });
        return;
      } catch (error) {
        recordNativeWorkspaceSyncFallback({
          operation: "sync_local_to_sandbox_http",
          target: input.stagingWorkspaceRoot,
          error,
          metadata: {
            remoteRootPath: input.remoteRootPath ?? SANDBOX_WORKSPACE_ROOT,
            sandboxId: input.selfHostedSandbox.id
          }
        });
      }
    }

    await uploadDirectoryTree({
      currentLocalPath: input.stagingWorkspaceRoot,
      currentRemotePath: lease.workspace.rootPath,
      sandboxHost: input.sandboxHost
    });
  } finally {
    await lease.release({ dirty: true });
  }
}

function createSandboxSeedWorkspace(input: {
  workspaceId: string;
  request: CreateWorkspaceRequest;
  initialized: WorkspaceInitializationResult;
  remoteRootPath?: string | undefined;
}) {
  const now = new Date().toISOString();
  return {
    id: input.workspaceId,
    kind: "project" as const,
    readOnly: false,
    historyMirrorEnabled: true,
    defaultAgent: input.initialized.defaultAgent,
    projectAgentsMd: input.initialized.projectAgentsMd,
    settings: input.initialized.settings,
    workspaceModels: input.initialized.workspaceModels,
    agents: input.initialized.agents,
    actions: input.initialized.actions,
    skills: input.initialized.skills,
    toolServers: input.initialized.toolServers,
    hooks: input.initialized.hooks,
    catalog: {
      ...input.initialized.catalog,
      workspaceId: input.workspaceId
    },
    ...(input.request.externalRef ? { externalRef: input.request.externalRef } : {}),
    ...(input.request.ownerId ? { ownerId: input.request.ownerId } : {}),
    ...(input.request.serviceName ? { serviceName: input.request.serviceName } : {}),
    ...(input.request.runtime ? { runtime: input.request.runtime } : {}),
    name: input.request.name,
    rootPath: input.remoteRootPath ?? SANDBOX_WORKSPACE_ROOT,
    executionPolicy: input.request.executionPolicy ?? "local",
    status: "active" as const,
    createdAt: now,
    updatedAt: now
  };
}

async function createSelfHostedSandbox(input: {
  request: CreateWorkspaceRequest;
  baseUrl: string;
  headers?: Record<string, string> | undefined;
}) {
  const response = await fetch(`${input.baseUrl.replace(/\/$/, "")}/sandboxes`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(input.headers ?? {})
    },
    body: JSON.stringify({
      name: input.request.name,
      runtime: input.request.runtime,
      executionPolicy: input.request.executionPolicy,
      ...(input.request.externalRef ? { externalRef: input.request.externalRef } : {}),
      ...(input.request.ownerId ? { ownerId: input.request.ownerId } : {}),
      ...(input.request.serviceName ? { serviceName: input.request.serviceName } : {})
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to create self-hosted sandbox: ${response.status} ${response.statusText}`);
  }

  return sandboxSchema.parse(await response.json());
}

export function createSandboxBackedWorkspaceInitializer(options: {
  runtimeDir: string;
  platformToolDir: string;
  platformSkillDir: string;
  toolDir: string;
  platformModels: PlatformModelRegistry;
  platformAgents: Record<string, DiscoveredAgent>;
  sandboxHost: SandboxHost;
  selfHosted?: {
    baseUrl: string;
    headers?: Record<string, string> | undefined;
  } | undefined;
}) {
  async function prepareSeed(input: CreateWorkspaceRequest): Promise<{
    preparedWorkspaceRoot: string;
    discovered: WorkspaceInitializationResult;
  }> {
    const cacheKey = await buildPreparedSeedCacheKey({
      runtimeDir: options.runtimeDir,
      runtimeName: input.runtime,
      platformToolDir: options.platformToolDir,
      platformSkillDir: options.platformSkillDir,
      toolDir: options.toolDir,
      agentsMd: input.agentsMd,
      toolServers: (input as typeof input & { toolServers?: Record<string, Record<string, unknown>> | undefined }).toolServers,
      skills: input.skills
    });

    let cached = preparedSeedCache.get(cacheKey);
    if (!cached) {
      cached = (async () => {
        const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "oah-sandbox-prepared-seed-"));
        const preparedWorkspaceRoot = path.join(cacheRoot, "workspace");

        await initializeWorkspaceFromRuntime({
          runtimeDir: options.runtimeDir,
          runtimeName: input.runtime,
          rootPath: preparedWorkspaceRoot,
          platformToolDir: options.platformToolDir,
          platformSkillDir: options.platformSkillDir,
          agentsMd: input.agentsMd,
          toolServers: (input as typeof input & { toolServers?: Record<string, Record<string, unknown>> | undefined }).toolServers,
          skills: input.skills
        });

        const discovered = await enrichWorkspaceModelsWithDiscoveredMetadata(
          await discoverWorkspace(preparedWorkspaceRoot, "project", {
            platformModels: options.platformModels,
            platformAgents: options.platformAgents,
            platformSkillDir: options.platformSkillDir,
            platformToolDir: options.toolDir
          })
        );

        return {
          preparedWorkspaceRoot,
          discovered
        };
      })().catch((error) => {
        preparedSeedCache.delete(cacheKey);
        throw error;
      });
      preparedSeedCache.set(cacheKey, cached);
    }

    return cached;
  }

  return {
    async initialize(input: CreateWorkspaceRequest): Promise<WorkspaceInitializationResult> {
      const workspaceId = (
        input as CreateWorkspaceRequest & {
          workspaceId?: string | undefined;
        }
      ).workspaceId?.trim() || createId("ws");
      let remoteRootPath = SANDBOX_WORKSPACE_ROOT;
      let selfHostedSandbox:
        | {
            id: string;
            baseUrl: string;
            headers?: Record<string, string> | undefined;
          }
        | undefined;

      const prepared = await prepareSeed(input);
      const stagingRoot = await mkdtemp(path.join(os.tmpdir(), "oah-sandbox-workspace-"));
      const stagingWorkspaceRoot = path.join(stagingRoot, "workspace");

      try {
        await cp(prepared.preparedWorkspaceRoot, stagingWorkspaceRoot, {
          recursive: true,
          force: false,
          errorOnExist: false,
          preserveTimestamps: true
        });

        if (options.selfHosted) {
          const sandbox = await createSelfHostedSandbox({
            request: input,
            baseUrl: options.selfHosted.baseUrl,
            headers: options.selfHosted.headers
          });
          remoteRootPath = sandbox.rootPath;
          selfHostedSandbox = {
            id: sandbox.id,
            baseUrl: options.selfHosted.baseUrl,
            ...(options.selfHosted.headers ? { headers: options.selfHosted.headers } : {})
          };
        }

        await uploadWorkspaceSeed({
          workspaceId,
          request: input,
          initialized: prepared.discovered,
          stagingWorkspaceRoot,
          sandboxHost: options.sandboxHost,
          remoteRootPath,
          selfHostedSandbox
        });

        return {
          ...prepared.discovered,
          id: workspaceId,
          rootPath: remoteRootPath
        };
      } finally {
        await rm(stagingRoot, { recursive: true, force: true });
      }
    }
  };
}
