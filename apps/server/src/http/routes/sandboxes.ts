import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  SANDBOX_ROOT_PATH,
  sandboxPathToWorkspaceRelativePath,
  workspaceRelativePathToSandboxPath,
  createSandboxRequestSchema,
  createWorkspaceDirectoryRequestSchema,
  moveWorkspaceEntryRequestSchema,
  putWorkspaceFileRequestSchema,
  sandboxBackgroundCommandRequestSchema,
  sandboxBackgroundCommandResultSchema,
  sandboxCommandRequestSchema,
  sandboxCommandResultSchema,
  sandboxFileStatQuerySchema,
  sandboxFileStatSchema,
  sandboxProcessRequestSchema,
  sandboxSchema,
  workspaceDeleteEntryQuerySchema,
  workspaceDeleteResultSchema,
  workspaceEntriesQuerySchema,
  workspaceEntryPageSchema,
  workspaceEntryPathQuerySchema,
  workspaceEntrySchema,
  workspaceFileContentQuerySchema,
  workspaceFileContentSchema,
  workspaceFileUploadQuerySchema
} from "@oah/api-contracts";
import type {
  WorkspaceDeleteResult,
  WorkspaceEntry,
  WorkspaceEntryPage,
  WorkspaceFileContentResult
} from "@oah/engine-core";
import { AppError, createId } from "@oah/engine-core";

import { assertWorkspaceAccess, createParamsSchema, sendError, toCallerContext } from "../context.js";
import {
  buildOwnerProxyUrl,
  buildProxyBody,
  buildProxyHeaders,
  resolveOwnerId,
  sendProxyResponse
} from "../proxy-utils.js";
import { describeSandboxTopology } from "../../sandbox-topology.js";
import type { AppDependencies, AppRouteOptions } from "../types.js";

const DEFAULT_BACKGROUND_SESSION_PREFIX = "sandbox";

type WorkspaceOwnership = Awaited<ReturnType<NonNullable<AppDependencies["resolveWorkspaceOwnership"]>>>;

async function reserveOwnerScopedWorkspacePlacement(
  dependencies: Pick<
    AppDependencies,
    "assignWorkspacePlacementOwnerAffinity" | "releaseWorkspacePlacement" | "sandboxHostProviderKind"
  >,
  ownerId: string | undefined,
  workspaceId: string | undefined
): Promise<{ workspaceId: string | undefined; release: () => Promise<void> }> {
  if (!ownerId || !workspaceId || dependencies.sandboxHostProviderKind !== "self_hosted") {
    return {
      workspaceId,
      async release() {
        return undefined;
      }
    };
  }

  await dependencies.assignWorkspacePlacementOwnerAffinity?.({
    workspaceId,
    ownerId,
    overwrite: true
  });

  return {
    workspaceId,
    async release() {
      await dependencies.releaseWorkspacePlacement?.({
        workspaceId,
        state: "evicted"
      });
    }
  };
}

function normalizeSandboxOwnerBaseUrl(input: string | undefined): string | undefined {
  const trimmed = input?.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const url = new URL(trimmed);
    if (url.pathname.endsWith("/internal/v1")) {
      return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
    }
    if (url.pathname.endsWith("/api/v1")) {
      return `${url.origin}${url.pathname.replace(/\/api\/v1$/u, "/internal/v1")}`;
    }
    const normalizedPath = url.pathname.replace(/\/+$/u, "");
    return `${url.origin}${normalizedPath}/internal/v1`;
  } catch {
    if (trimmed.endsWith("/internal/v1")) {
      return trimmed.replace(/\/+$/u, "");
    }
    if (trimmed.endsWith("/api/v1")) {
      return trimmed.replace(/\/api\/v1$/u, "/internal/v1");
    }
    return `${trimmed.replace(/\/+$/u, "")}/internal/v1`;
  }
}

function assertSandboxOwnerMatchesWorkspace(
  ownerId: string | undefined,
  workspace: Pick<import("@oah/api-contracts").Workspace, "id" | "ownerId">
): void {
  const normalizedRequestedOwnerId = ownerId?.trim();
  if (!normalizedRequestedOwnerId) {
    return;
  }

  const normalizedWorkspaceOwnerId = workspace.ownerId?.trim();
  if (normalizedWorkspaceOwnerId === normalizedRequestedOwnerId) {
    return;
  }

  throw new AppError(
    409,
    "workspace_owner_mismatch",
    normalizedWorkspaceOwnerId
      ? `Workspace ${workspace.id} belongs to owner ${normalizedWorkspaceOwnerId}, not ${normalizedRequestedOwnerId}.`
      : `Workspace ${workspace.id} has no owner and cannot be reopened with owner ${normalizedRequestedOwnerId}.`
  );
}

