import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  discoverWorkspace,
  initializeWorkspaceFromRuntime,
  type DiscoveredAgent,
  type PlatformModelRegistry
} from "@oah/config";
import { sandboxSchema, type CreateWorkspaceRequest } from "@oah/api-contracts";
import { createId, type WorkspaceInitializationResult } from "@oah/engine-core";

import type { SandboxHost } from "./sandbox-host.js";
import { enrichWorkspaceModelsWithDiscoveredMetadata } from "./model-metadata-discovery.js";

const SANDBOX_WORKSPACE_ROOT = "/workspace";

async function uploadDirectoryTree(input: {
  currentLocalPath: string;
  currentRemotePath: string;
  sandboxHost: SandboxHost;
}): Promise<void> {
  const entries = await readdir(input.currentLocalPath, { withFileTypes: true });
  for (const entry of entries) {
    const localPath = path.join(input.currentLocalPath, entry.name);
    const remotePath = path.posix.join(input.currentRemotePath, entry.name);

    if (entry.isDirectory()) {
      await input.sandboxHost.workspaceFileSystem.mkdir(remotePath, { recursive: true });
      await uploadDirectoryTree({
        ...input,
        currentLocalPath: localPath,
        currentRemotePath: remotePath
      });
      continue;
    }

    if (entry.isFile()) {
      const data = await readFile(localPath);
      await input.sandboxHost.workspaceFileSystem.writeFile(remotePath, data);
    }
  }
}

async function uploadWorkspaceSeed(input: {
  workspaceId: string;
  request: CreateWorkspaceRequest;
  initialized: WorkspaceInitializationResult;
  stagingWorkspaceRoot: string;
  sandboxHost: SandboxHost;
  remoteRootPath?: string | undefined;
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
  return {
    async initialize(input: CreateWorkspaceRequest): Promise<WorkspaceInitializationResult> {
      const workspaceId = (
        input as CreateWorkspaceRequest & {
          workspaceId?: string | undefined;
        }
      ).workspaceId?.trim() || createId("ws");
      const stagingRoot = await mkdtemp(path.join(os.tmpdir(), "oah-sandbox-workspace-"));
      const stagingWorkspaceRoot = path.join(stagingRoot, "workspace");
      let remoteRootPath = SANDBOX_WORKSPACE_ROOT;

      try {
        await initializeWorkspaceFromRuntime({
          runtimeDir: options.runtimeDir,
          runtimeName: input.runtime,
          rootPath: stagingWorkspaceRoot,
          platformToolDir: options.platformToolDir,
          platformSkillDir: options.platformSkillDir,
          agentsMd: input.agentsMd,
          toolServers: (input as typeof input & { toolServers?: Record<string, Record<string, unknown>> | undefined }).toolServers,
          skills: input.skills
        });

        const discovered = await enrichWorkspaceModelsWithDiscoveredMetadata(
          await discoverWorkspace(stagingWorkspaceRoot, "project", {
            platformModels: options.platformModels,
            platformAgents: options.platformAgents,
            platformSkillDir: options.platformSkillDir,
            platformToolDir: options.toolDir
          })
        );

        if (options.selfHosted) {
          const sandbox = await createSelfHostedSandbox({
            request: input,
            baseUrl: options.selfHosted.baseUrl,
            headers: options.selfHosted.headers
          });
          remoteRootPath = sandbox.rootPath;
        }

        await uploadWorkspaceSeed({
          workspaceId,
          request: input,
          initialized: discovered,
          stagingWorkspaceRoot,
          sandboxHost: options.sandboxHost,
          remoteRootPath
        });

        return {
          ...discovered,
          id: workspaceId,
          rootPath: remoteRootPath
        };
      } finally {
        await rm(stagingRoot, { recursive: true, force: true });
      }
    }
  };
}
