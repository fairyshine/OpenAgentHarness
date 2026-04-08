import { createReadStream } from "node:fs";

import type { FastifyInstance } from "fastify";

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
  workspaceHistoryMirrorStatusSchema,
  workspacePageSchema
} from "@oah/api-contracts";
import { AppError } from "@oah/runtime-core";

import { createParamsSchema, toCallerContext } from "../context.js";
import type { AppDependencies, AppRouteOptions } from "../types.js";
import { inspectHistoryMirrorStatus } from "../../history-mirror.js";

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

    const kind = body?.kind === "chat" ? "chat" : "project";
    const name = typeof body?.name === "string" ? body.name : undefined;
    const externalRef = typeof body?.externalRef === "string" ? body.externalRef : undefined;
    const workspace = await dependencies.importWorkspace({
      rootPath,
      kind,
      ...(name ? { name } : {}),
      ...(externalRef ? { externalRef } : {})
    });
    return reply.status(201).send(workspace);
  });

  app.get("/api/v1/workspaces", async (request, reply) => {
    const query = pageQuerySchema.parse(request.query);
    const page = await dependencies.runtimeService.listWorkspaces(query.pageSize, query.cursor);
    return reply.send(workspacePageSchema.parse(page));
  });

  app.get("/api/v1/workspaces/:workspaceId", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    const workspace = await dependencies.runtimeService.getWorkspace(params.workspaceId);
    return reply.send(workspace);
  });

  app.get("/api/v1/workspaces/:workspaceId/history-mirror", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    const workspace = await dependencies.runtimeService.getWorkspaceRecord(params.workspaceId);
    const status = dependencies.getWorkspaceHistoryMirrorStatus
      ? await dependencies.getWorkspaceHistoryMirrorStatus(workspace)
      : await inspectHistoryMirrorStatus(workspace);
    return reply.send(workspaceHistoryMirrorStatusSchema.parse(status));
  });

  app.post("/api/v1/workspaces/:workspaceId/history-mirror/rebuild", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    const workspace = await dependencies.runtimeService.getWorkspaceRecord(params.workspaceId);

    if (workspace.kind !== "project") {
      throw new AppError(
        400,
        "history_mirror_not_supported",
        `Workspace ${params.workspaceId} does not support local history mirror sync.`
      );
    }

    if (!dependencies.rebuildWorkspaceHistoryMirror) {
      throw new AppError(501, "history_mirror_rebuild_unavailable", "History mirror rebuild is not available on this server.");
    }

    const status = await dependencies.rebuildWorkspaceHistoryMirror(workspace);
    return reply.send(workspaceHistoryMirrorStatusSchema.parse(status));
  });

  app.delete("/api/v1/workspaces/:workspaceId", async (request, reply) => {
    if (options.workspaceMode === "single") {
      throw new AppError(501, "workspace_deletion_unavailable", "Workspace deletion is not available in single-workspace mode.");
    }

    const params = createParamsSchema("workspaceId").parse(request.params);
    await dependencies.runtimeService.deleteWorkspace(params.workspaceId);
    return reply.status(204).send();
  });

  app.get("/api/v1/workspaces/:workspaceId/catalog", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    const catalog = await dependencies.runtimeService.getWorkspaceCatalog(params.workspaceId);
    return reply.send(catalog);
  });

  app.get("/api/v1/workspaces/:workspaceId/entries", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    const query = workspaceEntriesQuerySchema.parse(request.query);
    const page = await dependencies.runtimeService.listWorkspaceEntries(params.workspaceId, query);
    return reply.send(workspaceEntryPageSchema.parse(page));
  });

  app.get("/api/v1/workspaces/:workspaceId/files/content", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    const query = workspaceFileContentQuerySchema.parse(request.query);
    const file = await dependencies.runtimeService.getWorkspaceFileContent(params.workspaceId, query);
    return reply.send(workspaceFileContentSchema.parse(file));
  });

  app.put("/api/v1/workspaces/:workspaceId/files/content", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    const input = putWorkspaceFileRequestSchema.parse(request.body);
    const entry = await dependencies.runtimeService.putWorkspaceFileContent(params.workspaceId, {
      path: input.path,
      content: input.content,
      encoding: input.encoding,
      overwrite: input.overwrite,
      ...(input.ifMatch !== undefined ? { ifMatch: input.ifMatch } : {})
    });
    return reply.send(workspaceEntrySchema.parse(entry));
  });

  app.put("/api/v1/workspaces/:workspaceId/files/upload", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    const query = workspaceFileUploadQuerySchema.parse(request.query);
    if (!Buffer.isBuffer(request.body)) {
      throw new AppError(415, "invalid_upload_content_type", "File upload requires Content-Type: application/octet-stream.");
    }

    const entry = await dependencies.runtimeService.uploadWorkspaceFile(params.workspaceId, {
      path: query.path,
      data: request.body,
      overwrite: query.overwrite,
      ...(query.ifMatch !== undefined ? { ifMatch: query.ifMatch } : {})
    });
    return reply.send(workspaceEntrySchema.parse(entry));
  });

  app.get("/api/v1/workspaces/:workspaceId/files/download", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    const query = workspaceEntryPathQuerySchema.parse(request.query);
    const file = await dependencies.runtimeService.getWorkspaceFileDownload(params.workspaceId, query.path);

    reply.header("Content-Type", file.mimeType ?? "application/octet-stream");
    reply.header("Content-Length", String(file.sizeBytes));
    reply.header("ETag", file.etag);
    reply.header("Last-Modified", file.updatedAt);
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    return reply.send(createReadStream(file.absolutePath));
  });

  app.post("/api/v1/workspaces/:workspaceId/directories", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    const input = createWorkspaceDirectoryRequestSchema.parse(request.body);
    const entry = await dependencies.runtimeService.createWorkspaceDirectory(params.workspaceId, input);
    return reply.status(201).send(workspaceEntrySchema.parse(entry));
  });

  app.delete("/api/v1/workspaces/:workspaceId/entries", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    const query = workspaceDeleteEntryQuerySchema.parse(request.query);
    const result = await dependencies.runtimeService.deleteWorkspaceEntry(params.workspaceId, query);
    return reply.send(workspaceDeleteResultSchema.parse(result));
  });

  app.patch("/api/v1/workspaces/:workspaceId/entries/move", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    const input = moveWorkspaceEntryRequestSchema.parse(request.body);
    const entry = await dependencies.runtimeService.moveWorkspaceEntry(params.workspaceId, input);
    return reply.send(workspaceEntrySchema.parse(entry));
  });

  app.post("/api/v1/workspaces/:workspaceId/sessions", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    const input = createSessionRequestSchema.parse(request.body);
    const session = await dependencies.runtimeService.createSession({
      workspaceId: params.workspaceId,
      caller: toCallerContext(request),
      input
    });

    return reply.status(201).send(session);
  });

  app.get("/api/v1/workspaces/:workspaceId/sessions", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    const query = pageQuerySchema.parse(request.query);
    const page = await dependencies.runtimeService.listWorkspaceSessions(params.workspaceId, query.pageSize, query.cursor);
    return reply.send(sessionPageSchema.parse(page));
  });

  app.post("/api/v1/workspaces/:workspaceId/actions/:actionName/runs", async (request, reply) => {
    const params = createParamsSchema("workspaceId", "actionName").parse(request.params);
    const input = createActionRunRequestSchema.parse(request.body);
    const accepted = await dependencies.runtimeService.triggerActionRun({
      workspaceId: params.workspaceId,
      actionName: params.actionName,
      caller: toCallerContext(request),
      sessionId: input.sessionId,
      agentName: input.agentName,
      input: input.input
    });
    return reply.status(202).send(accepted);
  });
}