function resolveWorkspaceOwnerBaseUrl(
  dependencies: Pick<AppDependencies, "sandboxOwnerFallbackBaseUrl">,
  ownership: NonNullable<WorkspaceOwnership>
): string | undefined {
  return ownership.ownerBaseUrl ?? dependencies.sandboxOwnerFallbackBaseUrl;
}

async function proxySandboxRequestToOwner(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: Pick<AppDependencies, "sandboxOwnerFallbackBaseUrl">,
  ownership: NonNullable<WorkspaceOwnership>
): Promise<void> {
  const ownerBaseUrl = resolveWorkspaceOwnerBaseUrl(dependencies, ownership);
  if (!ownerBaseUrl) {
    await sendError(
      reply,
      409,
      "workspace_owned_by_another_worker",
      `Workspace ${ownership.workspaceId} is currently owned by worker ${ownership.ownerWorkerId}.`,
      {
        workspaceId: ownership.workspaceId,
        ownerWorkerId: ownership.ownerWorkerId,
        version: ownership.version,
        health: ownership.health,
        lastActivityAt: ownership.lastActivityAt,
        localPath: ownership.localPath,
        ...(ownership.remotePrefix ? { remotePrefix: ownership.remotePrefix } : {}),
        routingHint: "owner_worker"
      }
    );
    return;
  }

  try {
    const body = buildProxyBody(request);
    const response = await fetch(
      buildOwnerProxyUrl(ownerBaseUrl, request, /^\/api\/v1\/sandboxes/u, "/internal/v1/sandboxes"),
      {
        method: request.method,
        headers: buildProxyHeaders(request),
        ...(body !== undefined ? { body } : {})
      }
    );

    await sendProxyResponse(reply, response);
  } catch {
    await sendError(
      reply,
      502,
      "workspace_owner_unreachable",
      `Failed to reach owner worker ${ownership.ownerWorkerId} for workspace ${ownership.workspaceId}.`,
      {
        workspaceId: ownership.workspaceId,
        ownerWorkerId: ownership.ownerWorkerId,
        ...(ownership.ownerBaseUrl ? { ownerBaseUrl: ownership.ownerBaseUrl } : {})
      }
    );
  }
}

async function guardSandboxOwnership(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AppDependencies,
  workspaceId: string
): Promise<"local" | "proxied" | "blocked"> {
  const ownership = await dependencies.resolveWorkspaceOwnership?.(workspaceId);
  if (!ownership || ownership.isLocalOwner) {
    return "local";
  }

  if (ownership.ownerBaseUrl) {
    await proxySandboxRequestToOwner(request, reply, dependencies, ownership);
    return "proxied";
  }

  if (dependencies.sandboxOwnerFallbackBaseUrl) {
    await proxySandboxRequestToOwner(request, reply, dependencies, ownership);
    return "proxied";
  }

  await sendError(
    reply,
    409,
    "workspace_owned_by_another_worker",
    `Workspace ${workspaceId} is currently owned by worker ${ownership.ownerWorkerId}.`,
    {
      workspaceId,
      ownerWorkerId: ownership.ownerWorkerId,
      version: ownership.version,
      health: ownership.health,
      lastActivityAt: ownership.lastActivityAt,
      localPath: ownership.localPath,
      ...(ownership.remotePrefix ? { remotePrefix: ownership.remotePrefix } : {}),
      routingHint: "owner_worker"
    }
  );
  return "blocked";
}

function sandboxPathToWorkspacePath(targetPath: string | undefined): string | undefined {
  if (!targetPath) {
    return undefined;
  }

  try {
    return sandboxPathToWorkspaceRelativePath(targetPath);
  } catch {
    throw new AppError(400, "invalid_sandbox_path", `Path ${targetPath} is outside sandbox root ${SANDBOX_ROOT_PATH}.`);
  }
}

function workspacePathToSandboxPath(targetPath: string | undefined): string {
  return workspaceRelativePathToSandboxPath(targetPath ?? ".");
}

