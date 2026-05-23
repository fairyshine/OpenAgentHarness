import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  createWorkspaceDirectoryRequestSchema,
  moveWorkspaceEntryRequestSchema,
  putWorkspaceFileRequestSchema,
  workspaceDeleteEntryQuerySchema,
  workspaceDeleteResultSchema,
  workspaceEntryPageSchema,
  workspaceEntryPathQuerySchema,
  workspaceEntrySchema,
  workspaceFileContentQuerySchema,
  workspaceFileContentSchema,
  workspaceFileUploadQuerySchema
} from "@oah/api-contracts";
import { AppError } from "@oah/engine-core";

import { hasErrorCode } from "../../bootstrap/error-codes.js";
import { createParamsSchema } from "../context.js";
import { readRequestBodyBuffer } from "../proxy-utils.js";
import type { AppDependencies } from "../types.js";
import { listWorkspaceEntriesWithFastPath, parseWorkspaceEntriesQuery } from "../workspace-entry-listing.js";

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

async function touchWorkspaceActivity(dependencies: AppDependencies, workspaceId: string): Promise<void> {
  await dependencies.touchWorkspaceActivity?.(workspaceId);
}

function touchWorkspaceActivityLater(dependencies: AppDependencies, workspaceId: string): void {
  void dependencies.touchWorkspaceActivity?.(workspaceId).catch((error) => {
    if (dependencies.logger) {
      console.warn(`[oah-http] Failed to touch workspace activity for ${workspaceId}:`, error);
    }
  });
}

async function handleListWorkspaceEntries(
  dependencies: AppDependencies,
  workspaceId: string,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const query = parseWorkspaceEntriesQuery(request);
  const page = await listWorkspaceEntriesWithFastPath(dependencies, {
    workspaceId,
    query,
    logLabel: "internal workspace"
  });
  touchWorkspaceActivityLater(dependencies, workspaceId);
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
  touchWorkspaceActivityLater(dependencies, workspaceId);
  return reply.send(workspaceFileContentSchema.parse(file));
}

async function handlePutWorkspaceFileContent(
  dependencies: AppDependencies,
  workspaceId: string,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const parsed = putWorkspaceFileRequestSchema.parse(request.body);
  const entry = await dependencies.runtimeService.putWorkspaceFileContent(workspaceId, {
    path: parsed.path,
    content: parsed.content,
    encoding: parsed.encoding ?? "utf8",
    overwrite: parsed.overwrite,
    ...(parsed.ifMatch !== undefined ? { ifMatch: parsed.ifMatch } : {})
  });
  await touchWorkspaceActivity(dependencies, workspaceId);
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
  await touchWorkspaceActivity(dependencies, workspaceId);
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
  await touchWorkspaceActivity(dependencies, workspaceId);
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
  await touchWorkspaceActivity(dependencies, workspaceId);
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
  await touchWorkspaceActivity(dependencies, workspaceId);
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
  await touchWorkspaceActivity(dependencies, workspaceId);
  return reply.send(workspaceEntrySchema.parse(entry));
}

export function registerInternalWorkspaceRoutes(app: FastifyInstance, dependencies: AppDependencies): void {
  app.post("/internal/v1/workspaces/:workspaceId/lifecycle", async (request, reply) => {
    if (!dependencies.workspaceLifecycle) {
      throw new AppError(501, "workspace_lifecycle_unavailable", "Workspace lifecycle operations are not available on this server.");
    }

    const params = createParamsSchema("workspaceId").parse(request.params);
    const input = parseWorkspaceLifecycleRequest(request.body);
    const result = await dependencies.workspaceLifecycle.execute({
      workspaceId: params.workspaceId,
      operation: input.operation,
      ...(input.force !== undefined ? { force: input.force } : {})
    });
    return reply.send(result);
  });

  app.delete("/internal/v1/workspaces/:workspaceId", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    try {
      await dependencies.runtimeService.deleteWorkspace(params.workspaceId);
    } catch (error) {
      if (!hasErrorCode(error, "workspace_not_found")) {
        throw error;
      }
    }

    await dependencies.clearWorkspaceCoordination?.(params.workspaceId);
    await touchWorkspaceActivity(dependencies, params.workspaceId);
    return reply.status(204).send();
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
