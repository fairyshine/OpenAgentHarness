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
  buildProxyHeaders,
  resolveOwnerId,
  sendProxyResponse
} from "../proxy-utils.js";
import type { AppDependencies, AppRouteOptions } from "../types.js";

type WorkspaceOwnership = Awaited<ReturnType<NonNullable<AppDependencies["resolveWorkspaceOwnership"]>>>;

function resolveWorkspaceOwnerBaseUrl(
  dependencies: Pick<AppDependencies, "sandboxOwnerFallbackBaseUrl">,
  ownership: NonNullable<WorkspaceOwnership>
): string | undefined {
  return ownership.ownerBaseUrl ?? dependencies.sandboxOwnerFallbackBaseUrl;
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
      {
        method: request.method,
        headers: buildProxyHeaders(request),
        ...(body !== undefined ? { body } : {})
      }
    );

    await sendProxyResponse(reply, response);
  } catch (error) {
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

async function guardWorkspaceOwnership(
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
  const page = await dependencies.runtimeService.listWorkspaceEntries(workspaceId, query);
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
  if (!Buffer.isBuffer(request.body)) {
    throw new AppError(415, "invalid_upload_content_type", "File upload requires Content-Type: application/octet-stream.");
  }

  const entry = await dependencies.runtimeService.uploadWorkspaceFile(workspaceId, {
    path: query.path,
    data: request.body,
    overwrite: query.overwrite,
    ...(query.ifMatch !== undefined ? { ifMatch: query.ifMatch } : {})
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

export function registerInternalWorkspaceRoutes(app: FastifyInstance, dependencies: AppDependencies): void {
  app.delete("/internal/v1/workspaces/:workspaceId", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    return handleDeleteWorkspace(dependencies, params.workspaceId, reply);
  });

  app.get("/internal/v1/workspaces/:workspaceId/entries", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    return handleListWorkspaceEntries(dependencies, params.workspaceId, request, reply);
  });

  app.get("/internal/v1/workspaces/:workspaceId/files/content", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    return handleGetWorkspaceFileContent(dependencies, params.workspaceId, request, reply);
  });

  app.put("/internal/v1/workspaces/:workspaceId/files/content", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    return handlePutWorkspaceFileContent(dependencies, params.workspaceId, request, reply);
  });

  app.put("/internal/v1/workspaces/:workspaceId/files/upload", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    return handleUploadWorkspaceFile(dependencies, params.workspaceId, request, reply);
  });

  app.get("/internal/v1/workspaces/:workspaceId/files/download", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    return handleDownloadWorkspaceFile(dependencies, params.workspaceId, request, reply);
  });

  app.post("/internal/v1/workspaces/:workspaceId/directories", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    return handleCreateWorkspaceDirectory(dependencies, params.workspaceId, request, reply);
  });

  app.delete("/internal/v1/workspaces/:workspaceId/entries", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    return handleDeleteWorkspaceEntry(dependencies, params.workspaceId, request, reply);
  });

  app.patch("/internal/v1/workspaces/:workspaceId/entries/move", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    return handleMoveWorkspaceEntry(dependencies, params.workspaceId, request, reply);
  });
}

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  dependencies: AppDependencies,
  options: AppRouteOptions
): void {
  app.post("/api/v1/workspaces", async (request, reply) => {
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
  });

  app.post("/api/v1/workspaces/import", async (request, reply) => {
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
  });

  app.get("/api/v1/workspaces", async (request, reply) => {
    const query = pageQuerySchema.parse(request.query);
    const page = await dependencies.runtimeService.listWorkspaces(query.pageSize, query.cursor);
    return reply.send(workspacePageSchema.parse(projectWorkspacePageForPublicApi(dependencies, page)));
  });

  app.get("/api/v1/workspaces/:workspaceId", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    assertWorkspaceAccess(toCallerContext(request), params.workspaceId);
    const workspace = await dependencies.runtimeService.getWorkspace(params.workspaceId);
    return reply.send(projectWorkspaceForPublicApi(dependencies, workspace));
  });

  app.delete("/api/v1/workspaces/:workspaceId", async (request, reply) => {
    if (options.workspaceMode === "single") {
      throw new AppError(501, "workspace_deletion_unavailable", "Workspace deletion is not available in single-workspace mode.");
    }

    const params = createParamsSchema("workspaceId").parse(request.params);
    assertWorkspaceAccess(toCallerContext(request), params.workspaceId);
    if ((await guardWorkspaceOwnership(request, reply, dependencies, params.workspaceId)) !== "local") {
      return reply;
    }
    return handleDeleteWorkspace(dependencies, params.workspaceId, reply);
  });

  app.get("/api/v1/workspaces/:workspaceId/catalog", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    assertWorkspaceAccess(toCallerContext(request), params.workspaceId);
    const catalog = await dependencies.runtimeService.getWorkspaceCatalog(params.workspaceId);
    return reply.send(catalog);
  });

  app.get("/api/v1/workspaces/:workspaceId/entries", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    assertWorkspaceAccess(toCallerContext(request), params.workspaceId);
    if ((await guardWorkspaceOwnership(request, reply, dependencies, params.workspaceId)) !== "local") {
      return reply;
    }
    return handleListWorkspaceEntries(dependencies, params.workspaceId, request, reply);
  });

  app.get("/api/v1/workspaces/:workspaceId/files/content", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    assertWorkspaceAccess(toCallerContext(request), params.workspaceId);
    if ((await guardWorkspaceOwnership(request, reply, dependencies, params.workspaceId)) !== "local") {
      return reply;
    }
    return handleGetWorkspaceFileContent(dependencies, params.workspaceId, request, reply);
  });

  app.put("/api/v1/workspaces/:workspaceId/files/content", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    assertWorkspaceAccess(toCallerContext(request), params.workspaceId);
    if ((await guardWorkspaceOwnership(request, reply, dependencies, params.workspaceId)) !== "local") {
      return reply;
    }
    return handlePutWorkspaceFileContent(dependencies, params.workspaceId, request, reply);
  });

  app.put("/api/v1/workspaces/:workspaceId/files/upload", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    assertWorkspaceAccess(toCallerContext(request), params.workspaceId);
    if ((await guardWorkspaceOwnership(request, reply, dependencies, params.workspaceId)) !== "local") {
      return reply;
    }
    return handleUploadWorkspaceFile(dependencies, params.workspaceId, request, reply);
  });

  app.get("/api/v1/workspaces/:workspaceId/files/download", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    assertWorkspaceAccess(toCallerContext(request), params.workspaceId);
    if ((await guardWorkspaceOwnership(request, reply, dependencies, params.workspaceId)) !== "local") {
      return reply;
    }
    return handleDownloadWorkspaceFile(dependencies, params.workspaceId, request, reply);
  });

  app.post("/api/v1/workspaces/:workspaceId/directories", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    assertWorkspaceAccess(toCallerContext(request), params.workspaceId);
    if ((await guardWorkspaceOwnership(request, reply, dependencies, params.workspaceId)) !== "local") {
      return reply;
    }
    return handleCreateWorkspaceDirectory(dependencies, params.workspaceId, request, reply);
  });

  app.delete("/api/v1/workspaces/:workspaceId/entries", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    assertWorkspaceAccess(toCallerContext(request), params.workspaceId);
    if ((await guardWorkspaceOwnership(request, reply, dependencies, params.workspaceId)) !== "local") {
      return reply;
    }
    return handleDeleteWorkspaceEntry(dependencies, params.workspaceId, request, reply);
  });

  app.patch("/api/v1/workspaces/:workspaceId/entries/move", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    assertWorkspaceAccess(toCallerContext(request), params.workspaceId);
    if ((await guardWorkspaceOwnership(request, reply, dependencies, params.workspaceId)) !== "local") {
      return reply;
    }
    return handleMoveWorkspaceEntry(dependencies, params.workspaceId, request, reply);
  });

  app.post("/api/v1/workspaces/:workspaceId/sessions", async (request, reply) => {
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
  });

  app.get("/api/v1/workspaces/:workspaceId/sessions", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    assertWorkspaceAccess(toCallerContext(request), params.workspaceId);
    const query = pageQuerySchema.parse(request.query);
    const page = await dependencies.runtimeService.listWorkspaceSessions(params.workspaceId, query.pageSize, query.cursor);
    return reply.send(sessionPageSchema.parse(page));
  });

  app.post("/api/v1/workspaces/:workspaceId/actions/:actionName/runs", async (request, reply) => {
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
  });
}
