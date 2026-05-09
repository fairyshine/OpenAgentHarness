import { setTimeout as sleep } from "node:timers/promises";

import { sandboxSchema, type CreateWorkspaceRequest } from "@oah/api-contracts";
import {
  createId,
  type WorkerRegistry,
  type WorkspaceInitializationResult,
  type WorkspacePlacementRegistry,
  type WorkspaceRecord
} from "@oah/engine-core";

import {
  DEFAULT_DELEGATED_WORKSPACE_RECORD_POLL_MS,
  resolveDelegatedWorkspaceRecordWaitMs
} from "./sandbox-workspace-seed-config.js";
import { resolveSelfHostedSandboxCreateBaseUrl } from "./self-hosted-sandbox-routing.js";

export interface SelfHostedSandboxInitializerOptions {
  baseUrl: string;
  headers?: Record<string, string> | undefined;
  maxWorkspacesPerSandbox?: number | undefined;
  resourceCpuPressureThreshold?: number | undefined;
  resourceMemoryPressureThreshold?: number | undefined;
  resourceDiskPressureThreshold?: number | undefined;
  workspacePlacementRegistry?: Pick<WorkspacePlacementRegistry, "listAll" | "assignOwnerAffinity"> | undefined;
  workerRegistry?: Pick<WorkerRegistry, "listActive"> | undefined;
}

export async function createSelfHostedSandbox(input: {
  request: CreateWorkspaceRequest;
  workspaceId: string;
  baseUrl: string;
  headers?: Record<string, string> | undefined;
  includeWorkspaceId?: boolean | undefined;
  maxWorkspacesPerSandbox?: number | undefined;
  resourceCpuPressureThreshold?: number | undefined;
  resourceMemoryPressureThreshold?: number | undefined;
  resourceDiskPressureThreshold?: number | undefined;
  workspacePlacementRegistry?: Pick<WorkspacePlacementRegistry, "listAll" | "assignOwnerAffinity"> | undefined;
  workerRegistry?: Pick<WorkerRegistry, "listActive"> | undefined;
}) {
  const targetBaseUrl =
    (await resolveSelfHostedSandboxCreateBaseUrl({
      baseUrl: input.baseUrl,
      workspace: {
        ...(input.request.ownerId ? { ownerId: input.request.ownerId } : {}),
        id: input.workspaceId
      },
      maxWorkspacesPerSandbox: input.maxWorkspacesPerSandbox,
      resourceCpuPressureThreshold: input.resourceCpuPressureThreshold,
      resourceMemoryPressureThreshold: input.resourceMemoryPressureThreshold,
      resourceDiskPressureThreshold: input.resourceDiskPressureThreshold,
      ...(input.workspacePlacementRegistry ? { workspacePlacementRegistry: input.workspacePlacementRegistry } : {}),
      ...(input.workerRegistry ? { workerRegistry: input.workerRegistry } : {})
    })) ?? input.baseUrl;
  const response = await fetch(`${targetBaseUrl.replace(/\/$/, "")}/sandboxes`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(input.headers ?? {})
    },
    body: JSON.stringify({
      ...(input.includeWorkspaceId ? { workspaceId: input.workspaceId } : {}),
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

export function createSelfHostedWorkspaceDelegatingInitializer(options: {
  selfHosted: SelfHostedSandboxInitializerOptions;
  getWorkspaceRecord(workspaceId: string): Promise<WorkspaceRecord | undefined>;
}) {
  return {
    async initialize(input: CreateWorkspaceRequest): Promise<WorkspaceInitializationResult> {
      const workspaceId = (
        input as CreateWorkspaceRequest & {
          workspaceId?: string | undefined;
        }
      ).workspaceId?.trim() || createId("ws");

      const sandbox = await createSelfHostedSandbox({
        request: input,
        workspaceId,
        baseUrl: options.selfHosted.baseUrl,
        headers: options.selfHosted.headers,
        includeWorkspaceId: true,
        maxWorkspacesPerSandbox: options.selfHosted.maxWorkspacesPerSandbox,
        resourceCpuPressureThreshold: options.selfHosted.resourceCpuPressureThreshold,
        resourceMemoryPressureThreshold: options.selfHosted.resourceMemoryPressureThreshold,
        resourceDiskPressureThreshold: options.selfHosted.resourceDiskPressureThreshold,
        ...(options.selfHosted.workspacePlacementRegistry
          ? { workspacePlacementRegistry: options.selfHosted.workspacePlacementRegistry }
          : {}),
        ...(options.selfHosted.workerRegistry ? { workerRegistry: options.selfHosted.workerRegistry } : {})
      });

      const waitUntilMs = Date.now() + resolveDelegatedWorkspaceRecordWaitMs();
      let created = await options.getWorkspaceRecord(sandbox.workspaceId);
      while (!created && Date.now() < waitUntilMs) {
        await sleep(DEFAULT_DELEGATED_WORKSPACE_RECORD_POLL_MS);
        created = await options.getWorkspaceRecord(sandbox.workspaceId);
      }
      if (!created) {
        throw new Error(
          `Self-hosted worker created sandbox ${sandbox.id} for workspace ${sandbox.workspaceId}, but no workspace record was visible to the API.`
        );
      }

      return created;
    }
  };
}
