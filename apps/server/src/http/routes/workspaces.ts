import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  SANDBOX_ROOT_PATH,
  createActionRunRequestSchema,
  createSessionRequestSchema,
  createWorkspaceDirectoryRequestSchema,
  createWorkspaceRequestSchema,
  moveWorkspaceEntryRequestSchema,
  pageQuerySchema,
  putWorkspaceFileRequestSchema,
  repairLocalWorkspaceRequestSchema,
  registerLocalWorkspaceRequestSchema,
  sessionPageSchema,
  workspaceDeleteEntryQuerySchema,
  workspaceDeleteResultSchema,
  workspaceEntriesQuerySchema,
  workspaceEntryPageSchema,
  workspaceEntryPathQuerySchema,
  workspaceEntrySchema,
  workspaceFileContentQuerySchema,
  workspaceFileContentSchema,
  workspaceFileUploadQuerySchema,
  workspacePageSchema
} from "@oah/api-contracts";
import { AppError, createId } from "@oah/engine-core";

import { assertWorkspaceAccess, createParamsSchema, sendError, toCallerContext } from "../context.js";
import {
  buildOwnerProxyUrl,
  buildProxyBody,
  buildProxyRequestInit,
  readRequestBodyBuffer,
  resolveOwnerId,
  sendProxyResponse
} from "../proxy-utils.js";
import type { AppDependencies, AppRouteOptions } from "../types.js";

type WorkspaceOwnership = Awaited<ReturnType<NonNullable<AppDependencies["resolveWorkspaceOwnership"]>>>;
const workspaceLifecycleOperations = new Set(["hydrate", "flush", "evict", "delete", "repair_placement"] as const);

function parseWorkspaceLifecycleRequest(body: unknown): {
  operation: "hydrate" | "flush" | "evict" | "delete" | "repair_placement";
  force?: boolean | undefined;
} {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError(400, "invalid_lifecycle_request", "Workspace lifecycle request body must be an object.");
  }

  const operation = (body as { operation?: unknown }).operation;
  if (typeof operation !== "string" || !workspaceLifecycleOperations.has(operation as never)) {
    throw new AppError(400, "invalid_lifecycle_operation", "Unsupported workspace lifecycle operation.");
  }

  const force = (body as { force?: unknown }).force;
  return {
    operation: operation as "hydrate" | "flush" | "evict" | "delete" | "repair_placement",
    ...(typeof force === "boolean" ? { force } : {})
  };
}

function readRegisteredRouteUrl(request: FastifyRequest): string {
  return typeof request.routeOptions.url === "string" ? request.routeOptions.url : request.url.split("?")[0] ?? request.url;
}

function assertLocalWorkspaceRegistrationAvailable(dependencies: AppDependencies, options: AppRouteOptions): void {
  if (options.workspaceMode === "single" || !dependencies.registerLocalWorkspace) {
    throw new AppError(501, "local_workspace_registration_unavailable", "Local workspace registration is not available on this server.");
  }
  assertLocalWorkspacePathCapability(dependencies);
}

function assertLocalWorkspaceRepairAvailable(dependencies: AppDependencies, options: AppRouteOptions): void {
  if (options.workspaceMode === "single" || !dependencies.repairLocalWorkspace) {
    throw new AppError(501, "local_workspace_repair_unavailable", "Local workspace repair is not available on this server.");
  }
  assertLocalWorkspacePathCapability(dependencies);
}

function assertLocalWorkspacePathCapability(dependencies: AppDependencies): void {
  if (
    dependencies.systemProfile?.edition !== "personal" ||
    !dependencies.systemProfile.capabilities.localWorkspacePaths ||
    !dependencies.systemProfile.capabilities.workspaceRegistration
  ) {
    throw new AppError(
      403,
      "local_workspace_registration_forbidden",
      "Local workspace registration requires a personal server profile with local workspace path capability."
    );
  }
}

function resolveWorkspaceOwnerBaseUrl(
  dependencies: Pick<AppDependencies, "sandboxOwnerFallbackBaseUrl">,
  ownership: NonNullable<WorkspaceOwnership>
): string | undefined {
  return ownership.ownerBaseUrl ?? dependencies.sandboxOwnerFallbackBaseUrl;
}