async function buildSandboxResponse(dependencies: AppDependencies, workspaceId: string) {
  const workspace = await dependencies.runtimeService.getWorkspace(workspaceId);
  const ownership = await dependencies.resolveWorkspaceOwnership?.(workspaceId);
  const resolvedOwnerBaseUrl = normalizeSandboxOwnerBaseUrl(
    ownership?.ownerBaseUrl ??
      ((ownership?.isLocalOwner ?? true) ? dependencies.localOwnerBaseUrl : undefined)
  );

  return sandboxSchema.parse({
    id: workspace.id,
    workspaceId: workspace.id,
    ...describeSandboxTopology(dependencies.sandboxHostProviderKind),
    rootPath: SANDBOX_ROOT_PATH,
    name: workspace.name,
    kind: workspace.kind,
    executionPolicy: workspace.executionPolicy,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    ...(ownership?.ownerWorkerId ? { ownerWorkerId: ownership.ownerWorkerId } : {}),
    ...(resolvedOwnerBaseUrl ? { ownerBaseUrl: resolvedOwnerBaseUrl } : {})
  });
}

function toSandboxEntry(entry: WorkspaceEntry) {
  return {
    ...entry,
    path: workspacePathToSandboxPath(typeof entry.path === "string" ? entry.path : undefined)
  };
}

function toSandboxEntryPage(page: WorkspaceEntryPage) {
  return {
    ...page,
    path: workspacePathToSandboxPath(typeof page.path === "string" ? page.path : undefined),
    items: page.items.map((item) => ({
      ...item,
      path: workspacePathToSandboxPath(typeof item.path === "string" ? item.path : undefined)
    }))
  };
}

function toSandboxFileContent(file: WorkspaceFileContentResult) {
  return {
    ...file,
    path: workspacePathToSandboxPath(typeof file.path === "string" ? file.path : undefined)
  };
}

function toSandboxDeleteResult(result: WorkspaceDeleteResult) {
  return {
    ...result,
    path: workspacePathToSandboxPath(typeof result.path === "string" ? result.path : undefined)
  };
}

async function handleGetSandbox(
  dependencies: AppDependencies,
  sandboxId: string,
  reply: FastifyReply
) {
  return reply.send(await buildSandboxResponse(dependencies, sandboxId));
}

async function handleListSandboxEntries(
  dependencies: AppDependencies,
  sandboxId: string,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const query = workspaceEntriesQuerySchema.parse(request.query);
  const page = await dependencies.runtimeService.listWorkspaceEntries(sandboxId, {
    ...query,
    path: sandboxPathToWorkspacePath(query.path)
  });
  return reply.send(workspaceEntryPageSchema.parse(toSandboxEntryPage(page)));
}

async function handleGetSandboxFileStat(
  dependencies: AppDependencies,
  sandboxId: string,
  request: FastifyRequest,
  reply: FastifyReply
) {
  if (!dependencies.runtimeService.getWorkspaceFileStat) {
    throw new AppError(501, "sandbox_file_stat_unavailable", "Sandbox file stat is not available on this server.");
  }

  const query = sandboxFileStatQuerySchema.parse(request.query);
  const result = await dependencies.runtimeService.getWorkspaceFileStat(
    sandboxId,
    sandboxPathToWorkspacePath(query.path) ?? "."
  );
  return reply.send(
    sandboxFileStatSchema.parse({
      ...result,
      path: workspacePathToSandboxPath(result.path)
    })
  );
}

async function handleGetSandboxFileContent(
  dependencies: AppDependencies,
  sandboxId: string,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const query = workspaceFileContentQuerySchema.parse(request.query);
  const file = await dependencies.runtimeService.getWorkspaceFileContent(sandboxId, {
    ...query,
    path: sandboxPathToWorkspacePath(query.path) ?? "."
  });
  return reply.send(workspaceFileContentSchema.parse(toSandboxFileContent(file)));
}

async function handlePutSandboxFileContent(
  dependencies: AppDependencies,
  sandboxId: string,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const input = putWorkspaceFileRequestSchema.parse(request.body);
  const entry = await dependencies.runtimeService.putWorkspaceFileContent(sandboxId, {
    ...input,
    path: sandboxPathToWorkspacePath(input.path) ?? "."
  });
  return reply.send(workspaceEntrySchema.parse(toSandboxEntry(entry)));
}

