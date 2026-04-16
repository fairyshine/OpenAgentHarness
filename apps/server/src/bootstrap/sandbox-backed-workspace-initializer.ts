import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  discoverWorkspace,
  initializeWorkspaceFromBlueprint,
  type DiscoveredAgent,
  type PlatformModelRegistry
} from "@oah/config";
import { createSandboxHttpClient, type CreateWorkspaceRequest } from "@oah/api-contracts";
import { createId, type WorkspaceInitializationResult } from "@oah/runtime-core";

import type { SandboxHost } from "./sandbox-host.js";

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
    ...(input.request.ownerId ? { ownerId: input.request.ownerId } : {}),
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

        if (options.sandboxHost.providerKind === "self_hosted" && options.selfHosted) {
          const baseUrl = options.selfHosted.baseUrl.replace(/\/+$/u, "");
          const sandboxClient = createSandboxHttpClient({
            async requestJson<T>(requestPath: string, init?: RequestInit) {
              const headers = new Headers(options.selfHosted?.headers);
              const inputHeaders = new Headers(init?.headers);
              for (const [name, value] of inputHeaders.entries()) {
                headers.set(name, value);
              }

              const response = await fetch(`${baseUrl}${requestPath}`, {
                ...init,
                headers
              });
              const raw = await response.text();
              if (!response.ok) {
                throw new Error(raw || `Sandbox backend request failed with status ${response.status}.`);
              }

              return JSON.parse(raw) as T;
            },
            async requestBytes() {
              throw new Error("Self-hosted sandbox bootstrap does not use byte transport during workspace initialization.");
            }
          });

          await sandboxClient.createSandbox({
            workspaceId,
            name: input.name,
            blueprint: input.blueprint,
            ...(input.ownerId ? { ownerId: input.ownerId } : {}),
            ...(input.serviceName ? { serviceName: input.serviceName } : {}),
            executionPolicy: input.executionPolicy ?? "local"
          });

          return {
            ...discovered,
            id: workspaceId,
            rootPath: SANDBOX_WORKSPACE_ROOT
          };
        }

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
            currentLocalPath: stagingWorkspaceRoot,
            currentRemotePath: lease.workspace.rootPath,
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