function shouldDelegateSelfHostedWorkspaceOperation(
  dependencies: Pick<AppDependencies, "localOwnerBaseUrl" | "sandboxHostProviderKind" | "sandboxOwnerFallbackBaseUrl">
): boolean {
  return (
    dependencies.sandboxHostProviderKind === "self_hosted" &&
    Boolean(dependencies.sandboxOwnerFallbackBaseUrl) &&
    !dependencies.localOwnerBaseUrl
  );
}

function projectWorkspaceForPublicApi(
  dependencies: Pick<AppDependencies, "sandboxHostProviderKind">,
  workspace: import("@oah/api-contracts").Workspace
): import("@oah/api-contracts").Workspace {
  if (
    dependencies.sandboxHostProviderKind !== "self_hosted" &&
    dependencies.sandboxHostProviderKind !== "e2b"
  ) {
    return workspace;
  }

  return {
    ...workspace,
    rootPath: SANDBOX_ROOT_PATH
  };
}

function projectWorkspacePageForPublicApi(
  dependencies: Pick<AppDependencies, "sandboxHostProviderKind">,
  page: import("@oah/api-contracts").WorkspacePage
): import("@oah/api-contracts").WorkspacePage {
  return {
    ...page,
    items: page.items.map((workspace) => projectWorkspaceForPublicApi(dependencies, workspace))
  };
}

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

