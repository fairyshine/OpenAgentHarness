import { Readable } from "node:stream";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
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
import { AppError } from "@oah/runtime-core";

import { assertWorkspaceAccess, createParamsSchema, sendError, toCallerContext } from "../context.js";
import type { AppDependencies, AppRouteOptions } from "../types.js";

type WorkspaceOwnership = Awaited<ReturnType<NonNullable<AppDependencies["resolveWorkspaceOwnership"]>>>;

function resolveWorkspaceOwnerId(input: { ownerId?: string | undefined; userId?: string | undefined }): string | undefined {
  const ownerId = input.ownerId?.trim();
  if (ownerId) {
    return ownerId;
  }

  const userId = input.userId?.trim();
  return userId && userId.length > 0 ? userId : undefined;
}

function copyProxyResponseHeaders(reply: FastifyReply, headers: Headers): void {
  for (const [name, value] of headers.entries()) {
    if (name === "transfer-encoding" || name === "connection" || name === "keep-alive") {
      continue;
    }

    reply.header(name, value);
  }
}

function buildOwnerWorkspaceProxyUrl(ownerBaseUrl: string, request: FastifyRequest): string {
  const targetPath = (request.raw.url ?? request.url).replace(/^\/api\/v1\/workspaces/u, "/internal/v1/workspaces");
  return `${ownerBaseUrl.replace(/\/+$/u, "")}${targetPath}`;
}

function buildOwnerWorkspaceProxyHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  const contentType = request.headers["content-type"];
  if (typeof contentType === "string" && contentType.length > 0) {
    headers.set("content-type", contentType);
  }

  const accept = request.headers.accept;
  if (typeof accept === "string" && accept.length > 0) {
    headers.set("accept", accept);
  }

  const ifMatch = request.headers["if-match"];
  if (typeof ifMatch === "string" && ifMatch.length > 0) {
    headers.set("if-match", ifMatch);
  }

  return headers;
}

function buildOwnerWorkspaceProxyBody(request: FastifyRequest): Buffer | string | undefined {
  if (request.method === "GET" || request.method === "HEAD") {
    return undefined;
  }

  if (Buffer.isBuffer(request.body)) {
    return request.body;
  }

  if (typeof request.body === "string") {
    return request.body;
  }

  if (request.body === undefined || request.body === null) {
    return undefined;
  }

  return JSON.stringify(request.body);
}

async function proxyWorkspaceRequestToOwner(
  request: FastifyRequest,
  reply: FastifyReply,
  ownership: NonNullable<WorkspaceOwnership>
): Promise<void> {
  if (!ownership.ownerBaseUrl) {
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
    const body = buildOwnerWorkspaceProxyBody(request);
    const response = await fetch(buildOwnerWorkspaceProxyUrl(ownership.ownerBaseUrl, request), {
      method: request.method,
      headers: buildOwnerWorkspaceProxyHeaders(request),
      ...(body !== undefined ? { body } : {})
    });

    reply.status(response.status);
    copyProxyResponseHeaders(reply, response.headers);
    if (!response.body) {
      await reply.send();
      return;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      await reply.send(await response.text());
      return;
    }

    await reply.send(Readable.fromWeb(response.body as never));
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
    await proxyWorkspaceRequestToOwner(request, reply, ownership);
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

export function registerInternalWorkspaceRoutes(app: FastifyInstance, dependencies: AppDependencies): void {
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
    const workspace = await dependencies.runtimeService.createWorkspace({ input });
    const ownerId = resolveWorkspaceOwnerId(input);
    if (ownerId) {
      await dependencies.assignWorkspacePlacementUser?.({
        workspaceId: workspace.id,
        userId: ownerId,
        overwrite: true
      });
    }
    return reply.status(201).send(workspace);
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
    const ownerId = resolveWorkspaceOwnerId({
      ownerId: typeof body?.ownerId === "string" ? body.ownerId : undefined,
      userId: typeof body?.userId === "string" ? body.userId : undefined
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
      await dependencies.assignWorkspacePlacementUser?.({
        workspaceId: workspace.id,
        userId: ownerId,
        overwrite: true
      });
    }
    return reply.status(201).send(workspace);
  });

  app.get("/api/v1/workspaces", async (request, reply) => {
    const query = pageQuerySchema.parse(request.query);
    const page = await dependencies.runtimeService.listWorkspaces(query.pageSize, query.cursor);
    return reply.send(workspacePageSchema.parse(page));
  });

  app.get("/api/v1/workspaces/:workspaceId", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    assertWorkspaceAccess(toCallerContext(request), params.workspaceId);
    const workspace = await dependencies.runtimeService.getWorkspace(params.workspaceId);
    return reply.send(workspace);
  });

  app.delete("/api/v1/workspaces/:workspaceId", async (request, reply) => {
    if (options.workspaceMode === "single") {
      throw new AppError(501, "workspace_deletion_unavailable", "Workspace deletion is not available in single-workspace mode.");
    }

    const params = createParamsSchema("workspaceId").parse(request.params);
    assertWorkspaceAccess(toCallerContext(request), params.workspaceId);
    await dependencies.runtimeService.deleteWorkspace(params.workspaceId);
    return reply.status(204).send();
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
    await dependencies.assignWorkspacePlacementUser?.({
      workspaceId: params.workspaceId,
      userId: caller.subjectRef,
      overwrite: false
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
