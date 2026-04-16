import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  discoverWorkspace,
  initializeWorkspaceFromBlueprint,
  type DiscoveredAgent,
  type DiscoveredSkill,
  type DiscoveredToolServer,
  type PlatformModelRegistry
} from "@oah/config";
import { createId, type CreateWorkspaceRequest, type WorkspaceInitializationResult } from "@oah/runtime-core";

import type { SandboxHost } from "./sandbox-host.js";

const SANDBOX_WORKSPACE_ROOT = "/workspace";

function toPosixRelativePath(fromRoot: string, targetPath: string): string {
  return path.relative(fromRoot, targetPath).split(path.sep).join(path.posix.sep);
}

async function uploadDirectoryTree(input: {
  localRoot: string;
  remoteRoot: string;
  sandboxHost: SandboxHost;
}): Promise<void> {
  const entries = await readdir(input.localRoot, { withFileTypes: true });
  for (const entry of entries) {
    const localPath = path.join(input.localRoot, entry.name);
    const relativePath = toPosixRelativePath(input.localRoot, localPath);
    const remotePath = path.posix.join(input.remoteRoot, relativePath);

    if (entry.isDirectory()) {
      await input.sandboxHost.workspaceFileSystem.mkdir(remotePath, { recursive: true });
      await uploadDirectoryTree({
        ...input,
        localRoot: localPath
      });
      continue;
    }

    if (entry.isFile()) {
      const data = await readFile(localPath);
      await input.sandboxHost.workspaceFileSystem.writeFile(remotePath, data);
    }
  }
}

function createSandboxSeedWorkspace(input: {
  workspaceId: string;
  request: CreateWorkspaceRequest;
  initialized: WorkspaceInitializationResult;
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
    ...(input.request.serviceName ? { serviceName: input.request.serviceName } : {}),
    ...(input.request.blueprint ? { blueprint: input.request.blueprint } : {}),
    name: input.request.name,
    rootPath: SANDBOX_WORKSPACE_ROOT,
    executionPolicy: input.request.executionPolicy ?? "local",
    status: "active" as const,
    createdAt: now,
    updatedAt: now
  };
}

export function createSandboxBackedWorkspaceInitializer(options: {
  blueprintDir: string;
  platformToolDir: string;
  platformSkillDir: string;
  toolDir: string;
  platformModels: PlatformModelRegistry;
  platformAgents: Record<string, DiscoveredAgent>;
  sandboxHost: SandboxHost;
}) {
  return {
    async initialize(input: CreateWorkspaceRequest): Promise<WorkspaceInitializationResult> {
      const workspaceId = createId("ws");
      const stagingRoot = await mkdtemp(path.join(os.tmpdir(), "oah-sandbox-workspace-"));
      const stagingWorkspaceRoot = path.join(stagingRoot, "workspace");

      try {
        await initializeWorkspaceFromBlueprint({
          blueprintDir: options.blueprintDir,
          blueprintName: input.blueprint,
          rootPath: stagingWorkspaceRoot,
          platformToolDir: options.platformToolDir,
          platformSkillDir: options.platformSkillDir,
          agentsMd: input.agentsMd,
          toolServers: (input as typeof input & { toolServers?: Record<string, Record<string, unknown>> | undefined }).toolServers,
          skills: input.skills
        });

        const discovered = await discoverWorkspace(stagingWorkspaceRoot, "project", {
          platformModels: options.platformModels,
          platformAgents: options.platformAgents,
          platformSkillDir: options.platformSkillDir,
          platformToolDir: options.toolDir
        });

        const lease = await options.sandboxHost.workspaceFileAccessProvider.acquire({
          workspace: createSandboxSeedWorkspace({
            workspaceId,
            request: input,
            initialized: discovered
          }),
          access: "write"
        });

        try {
          await options.sandboxHost.workspaceFileSystem.mkdir(lease.workspace.rootPath, { recursive: true });
          await uploadDirectoryTree({
            localRoot: stagingWorkspaceRoot,
            remoteRoot: lease.workspace.rootPath,
            sandboxHost: options.sandboxHost
          });
        } finally {
          await lease.release({ dirty: true });
        }

        return {
          ...discovered,
          id: workspaceId,
          rootPath: SANDBOX_WORKSPACE_ROOT
        };
      } finally {
        await rm(stagingRoot, { recursive: true, force: true });
      }
    }
  };
}