async function proxyWorkspaceRequestToOwner(
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
      buildOwnerProxyUrl(ownerBaseUrl, request, /^\/api\/v1\/workspaces/u, "/internal/v1/workspaces"),
      buildProxyRequestInit(request, body)
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

async function proxyWorkspaceRequestToBaseUrl(
  request: FastifyRequest,
  reply: FastifyReply,
  baseUrl: string,
  errorContext: { code: string; message: string; details?: Record<string, unknown> | undefined }
): Promise<void> {
  try {
    const body = buildProxyBody(request);
    const response = await fetch(
      buildOwnerProxyUrl(baseUrl, request, /^\/api\/v1\/workspaces/u, "/internal/v1/workspaces"),
      buildProxyRequestInit(request, body)
    );

    await sendProxyResponse(reply, response);
  } catch (error) {
    await sendError(reply, 502, errorContext.code, errorContext.message, errorContext.details);
  }
}

async function guardWorkspaceOwnership(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AppDependencies,
  workspaceId: string
): Promise<"local" | "proxied" | "blocked"> {
  const ownership = await dependencies.resolveWorkspaceOwnership?.(workspaceId);
  if (!ownership) {
    if (shouldDelegateSelfHostedWorkspaceOperation(dependencies)) {
      await proxyWorkspaceRequestToBaseUrl(request, reply, dependencies.sandboxOwnerFallbackBaseUrl!, {
        code: "workspace_owner_unresolved",
        message: `Failed to resolve an owner for workspace ${workspaceId}; routed request to a self-hosted worker.`,
        details: {
          workspaceId,
          routingHint: "self_hosted_worker"
        }
      });
      return "proxied";
    }
    return "local";
  }

  if (ownership.isLocalOwner) {
    return "local";
  }

  if (ownership.ownerBaseUrl) {
    await proxyWorkspaceRequestToOwner(request, reply, dependencies, ownership);
    return "proxied";
  }

  if (dependencies.sandboxOwnerFallbackBaseUrl) {
    await proxyWorkspaceRequestToOwner(request, reply, dependencies, ownership);
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

async function handleListWorkspaceEntries(
  dependencies: AppDependencies,
  workspaceId: string,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const query = workspaceEntriesQuerySchema.parse(request.query);
  const page =
    (await dependencies.listWorkspaceEntriesFast?.({
      workspaceId,
      ...query
    }).catch((error) => {
      if (dependencies.logger) {
        console.warn(`[oah-http] Fast workspace file list failed for ${workspaceId}; falling back to workspace lease.`, error);
      }
      return undefined;
    })) ?? (await dependencies.runtimeService.listWorkspaceEntries(workspaceId, query));
  return reply.send(workspaceEntryPageSchema.parse(page));
}

async function handleGetWorkspaceFileContent(
  dependencies: AppDependencies,
  workspaceId: string,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const query = workspaceFileContentQuerySchema.parse(request.query);
  const file = await dependencies.runtimeService.getWorkspaceFileContent(workspaceId, query);
  return reply.send(workspaceFileContentSchema.parse(file));
}

async function handlePutWorkspaceFileContent(
  dependencies: AppDependencies,
  workspaceId: string,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const input = putWorkspaceFileRequestSchema.parse(request.body);
  const entry = await dependencies.runtimeService.putWorkspaceFileContent(workspaceId, {
    path: input.path,
    content: input.content,
    encoding: input.encoding,
    overwrite: input.overwrite,
    ...(input.ifMatch !== undefined ? { ifMatch: input.ifMatch } : {})
  });
  return reply.send(workspaceEntrySchema.parse(entry));
}

async function handleUploadWorkspaceFile(
  dependencies: AppDependencies,
  workspaceId: string,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const query = workspaceFileUploadQuerySchema.parse(request.query);
  const data = await readRequestBodyBuffer(request.body);
  if (!data) {
    throw new AppError(415, "invalid_upload_content_type", "File upload requires Content-Type: application/octet-stream.");
  }

  const entry = await dependencies.runtimeService.uploadWorkspaceFile(workspaceId, {
    path: query.path,
    data,
    overwrite: query.overwrite,
    ...(query.ifMatch !== undefined ? { ifMatch: query.ifMatch } : {}),
    ...(query.mtimeMs !== undefined ? { mtimeMs: query.mtimeMs } : {})
  });
  return reply.send(workspaceEntrySchema.parse(entry));
}

async function handleDownloadWorkspaceFile(
  dependencies: AppDependencies,
  workspaceId: string,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const query = workspaceEntryPathQuerySchema.parse(request.query);
  const downloadHandle = dependencies.runtimeService.openWorkspaceFileDownload
    ? await dependencies.runtimeService.openWorkspaceFileDownload(workspaceId, query.path)
    : {
        file: await dependencies.runtimeService.getWorkspaceFileDownload(workspaceId, query.path),
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
  if (file.updatedAt) {
    reply.header("Last-Modified", file.updatedAt);
  }
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

async function handleCreateWorkspaceDirectory(
  dependencies: AppDependencies,
  workspaceId: string,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const input = createWorkspaceDirectoryRequestSchema.parse(request.body);
  const entry = await dependencies.runtimeService.createWorkspaceDirectory(workspaceId, input);
  return reply.status(201).send(workspaceEntrySchema.parse(entry));
}

async function handleDeleteWorkspaceEntry(
  dependencies: AppDependencies,
  workspaceId: string,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const query = workspaceDeleteEntryQuerySchema.parse(request.query);
  const result = await dependencies.runtimeService.deleteWorkspaceEntry(workspaceId, query);
  return reply.send(workspaceDeleteResultSchema.parse(result));
}

async function handleMoveWorkspaceEntry(
  dependencies: AppDependencies,
  workspaceId: string,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const input = moveWorkspaceEntryRequestSchema.parse(request.body);
  const entry = await dependencies.runtimeService.moveWorkspaceEntry(workspaceId, input);
  return reply.send(workspaceEntrySchema.parse(entry));
}

async function handleDeleteWorkspace(
  dependencies: AppDependencies,
  workspaceId: string,
  reply: FastifyReply
) {
  try {
    await dependencies.runtimeService.deleteWorkspace(workspaceId);
  } catch (error) {
    if (!(error instanceof Error) || (error as Error & { code?: string }).code !== "workspace_not_found") {
      throw error;
    }
  }

  await dependencies.clearWorkspaceCoordination?.(workspaceId);
  return reply.status(204).send();
}

async function handleWorkspaceLifecycle(
  dependencies: AppDependencies,
  workspaceId: string,
  request: FastifyRequest,
  reply: FastifyReply
) {
  if (!dependencies.workspaceLifecycle) {
    throw new AppError(501, "workspace_lifecycle_unavailable", "Workspace lifecycle operations are not available on this server.");
  }

  const input = parseWorkspaceLifecycleRequest(request.body);
  const result = await dependencies.workspaceLifecycle.execute({
    workspaceId,
    operation: input.operation,
    ...(input.force !== undefined ? { force: input.force } : {})
  });
  return reply.send(result);
}

export async function dispatchRegisteredInternalWorkspaceRoute(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AppDependencies
) {
  const routeUrl = readRegisteredRouteUrl(request);

  switch (`${request.method} ${routeUrl}`) {
    case "POST /internal/v1/workspaces/:workspaceId/lifecycle": {
      const params = createParamsSchema("workspaceId").parse(request.params);
      return handleWorkspaceLifecycle(dependencies, params.workspaceId, request, reply);
    }
    case "DELETE /internal/v1/workspaces/:workspaceId": {
      const params = createParamsSchema("workspaceId").parse(request.params);
      return handleDeleteWorkspace(dependencies, params.workspaceId, reply);
    }
    case "GET /internal/v1/workspaces/:workspaceId/entries": {
      const params = createParamsSchema("workspaceId").parse(request.params);
      return handleListWorkspaceEntries(dependencies, params.workspaceId, request, reply);
    }
    case "GET /internal/v1/workspaces/:workspaceId/files/content": {
      const params = createParamsSchema("workspaceId").parse(request.params);
      return handleGetWorkspaceFileContent(dependencies, params.workspaceId, request, reply);
    }
    case "PUT /internal/v1/workspaces/:workspaceId/files/content": {
      const params = createParamsSchema("workspaceId").parse(request.params);
      return handlePutWorkspaceFileContent(dependencies, params.workspaceId, request, reply);
    }
    case "PUT /internal/v1/workspaces/:workspaceId/files/upload": {
      const params = createParamsSchema("workspaceId").parse(request.params);
      return handleUploadWorkspaceFile(dependencies, params.workspaceId, request, reply);
    }
    case "GET /internal/v1/workspaces/:workspaceId/files/download": {
      const params = createParamsSchema("workspaceId").parse(request.params);
      return handleDownloadWorkspaceFile(dependencies, params.workspaceId, request, reply);
    }
    case "POST /internal/v1/workspaces/:workspaceId/directories": {
      const params = createParamsSchema("workspaceId").parse(request.params);
      return handleCreateWorkspaceDirectory(dependencies, params.workspaceId, request, reply);
    }
    case "DELETE /internal/v1/workspaces/:workspaceId/entries": {
      const params = createParamsSchema("workspaceId").parse(request.params);
      return handleDeleteWorkspaceEntry(dependencies, params.workspaceId, request, reply);
    }
    case "PATCH /internal/v1/workspaces/:workspaceId/entries/move": {
      const params = createParamsSchema("workspaceId").parse(request.params);
      return handleMoveWorkspaceEntry(dependencies, params.workspaceId, request, reply);
    }
    default:
      throw new AppError(404, "route_not_found", `Unsupported internal workspace route: ${request.method} ${routeUrl}`);
  }
}

export async function dispatchRegisteredWorkspaceRoute(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AppDependencies,
  options: AppRouteOptions
) {
  const routeUrl = readRegisteredRouteUrl(request);

  switch (`${request.method} ${routeUrl}`) {
    case "POST /api/v1/workspaces": {
      if (options.workspaceMode === "single") {
        throw new AppError(501, "workspace_creation_unavailable", "Workspace creation is not available in single-workspace mode.");
      }

      const input = createWorkspaceRequestSchema.parse(request.body);
      const ownerId = resolveOwnerId(input);
      const reservedPlacement = await reserveOwnerScopedWorkspacePlacement(
        dependencies,
        ownerId,
        ownerId ? createId("ws") : undefined
      );

      try {
        const workspace = await dependencies.runtimeService.createWorkspace({
          input: {
            ...input,
            ...(reservedPlacement.workspaceId ? { workspaceId: reservedPlacement.workspaceId } : {})
          } as typeof input & { workspaceId?: string | undefined }
        });
        if (ownerId && workspace.id !== reservedPlacement.workspaceId) {
          await dependencies.assignWorkspacePlacementOwnerAffinity?.({
            workspaceId: workspace.id,
            ownerId,
            overwrite: true
          });
        }
        return reply.status(201).send(projectWorkspaceForPublicApi(dependencies, workspace));
      } catch (error) {
        await reservedPlacement.release();
        throw error;
      }
    }
    case "POST /api/v1/workspaces/import": {
      if (options.workspaceMode === "single" || !dependencies.importWorkspace) {
        throw new AppError(501, "workspace_import_unavailable", "Workspace import is not available on this server.");
      }

      const body = request.body as Record<string, unknown> | null;
      const rootPath = typeof body?.rootPath === "string" ? body.rootPath : undefined;
      if (!rootPath) {
        throw new AppError(400, "invalid_request", "rootPath is required.");
      }

      const name = typeof body?.name === "string" ? body.name : undefined;
      const externalRef = typeof body?.externalRef === "string" ? body.externalRef : undefined;
      const ownerId = resolveOwnerId({
        ownerId: typeof body?.ownerId === "string" ? body.ownerId : undefined
      });
      const serviceName =
        typeof body?.serviceName === "string" && body.serviceName.trim().length > 0
          ? body.serviceName.trim().toLowerCase()
          : undefined;
      const workspace = await dependencies.importWorkspace({
        rootPath,
        kind: "project",
        ...(name ? { name } : {}),
        ...(externalRef ? { externalRef } : {}),
        ...(ownerId ? { ownerId } : {}),
        ...(serviceName ? { serviceName } : {})
      });
      if (ownerId) {
        await dependencies.assignWorkspacePlacementOwnerAffinity?.({
          workspaceId: workspace.id,
          ownerId,
          overwrite: true
        });
      }
      return reply.status(201).send(projectWorkspaceForPublicApi(dependencies, workspace));
    }
    case "POST /api/v1/local/workspaces/register": {
      assertLocalWorkspaceRegistrationAvailable(dependencies, options);
      const input = registerLocalWorkspaceRequestSchema.parse(request.body);
      const ownerId = resolveOwnerId(input);
      const workspace = await dependencies.registerLocalWorkspace!({
        rootPath: input.rootPath,
        ...(input.name ? { name: input.name } : {}),
        ...(input.runtime ? { runtime: input.runtime } : {}),
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
      return reply.status(201).send(projectWorkspaceForPublicApi(dependencies, workspace));
    }
    case "POST /api/v1/local/workspaces/:workspaceId/repair": {
      assertLocalWorkspaceRepairAvailable(dependencies, options);
      const params = createParamsSchema("workspaceId").parse(request.params);
      assertWorkspaceAccess(toCallerContext(request), params.workspaceId);
      const input = repairLocalWorkspaceRequestSchema.parse(request.body);
      const workspace = await dependencies.repairLocalWorkspace!({
        workspaceId: params.workspaceId,
        rootPath: input.rootPath,
        ...(input.name ? { name: input.name } : {})
      });
      return reply.send(projectWorkspaceForPublicApi(dependencies, workspace));
    }
    case "GET /api/v1/workspaces": {
      const query = pageQuerySchema.parse(request.query);
      const page = await dependencies.runtimeService.listWorkspaces(query.pageSize, query.cursor);
      return reply.send(workspacePageSchema.parse(projectWorkspacePageForPublicApi(dependencies, page)));
    }
    case "GET /api/v1/workspaces/:workspaceId": {
      const params = createParamsSchema("workspaceId").parse(request.params);
      assertWorkspaceAccess(toCallerContext(request), params.workspaceId);
      const workspace = await dependencies.runtimeService.getWorkspace(params.workspaceId);
      return reply.send(projectWorkspaceForPublicApi(dependencies, workspace));
    }
    case "DELETE /api/v1/workspaces/:workspaceId": {
      if (options.workspaceMode === "single") {
        throw new AppError(501, "workspace_deletion_unavailable", "Workspace deletion is not available in single-workspace mode.");
      }

      const params = createParamsSchema("workspaceId").parse(request.params);
      assertWorkspaceAccess(toCallerContext(request), params.workspaceId);
      if ((await guardWorkspaceOwnership(request, reply, dependencies, params.workspaceId)) !== "local") {
        return reply;
      }
      if (shouldDelegateSelfHostedWorkspaceOperation(dependencies)) {
        await proxyWorkspaceRequestToBaseUrl(request, reply, dependencies.sandboxOwnerFallbackBaseUrl!, {
          code: "workspace_delete_owner_unreachable",
          message: `Failed to reach a self-hosted worker to delete workspace ${params.workspaceId}.`,
          details: {
            workspaceId: params.workspaceId,
            routingHint: "self_hosted_worker"
          }
        });
        return reply;
      }
      return handleDeleteWorkspace(dependencies, params.workspaceId, reply);
    }
    case "GET /api/v1/workspaces/:workspaceId/catalog": {
      const params = createParamsSchema("workspaceId").parse(request.params);
      assertWorkspaceAccess(toCallerContext(request), params.workspaceId);
      const catalog = await dependencies.runtimeService.getWorkspaceCatalog(params.workspaceId);
      return reply.send(catalog);
    }
    case "GET /api/v1/workspaces/:workspaceId/entries": {
      const params = createParamsSchema("workspaceId").parse(request.params);
      assertWorkspaceAccess(toCallerContext(request), params.workspaceId);
      if ((await guardWorkspaceOwnership(request, reply, dependencies, params.workspaceId)) !== "local") {
        return reply;
      }
      return handleListWorkspaceEntries(dependencies, params.workspaceId, request, reply);
    }
    case "GET /api/v1/workspaces/:workspaceId/files/content": {
      const params = createParamsSchema("workspaceId").parse(request.params);
      assertWorkspaceAccess(toCallerContext(request), params.workspaceId);
      if ((await guardWorkspaceOwnership(request, reply, dependencies, params.workspaceId)) !== "local") {
        return reply;
      }
      return handleGetWorkspaceFileContent(dependencies, params.workspaceId, request, reply);
    }
    case "PUT /api/v1/workspaces/:workspaceId/files/content": {
      const params = createParamsSchema("workspaceId").parse(request.params);
      assertWorkspaceAccess(toCallerContext(request), params.workspaceId);
      if ((await guardWorkspaceOwnership(request, reply, dependencies, params.workspaceId)) !== "local") {
        return reply;
      }
      return handlePutWorkspaceFileContent(dependencies, params.workspaceId, request, reply);
    }
    case "PUT /api/v1/workspaces/:workspaceId/files/upload": {
      const params = createParamsSchema("workspaceId").parse(request.params);
      assertWorkspaceAccess(toCallerContext(request), params.workspaceId);
      if ((await guardWorkspaceOwnership(request, reply, dependencies, params.workspaceId)) !== "local") {
        return reply;
      }
      return handleUploadWorkspaceFile(dependencies, params.workspaceId, request, reply);
    }
    case "GET /api/v1/workspaces/:workspaceId/files/download": {
      const params = createParamsSchema("workspaceId").parse(request.params);
      assertWorkspaceAccess(toCallerContext(request), params.workspaceId);
      if ((await guardWorkspaceOwnership(request, reply, dependencies, params.workspaceId)) !== "local") {
        return reply;
      }
      return handleDownloadWorkspaceFile(dependencies, params.workspaceId, request, reply);
    }
    case "POST /api/v1/workspaces/:workspaceId/directories": {
      const params = createParamsSchema("workspaceId").parse(request.params);
      assertWorkspaceAccess(toCallerContext(request), params.workspaceId);
      if ((await guardWorkspaceOwnership(request, reply, dependencies, params.workspaceId)) !== "local") {
        return reply;
      }
      return handleCreateWorkspaceDirectory(dependencies, params.workspaceId, request, reply);
    }
    case "DELETE /api/v1/workspaces/:workspaceId/entries": {
      const params = createParamsSchema("workspaceId").parse(request.params);
      assertWorkspaceAccess(toCallerContext(request), params.workspaceId);
      if ((await guardWorkspaceOwnership(request, reply, dependencies, params.workspaceId)) !== "local") {
        return reply;
      }
      return handleDeleteWorkspaceEntry(dependencies, params.workspaceId, request, reply);
    }
    case "PATCH /api/v1/workspaces/:workspaceId/entries/move": {
      const params = createParamsSchema("workspaceId").parse(request.params);
      assertWorkspaceAccess(toCallerContext(request), params.workspaceId);
      if ((await guardWorkspaceOwnership(request, reply, dependencies, params.workspaceId)) !== "local") {
        return reply;
      }
      return handleMoveWorkspaceEntry(dependencies, params.workspaceId, request, reply);
    }
    case "POST /api/v1/workspaces/:workspaceId/sessions": {
      const params = createParamsSchema("workspaceId").parse(request.params);
      const caller = toCallerContext(request);
      assertWorkspaceAccess(caller, params.workspaceId);
      const input = createSessionRequestSchema.parse(request.body);
      const session = await dependencies.runtimeService.createSession({
        workspaceId: params.workspaceId,
        caller,
        input
      });

      return reply.status(201).send(session);
    }
    case "GET /api/v1/workspaces/:workspaceId/sessions": {
      const params = createParamsSchema("workspaceId").parse(request.params);
      assertWorkspaceAccess(toCallerContext(request), params.workspaceId);
      const query = pageQuerySchema.parse(request.query);
      const page = await dependencies.runtimeService.listWorkspaceSessions(params.workspaceId, query.pageSize, query.cursor);
      return reply.send(sessionPageSchema.parse(page));
    }
    case "POST /api/v1/workspaces/:workspaceId/actions/:actionName/runs": {
      const params = createParamsSchema("workspaceId", "actionName").parse(request.params);
      const caller = toCallerContext(request);
      assertWorkspaceAccess(caller, params.workspaceId);
      const input = createActionRunRequestSchema.parse(request.body) as {
        sessionId?: string;
        agentName?: string;
        input?: unknown;
        triggerSource?: "api" | "user";
      };
      const accepted = await dependencies.runtimeService.triggerActionRun({
        workspaceId: params.workspaceId,
        actionName: params.actionName,
        caller,
        sessionId: input.sessionId,
        agentName: input.agentName,
        input: input.input,
        triggerSource: input.triggerSource
      });
      return reply.status(202).send(accepted);
    }
    default:
      throw new AppError(404, "route_not_found", `Unsupported workspace route: ${request.method} ${routeUrl}`);
  }
}

export function registerInternalWorkspaceRoutes(app: FastifyInstance, dependencies: AppDependencies): void {
  app.delete("/internal/v1/workspaces/:workspaceId", async (request, reply) =>
    dispatchRegisteredInternalWorkspaceRoute(request, reply, dependencies)
  );
  app.get("/internal/v1/workspaces/:workspaceId/entries", async (request, reply) =>
    dispatchRegisteredInternalWorkspaceRoute(request, reply, dependencies)
  );
  app.get("/internal/v1/workspaces/:workspaceId/files/content", async (request, reply) =>
    dispatchRegisteredInternalWorkspaceRoute(request, reply, dependencies)
  );
  app.put("/internal/v1/workspaces/:workspaceId/files/content", async (request, reply) =>
    dispatchRegisteredInternalWorkspaceRoute(request, reply, dependencies)
  );
  app.put("/internal/v1/workspaces/:workspaceId/files/upload", async (request, reply) =>
    dispatchRegisteredInternalWorkspaceRoute(request, reply, dependencies)
  );
  app.get("/internal/v1/workspaces/:workspaceId/files/download", async (request, reply) =>
    dispatchRegisteredInternalWorkspaceRoute(request, reply, dependencies)
  );
  app.post("/internal/v1/workspaces/:workspaceId/directories", async (request, reply) =>
    dispatchRegisteredInternalWorkspaceRoute(request, reply, dependencies)
  );
  app.delete("/internal/v1/workspaces/:workspaceId/entries", async (request, reply) =>
    dispatchRegisteredInternalWorkspaceRoute(request, reply, dependencies)
  );
  app.patch("/internal/v1/workspaces/:workspaceId/entries/move", async (request, reply) =>
    dispatchRegisteredInternalWorkspaceRoute(request, reply, dependencies)
  );
}

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  dependencies: AppDependencies,
  options: AppRouteOptions
): void {
  app.post("/api/v1/workspaces", async (request, reply) =>
    dispatchRegisteredWorkspaceRoute(request, reply, dependencies, options)
  );
  app.post("/api/v1/workspaces/import", async (request, reply) =>
    dispatchRegisteredWorkspaceRoute(request, reply, dependencies, options)
  );
  app.post("/api/v1/local/workspaces/register", async (request, reply) =>
    dispatchRegisteredWorkspaceRoute(request, reply, dependencies, options)
  );
  app.post("/api/v1/local/workspaces/:workspaceId/repair", async (request, reply) =>
    dispatchRegisteredWorkspaceRoute(request, reply, dependencies, options)
  );
  app.get("/api/v1/workspaces", async (request, reply) =>
    dispatchRegisteredWorkspaceRoute(request, reply, dependencies, options)
  );
  app.get("/api/v1/workspaces/:workspaceId", async (request, reply) =>
    dispatchRegisteredWorkspaceRoute(request, reply, dependencies, options)
  );
  app.delete("/api/v1/workspaces/:workspaceId", async (request, reply) =>
    dispatchRegisteredWorkspaceRoute(request, reply, dependencies, options)
  );
  app.get("/api/v1/workspaces/:workspaceId/catalog", async (request, reply) =>
    dispatchRegisteredWorkspaceRoute(request, reply, dependencies, options)
  );
  app.get("/api/v1/workspaces/:workspaceId/entries", async (request, reply) =>
    dispatchRegisteredWorkspaceRoute(request, reply, dependencies, options)
  );
  app.get("/api/v1/workspaces/:workspaceId/files/content", async (request, reply) =>
    dispatchRegisteredWorkspaceRoute(request, reply, dependencies, options)
  );
  app.put("/api/v1/workspaces/:workspaceId/files/content", async (request, reply) =>
    dispatchRegisteredWorkspaceRoute(request, reply, dependencies, options)
  );
  app.put("/api/v1/workspaces/:workspaceId/files/upload", async (request, reply) =>
    dispatchRegisteredWorkspaceRoute(request, reply, dependencies, options)
  );
  app.get("/api/v1/workspaces/:workspaceId/files/download", async (request, reply) =>
    dispatchRegisteredWorkspaceRoute(request, reply, dependencies, options)
  );
  app.post("/api/v1/workspaces/:workspaceId/directories", async (request, reply) =>
    dispatchRegisteredWorkspaceRoute(request, reply, dependencies, options)
  );
  app.delete("/api/v1/workspaces/:workspaceId/entries", async (request, reply) =>
    dispatchRegisteredWorkspaceRoute(request, reply, dependencies, options)
  );
  app.patch("/api/v1/workspaces/:workspaceId/entries/move", async (request, reply) =>
    dispatchRegisteredWorkspaceRoute(request, reply, dependencies, options)
  );
  app.post("/api/v1/workspaces/:workspaceId/sessions", async (request, reply) =>
    dispatchRegisteredWorkspaceRoute(request, reply, dependencies, options)
  );
  app.get("/api/v1/workspaces/:workspaceId/sessions", async (request, reply) =>
    dispatchRegisteredWorkspaceRoute(request, reply, dependencies, options)
  );
  app.post("/api/v1/workspaces/:workspaceId/actions/:actionName/runs", async (request, reply) =>
    dispatchRegisteredWorkspaceRoute(request, reply, dependencies, options)
  );
}