async function handleUploadSandboxFile(
  dependencies: AppDependencies,
  sandboxId: string,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const query = workspaceFileUploadQuerySchema.parse(request.query);
  if (!Buffer.isBuffer(request.body)) {
    throw new AppError(415, "invalid_upload_content_type", "File upload requires Content-Type: application/octet-stream.");
  }

  const entry = await dependencies.runtimeService.uploadWorkspaceFile(sandboxId, {
    path: sandboxPathToWorkspacePath(query.path) ?? ".",
    data: request.body,
    overwrite: query.overwrite,
    ...(query.ifMatch !== undefined ? { ifMatch: query.ifMatch } : {})
  });
  return reply.send(workspaceEntrySchema.parse(toSandboxEntry(entry)));
}

async function handleDownloadSandboxFile(
  dependencies: AppDependencies,
  sandboxId: string,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const query = workspaceEntryPathQuerySchema.parse(request.query);
  const workspacePath = sandboxPathToWorkspacePath(query.path) ?? ".";
  const downloadHandle = dependencies.runtimeService.openWorkspaceFileDownload
    ? await dependencies.runtimeService.openWorkspaceFileDownload(sandboxId, workspacePath)
    : {
        file: await dependencies.runtimeService.getWorkspaceFileDownload(sandboxId, workspacePath),
        async release() {
          return undefined;
        }
      };
  const file = downloadHandle.file;
  let released = false;
  const releaseHandle = async () => {
    if (released) {
      return;
    }

    released = true;
    await downloadHandle.release({ dirty: false });
  };

  reply.header("Content-Type", file.mimeType ?? "application/octet-stream");
  reply.header("Content-Length", String(file.sizeBytes));
  reply.header("ETag", file.etag);
  reply.header("Last-Modified", file.updatedAt);
  reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
  const stream = file.openReadStream();
  stream.once("close", () => {
    void releaseHandle();
  });
  stream.once("error", () => {
    void releaseHandle();
  });
  reply.raw.once("close", () => {
    void releaseHandle();
  });
  return reply.send(stream);
}

async function handleCreateSandboxDirectory(
  dependencies: AppDependencies,
  sandboxId: string,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const input = createWorkspaceDirectoryRequestSchema.parse(request.body);
  const entry = await dependencies.runtimeService.createWorkspaceDirectory(sandboxId, {
    ...input,
    path: sandboxPathToWorkspacePath(input.path) ?? "."
  });
  return reply.status(201).send(workspaceEntrySchema.parse(toSandboxEntry(entry)));
}

async function handleDeleteSandboxEntry(
  dependencies: AppDependencies,
  sandboxId: string,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const query = workspaceDeleteEntryQuerySchema.parse(request.query);
  const result = await dependencies.runtimeService.deleteWorkspaceEntry(sandboxId, {
    ...query,
    path: sandboxPathToWorkspacePath(query.path) ?? "."
  });
  return reply.send(workspaceDeleteResultSchema.parse(toSandboxDeleteResult(result)));
}

async function handleMoveSandboxEntry(
  dependencies: AppDependencies,
  sandboxId: string,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const input = moveWorkspaceEntryRequestSchema.parse(request.body);
  const entry = await dependencies.runtimeService.moveWorkspaceEntry(sandboxId, {
    ...input,
    sourcePath: sandboxPathToWorkspacePath(input.sourcePath) ?? ".",
    targetPath: sandboxPathToWorkspacePath(input.targetPath) ?? "."
  });
  return reply.send(workspaceEntrySchema.parse(toSandboxEntry(entry)));
}

async function handleRunSandboxForegroundCommand(
  dependencies: AppDependencies,
  sandboxId: string,
  request: FastifyRequest,
  reply: FastifyReply
) {
  if (!dependencies.runtimeService.runWorkspaceCommandForeground) {
    throw new AppError(501, "sandbox_command_unavailable", "Sandbox command execution is not available on this server.");
  }

  const input = sandboxCommandRequestSchema.parse(request.body);
  const result = await dependencies.runtimeService.runWorkspaceCommandForeground(sandboxId, {
    ...input,
    cwd: sandboxPathToWorkspacePath(input.cwd)
  });
  return reply.send(sandboxCommandResultSchema.parse(result));
}

async function handleRunSandboxProcessCommand(
  dependencies: AppDependencies,
  sandboxId: string,
  request: FastifyRequest,
  reply: FastifyReply
) {
  if (!dependencies.runtimeService.runWorkspaceCommandProcess) {
    throw new AppError(501, "sandbox_process_unavailable", "Sandbox process execution is not available on this server.");
  }

  const input = sandboxProcessRequestSchema.parse(request.body);
  const result = await dependencies.runtimeService.runWorkspaceCommandProcess(sandboxId, {
    ...input,
    cwd: sandboxPathToWorkspacePath(input.cwd)
  });
  return reply.send(sandboxCommandResultSchema.parse(result));
}

async function handleRunSandboxBackgroundCommand(
  dependencies: AppDependencies,
  sandboxId: string,
  request: FastifyRequest,
  reply: FastifyReply
) {
  if (!dependencies.runtimeService.runWorkspaceCommandBackground) {
    throw new AppError(
      501,
      "sandbox_background_command_unavailable",
      "Sandbox background command execution is not available on this server."
    );
  }

  const input = sandboxBackgroundCommandRequestSchema.parse(request.body);
  const result = await dependencies.runtimeService.runWorkspaceCommandBackground(sandboxId, {
    ...input,
    sessionId: input.sessionId ?? `${DEFAULT_BACKGROUND_SESSION_PREFIX}:${sandboxId}`,
    cwd: sandboxPathToWorkspacePath(input.cwd)
  });
  return reply.send(sandboxBackgroundCommandResultSchema.parse(result));
}

function registerSandboxCoreRoutes(
  app: FastifyInstance,
  dependencies: AppDependencies,
  prefix: "/api/v1" | "/internal/v1",
  options?: { workspaceMode?: AppRouteOptions["workspaceMode"]; publicApi?: boolean | undefined }
) {
  const isPublicApi = options?.publicApi ?? false;
  const workspaceMode = options?.workspaceMode ?? "multi";

  app.post(`${prefix}/sandboxes`, async (request, reply) => {
    const input = createSandboxRequestSchema.parse(request.body);
    const ownerId = resolveOwnerId(input);

    if (input.workspaceId) {
      if (isPublicApi) {
        assertWorkspaceAccess(toCallerContext(request), input.workspaceId);
      }

      try {
        const existing = await dependencies.runtimeService.getWorkspace(input.workspaceId);
        assertSandboxOwnerMatchesWorkspace(ownerId, existing);
        if (ownerId) {
          await dependencies.assignWorkspacePlacementOwnerAffinity?.({
            workspaceId: input.workspaceId,
            ownerId,
            overwrite: false
          });
        }
        return reply.status(200).send(await buildSandboxResponse(dependencies, existing.id));
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== "workspace_not_found") {
          throw error;
        }
      }

      if (!input.name || !input.runtime) {
        throw new AppError(404, "workspace_not_found", `Workspace ${input.workspaceId} was not found.`);
      }

      if (workspaceMode === "single") {
        throw new AppError(501, "sandbox_creation_unavailable", "Sandbox creation is not available in single-workspace mode.");
      }

      const createWorkspaceInput = {
        name: input.name,
        runtime: input.runtime,
        executionPolicy: input.executionPolicy,
        ...(input.externalRef ? { externalRef: input.externalRef } : {}),
        ...(ownerId ? { ownerId } : {}),
        ...(input.serviceName ? { serviceName: input.serviceName } : {}),
        workspaceId: input.workspaceId
      };
      const reservedPlacement = await reserveOwnerScopedWorkspacePlacement(dependencies, ownerId, input.workspaceId);
      try {
        const workspace = await dependencies.runtimeService.createWorkspace({
          input: createWorkspaceInput as typeof createWorkspaceInput & {
            workspaceId: string;
          }
        });
        if (ownerId && workspace.id !== reservedPlacement.workspaceId) {
          await dependencies.assignWorkspacePlacementOwnerAffinity?.({
            workspaceId: workspace.id,
            ownerId,
            overwrite: true
          });
        }
        return reply.status(201).send(await buildSandboxResponse(dependencies, workspace.id));
      } catch (error) {
        await reservedPlacement.release();
        throw error;
      }
    }

    if (input.rootPath) {
      if (workspaceMode === "single" || !dependencies.importWorkspace) {
        throw new AppError(501, "sandbox_import_unavailable", "Sandbox import is not available on this server.");
      }

      const workspace = await dependencies.importWorkspace({
        rootPath: input.rootPath,
        ...(input.name ? { name: input.name } : {}),
        ...(input.externalRef ? { externalRef: input.externalRef } : {}),
        ...(ownerId ? { ownerId } : {}),
        ...(input.serviceName ? { serviceName: input.serviceName } : {})
      });
      if (ownerId) {
        await dependencies.assignWorkspacePlacementOwnerAffinity?.({
          workspaceId: workspace.id,
          ownerId,
          overwrite: true
        });
      }
      return reply.status(201).send(await buildSandboxResponse(dependencies, workspace.id));
    }

    if (workspaceMode === "single") {
      throw new AppError(501, "sandbox_creation_unavailable", "Sandbox creation is not available in single-workspace mode.");
    }

    const reservedPlacement = await reserveOwnerScopedWorkspacePlacement(
      dependencies,
      ownerId,
      ownerId ? createId("ws") : undefined
    );
    try {
      const workspace = await dependencies.runtimeService.createWorkspace({
        input: {
          name: input.name as string,
          runtime: input.runtime as string,
          executionPolicy: input.executionPolicy,
          ...(input.externalRef ? { externalRef: input.externalRef } : {}),
          ...(ownerId ? { ownerId } : {}),
          ...(input.serviceName ? { serviceName: input.serviceName } : {}),
          ...(reservedPlacement.workspaceId ? { workspaceId: reservedPlacement.workspaceId } : {})
        } as {
          name: string;
          runtime: string;
          executionPolicy: "local" | "container" | "remote_runner";
          externalRef?: string | undefined;
          ownerId?: string | undefined;
          serviceName?: string | undefined;
          workspaceId?: string | undefined;
        }
      });
      if (ownerId && workspace.id !== reservedPlacement.workspaceId) {
        await dependencies.assignWorkspacePlacementOwnerAffinity?.({
          workspaceId: workspace.id,
          ownerId,
          overwrite: true
        });
      }
      return reply.status(201).send(await buildSandboxResponse(dependencies, workspace.id));
    } catch (error) {
      await reservedPlacement.release();
      throw error;
    }
  });

  app.get(`${prefix}/sandboxes/:sandboxId`, async (request, reply) => {
    const params = createParamsSchema("sandboxId").parse(request.params);
    if (isPublicApi) {
      assertWorkspaceAccess(toCallerContext(request), params.sandboxId);
      if ((await guardSandboxOwnership(request, reply, dependencies, params.sandboxId)) !== "local") {
        return reply;
      }
    }
    return handleGetSandbox(dependencies, params.sandboxId, reply);
  });

  app.get(`${prefix}/sandboxes/:sandboxId/files/entries`, async (request, reply) => {
    const params = createParamsSchema("sandboxId").parse(request.params);
    if (isPublicApi) {
      assertWorkspaceAccess(toCallerContext(request), params.sandboxId);
      if ((await guardSandboxOwnership(request, reply, dependencies, params.sandboxId)) !== "local") {
        return reply;
      }
    }
    return handleListSandboxEntries(dependencies, params.sandboxId, request, reply);
  });

  app.get(`${prefix}/sandboxes/:sandboxId/files/stat`, async (request, reply) => {
    const params = createParamsSchema("sandboxId").parse(request.params);
    if (isPublicApi) {
      assertWorkspaceAccess(toCallerContext(request), params.sandboxId);
      if ((await guardSandboxOwnership(request, reply, dependencies, params.sandboxId)) !== "local") {
        return reply;
      }
    }
    return handleGetSandboxFileStat(dependencies, params.sandboxId, request, reply);
  });

  app.get(`${prefix}/sandboxes/:sandboxId/files/content`, async (request, reply) => {
    const params = createParamsSchema("sandboxId").parse(request.params);
    if (isPublicApi) {
      assertWorkspaceAccess(toCallerContext(request), params.sandboxId);
      if ((await guardSandboxOwnership(request, reply, dependencies, params.sandboxId)) !== "local") {
        return reply;
      }
    }
    return handleGetSandboxFileContent(dependencies, params.sandboxId, request, reply);
  });

  app.put(`${prefix}/sandboxes/:sandboxId/files/content`, async (request, reply) => {
    const params = createParamsSchema("sandboxId").parse(request.params);
    if (isPublicApi) {
      assertWorkspaceAccess(toCallerContext(request), params.sandboxId);
      if ((await guardSandboxOwnership(request, reply, dependencies, params.sandboxId)) !== "local") {
        return reply;
      }
    }
    return handlePutSandboxFileContent(dependencies, params.sandboxId, request, reply);
  });

  app.put(`${prefix}/sandboxes/:sandboxId/files/upload`, async (request, reply) => {
    const params = createParamsSchema("sandboxId").parse(request.params);
    if (isPublicApi) {
      assertWorkspaceAccess(toCallerContext(request), params.sandboxId);
      if ((await guardSandboxOwnership(request, reply, dependencies, params.sandboxId)) !== "local") {
        return reply;
      }
    }
    return handleUploadSandboxFile(dependencies, params.sandboxId, request, reply);
  });

  app.get(`${prefix}/sandboxes/:sandboxId/files/download`, async (request, reply) => {
    const params = createParamsSchema("sandboxId").parse(request.params);
    if (isPublicApi) {
      assertWorkspaceAccess(toCallerContext(request), params.sandboxId);
      if ((await guardSandboxOwnership(request, reply, dependencies, params.sandboxId)) !== "local") {
        return reply;
      }
    }
    return handleDownloadSandboxFile(dependencies, params.sandboxId, request, reply);
  });

  app.post(`${prefix}/sandboxes/:sandboxId/directories`, async (request, reply) => {
    const params = createParamsSchema("sandboxId").parse(request.params);
    if (isPublicApi) {
      assertWorkspaceAccess(toCallerContext(request), params.sandboxId);
      if ((await guardSandboxOwnership(request, reply, dependencies, params.sandboxId)) !== "local") {
        return reply;
      }
    }
    return handleCreateSandboxDirectory(dependencies, params.sandboxId, request, reply);
  });

  app.delete(`${prefix}/sandboxes/:sandboxId/files/entry`, async (request, reply) => {
    const params = createParamsSchema("sandboxId").parse(request.params);
    if (isPublicApi) {
      assertWorkspaceAccess(toCallerContext(request), params.sandboxId);
      if ((await guardSandboxOwnership(request, reply, dependencies, params.sandboxId)) !== "local") {
        return reply;
      }
    }
    return handleDeleteSandboxEntry(dependencies, params.sandboxId, request, reply);
  });

  app.patch(`${prefix}/sandboxes/:sandboxId/files/move`, async (request, reply) => {
    const params = createParamsSchema("sandboxId").parse(request.params);
    if (isPublicApi) {
      assertWorkspaceAccess(toCallerContext(request), params.sandboxId);
      if ((await guardSandboxOwnership(request, reply, dependencies, params.sandboxId)) !== "local") {
        return reply;
      }
    }
    return handleMoveSandboxEntry(dependencies, params.sandboxId, request, reply);
  });

  app.post(`${prefix}/sandboxes/:sandboxId/commands/foreground`, async (request, reply) => {
    const params = createParamsSchema("sandboxId").parse(request.params);
    if (isPublicApi) {
      assertWorkspaceAccess(toCallerContext(request), params.sandboxId);
      if ((await guardSandboxOwnership(request, reply, dependencies, params.sandboxId)) !== "local") {
        return reply;
      }
    }
    return handleRunSandboxForegroundCommand(dependencies, params.sandboxId, request, reply);
  });

  app.post(`${prefix}/sandboxes/:sandboxId/commands/process`, async (request, reply) => {
    const params = createParamsSchema("sandboxId").parse(request.params);
    if (isPublicApi) {
      assertWorkspaceAccess(toCallerContext(request), params.sandboxId);
      if ((await guardSandboxOwnership(request, reply, dependencies, params.sandboxId)) !== "local") {
        return reply;
      }
    }
    return handleRunSandboxProcessCommand(dependencies, params.sandboxId, request, reply);
  });

  app.post(`${prefix}/sandboxes/:sandboxId/commands/background`, async (request, reply) => {
    const params = createParamsSchema("sandboxId").parse(request.params);
    if (isPublicApi) {
      assertWorkspaceAccess(toCallerContext(request), params.sandboxId);
      if ((await guardSandboxOwnership(request, reply, dependencies, params.sandboxId)) !== "local") {
        return reply;
      }
    }
    return handleRunSandboxBackgroundCommand(dependencies, params.sandboxId, request, reply);
  });
}

export function registerInternalSandboxRoutes(app: FastifyInstance, dependencies: AppDependencies): void {
  registerSandboxCoreRoutes(app, dependencies, "/internal/v1");
}

export function registerSandboxRoutes(
  app: FastifyInstance,
  dependencies: AppDependencies,
  options: AppRouteOptions
): void {
  registerSandboxCoreRoutes(app, dependencies, "/api/v1", {
    workspaceMode: options.workspaceMode,
    publicApi: true
  });
}
