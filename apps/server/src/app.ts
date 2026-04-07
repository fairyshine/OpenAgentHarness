import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import {
  cancelRunAcceptedSchema,
  createActionRunRequestSchema,
  createMessageRequestSchema,
  createSessionRequestSchema,
  createWorkspaceRequestSchema,
  errorResponseSchema,
  messageAcceptedSchema,
  modelGenerateRequestSchema,
  modelGenerateResponseSchema,
  platformModelListSchema,
  modelProviderListSchema,
  pageQuerySchema,
  storageOverviewSchema,
  storagePostgresTableNameSchema,
  storagePostgresTablePageSchema,
  storageRedisDeleteKeyResponseSchema,
  storageRedisDeleteKeysRequestSchema,
  storageRedisDeleteKeysResponseSchema,
  storageRedisKeyDetailSchema,
  storageRedisKeyPageSchema,
  storageRedisKeyQuerySchema,
  storageRedisKeysQuerySchema,
  storageRedisMaintenanceRequestSchema,
  storageRedisMaintenanceResponseSchema,
  storageTableQuerySchema,
  runEventsQuerySchema,
  runStepPageSchema,
  sessionPageSchema,
  updateSessionRequestSchema,
  updateWorkspaceSettingsRequestSchema,
  workspaceHistoryMirrorStatusSchema,
  workspacePageSchema,
  workspaceTemplateListSchema
} from "@oah/api-contracts";
import { SUPPORTED_MODEL_PROVIDERS } from "@oah/model-gateway";
import type { CallerContext, ModelGateway, RuntimeService, SessionEvent, WorkspaceRecord } from "@oah/runtime-core";
import { AppError, isAppError } from "@oah/runtime-core";
import { inspectHistoryMirrorStatus, type HistoryMirrorStatus } from "./history-mirror.js";
import type { StorageAdmin } from "./storage-admin.js";

declare module "fastify" {
  interface FastifyRequest {
    callerContext?: CallerContext;
  }
}

function sendError(reply: FastifyReply, statusCode: number, code: string, message: string, details?: Record<string, unknown>) {
  return reply.status(statusCode).send(
    errorResponseSchema.parse({
      error: {
        code,
        message,
        ...(details ? { details } : {})
      }
    })
  );
}

function writeSseEvent(reply: FastifyReply, event: string, data: Record<string, unknown>, cursor?: string): void {
  if (cursor) {
    reply.raw.write(`id: ${cursor}\n`);
  }

  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) {
    return false;
  }

  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function toCallerContext(request: FastifyRequest): CallerContext {
  if (!request.callerContext) {
    throw new AppError(401, "unauthorized", "Missing caller context.");
  }

  return request.callerContext;
}

function createStandaloneCallerContext(): CallerContext {
  return {
    subjectRef: "standalone:anonymous",
    authSource: "standalone_server",
    scopes: [],
    workspaceAccess: []
  };
}

export interface AppDependencies {
  runtimeService: RuntimeService;
  modelGateway: ModelGateway;
  defaultModel: string;
  logger?: boolean;
  workspaceMode?: "multi" | "single";
  resolveCallerContext?: ((request: FastifyRequest) => Promise<CallerContext | undefined> | CallerContext | undefined) | undefined;
  listWorkspaceTemplates?: (() => Promise<import("@oah/config").WorkspaceTemplateDescriptor[]>) | undefined;
  listPlatformModels?: (() => Promise<
    Array<{
      id: string;
      provider: string;
      modelName: string;
      url?: string;
      hasKey: boolean;
      metadata?: Record<string, unknown>;
      isDefault: boolean;
    }>
  >) | undefined;
  importWorkspace?: (input: {
    rootPath: string;
    kind?: "project" | "chat";
    name?: string;
    externalRef?: string;
  }) => Promise<import("@oah/api-contracts").Workspace>;
  healthCheck?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  readinessCheck?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  getWorkspaceHistoryMirrorStatus?: (workspace: WorkspaceRecord) => Promise<HistoryMirrorStatus>;
  rebuildWorkspaceHistoryMirror?: (workspace: WorkspaceRecord) => Promise<HistoryMirrorStatus>;
  storageAdmin?: StorageAdmin;
}

export function createApp(dependencies: AppDependencies) {
  const app = Fastify({
    logger: dependencies.logger ?? true
  });
  const hostOwnsCallerContext = Boolean(dependencies.resolveCallerContext);
  const workspaceMode = dependencies.workspaceMode ?? "multi";

  app.setErrorHandler((error, _request, reply) => {
    if (isAppError(error)) {
      void sendError(reply, error.statusCode, error.code, error.message, error.details);
      return;
    }

    app.log.error(error);
    void sendError(reply, 500, "internal_error", error instanceof Error ? error.message : "Unknown server error.");
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/healthz" || request.url === "/readyz") {
      return;
    }

    if (request.url.startsWith("/internal/v1/models/")) {
      const remoteAddress = request.ip || request.raw.socket.remoteAddress;
      if (!isLoopbackAddress(remoteAddress)) {
        await sendError(reply, 403, "forbidden", "Internal model routes are only available from loopback addresses.");
        return reply;
      }

      return;
    }

    if (!request.url.startsWith("/api/v1/")) {
      return;
    }

    const resolvedCallerContext = await dependencies.resolveCallerContext?.(request);
    if (resolvedCallerContext) {
      request.callerContext = resolvedCallerContext;
      return;
    }

    if (!hostOwnsCallerContext) {
      request.callerContext = createStandaloneCallerContext();
      return;
    }

    await sendError(reply, 401, "unauthorized", "Missing caller context.");
    return reply;
  });

  app.get("/healthz", async () =>
    dependencies.healthCheck
      ? dependencies.healthCheck()
      : {
          status: "ok"
        }
  );

  app.get("/readyz", async (_request, reply) => {
    const payload = dependencies.readinessCheck
      ? await dependencies.readinessCheck()
      : {
          status: "ready"
        };

    if (payload.status === "not_ready") {
      return reply.status(503).send(payload);
    }

    return reply.send(payload);
  });

  app.get("/api/v1/workspace-templates", async (_request, reply) => {
    if (workspaceMode === "single" || !dependencies.listWorkspaceTemplates) {
      throw new AppError(501, "workspace_templates_unavailable", "Workspace templates are not available on this server.");
    }

    const templates = await dependencies.listWorkspaceTemplates();
    return reply.send(
      workspaceTemplateListSchema.parse({
        items: templates
      })
    );
  });

  app.get("/api/v1/model-providers", async (_request, reply) =>
    reply.send(
      modelProviderListSchema.parse({
        items: SUPPORTED_MODEL_PROVIDERS
      })
    )
  );

  app.get("/api/v1/platform-models", async (_request, reply) => {
    if (!dependencies.listPlatformModels) {
      throw new AppError(404, "platform_models_unavailable", "Platform models are not available.");
    }

    const items = await dependencies.listPlatformModels();
    return reply.send(
      platformModelListSchema.parse({
        items
      })
    );
  });

  app.get("/api/v1/storage/overview", async (_request, reply) => {
    if (!dependencies.storageAdmin) {
      throw new AppError(501, "storage_admin_unavailable", "Storage admin is unavailable on this server.");
    }

    return reply.send(storageOverviewSchema.parse(await dependencies.storageAdmin.overview()));
  });

  app.get("/api/v1/storage/postgres/tables/:table", async (request, reply) => {
    if (!dependencies.storageAdmin) {
      throw new AppError(501, "storage_admin_unavailable", "Storage admin is unavailable on this server.");
    }

    const params = createParamsSchema("table").parse(request.params);
    const query = storageTableQuerySchema.parse(request.query);
    const table = storagePostgresTableNameSchema.parse(params.table);
    return reply.send(
      storagePostgresTablePageSchema.parse(
        await dependencies.storageAdmin.postgresTable(table, {
          limit: query.limit,
          offset: query.offset,
          ...(query.q ? { q: query.q } : {}),
          ...(query.workspaceId ? { workspaceId: query.workspaceId } : {}),
          ...(query.sessionId ? { sessionId: query.sessionId } : {}),
          ...(query.runId ? { runId: query.runId } : {})
        })
      )
    );
  });

  app.get("/api/v1/storage/redis/keys", async (request, reply) => {
    if (!dependencies.storageAdmin) {
      throw new AppError(501, "storage_admin_unavailable", "Storage admin is unavailable on this server.");
    }

    const query = storageRedisKeysQuerySchema.parse(request.query);
    return reply.send(
      storageRedisKeyPageSchema.parse(await dependencies.storageAdmin.redisKeys(query.pattern, query.cursor, query.pageSize))
    );
  });

  app.get("/api/v1/storage/redis/key", async (request, reply) => {
    if (!dependencies.storageAdmin) {
      throw new AppError(501, "storage_admin_unavailable", "Storage admin is unavailable on this server.");
    }

    const query = storageRedisKeyQuerySchema.parse(request.query);
    return reply.send(storageRedisKeyDetailSchema.parse(await dependencies.storageAdmin.redisKeyDetail(query.key)));
  });

  app.delete("/api/v1/storage/redis/key", async (request, reply) => {
    if (!dependencies.storageAdmin) {
      throw new AppError(501, "storage_admin_unavailable", "Storage admin is unavailable on this server.");
    }

    const query = storageRedisKeyQuerySchema.parse(request.query);
    return reply.send(storageRedisDeleteKeyResponseSchema.parse(await dependencies.storageAdmin.deleteRedisKey(query.key)));
  });

  app.post("/api/v1/storage/redis/keys/delete", async (request, reply) => {
    if (!dependencies.storageAdmin) {
      throw new AppError(501, "storage_admin_unavailable", "Storage admin is unavailable on this server.");
    }

    const body = storageRedisDeleteKeysRequestSchema.parse(request.body);
    return reply.send(storageRedisDeleteKeysResponseSchema.parse(await dependencies.storageAdmin.deleteRedisKeys(body.keys)));
  });

  app.post("/api/v1/storage/redis/session-queue/clear", async (request, reply) => {
    if (!dependencies.storageAdmin) {
      throw new AppError(501, "storage_admin_unavailable", "Storage admin is unavailable on this server.");
    }

    const body = storageRedisMaintenanceRequestSchema.parse(request.body);
    return reply.send(
      storageRedisMaintenanceResponseSchema.parse(await dependencies.storageAdmin.clearRedisSessionQueue(body.key))
    );
  });

  app.post("/api/v1/storage/redis/session-lock/release", async (request, reply) => {
    if (!dependencies.storageAdmin) {
      throw new AppError(501, "storage_admin_unavailable", "Storage admin is unavailable on this server.");
    }

    const body = storageRedisMaintenanceRequestSchema.parse(request.body);
    return reply.send(
      storageRedisMaintenanceResponseSchema.parse(await dependencies.storageAdmin.releaseRedisSessionLock(body.key))
    );
  });

  app.post("/api/v1/workspaces", async (request, reply) => {
    if (workspaceMode === "single") {
      throw new AppError(501, "workspace_creation_unavailable", "Workspace creation is not available in single-workspace mode.");
    }

    const input = createWorkspaceRequestSchema.parse(request.body);
    const workspace = await dependencies.runtimeService.createWorkspace({ input });
    return reply.status(201).send(workspace);
  });

  app.post("/api/v1/workspaces/import", async (request, reply) => {
    if (workspaceMode === "single" || !dependencies.importWorkspace) {
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

    if (!workspace.historyMirrorEnabled) {
      throw new AppError(
        409,
        "history_mirror_disabled",
        `Workspace ${params.workspaceId} has local history mirror sync disabled.`
      );
    }

    if (!dependencies.rebuildWorkspaceHistoryMirror) {
      throw new AppError(501, "history_mirror_rebuild_unavailable", "History mirror rebuild is not available on this server.");
    }

    const status = await dependencies.rebuildWorkspaceHistoryMirror(workspace);
    return reply.send(workspaceHistoryMirrorStatusSchema.parse(status));
  });

  app.patch("/api/v1/workspaces/:workspaceId/settings", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    const input = updateWorkspaceSettingsRequestSchema.parse(request.body);
    const workspace = await dependencies.runtimeService.updateWorkspaceHistoryMirrorEnabled(
      params.workspaceId,
      input.historyMirrorEnabled
    );
    return reply.send(workspace);
  });

  app.delete("/api/v1/workspaces/:workspaceId", async (request, reply) => {
    if (workspaceMode === "single") {
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

  app.get("/api/v1/sessions/:sessionId", async (request, reply) => {
    const params = createParamsSchema("sessionId").parse(request.params);
    const session = await dependencies.runtimeService.getSession(params.sessionId);
    return reply.send(session);
  });

  app.patch("/api/v1/sessions/:sessionId", async (request, reply) => {
    const params = createParamsSchema("sessionId").parse(request.params);
    const input = updateSessionRequestSchema.parse(request.body);
    const session = await dependencies.runtimeService.updateSession({
      sessionId: params.sessionId,
      input
    });
    return reply.send(session);
  });

  app.delete("/api/v1/sessions/:sessionId", async (request, reply) => {
    const params = createParamsSchema("sessionId").parse(request.params);
    await dependencies.runtimeService.deleteSession(params.sessionId);
    return reply.status(204).send();
  });

  app.get("/api/v1/sessions/:sessionId/messages", async (request, reply) => {
    const params = createParamsSchema("sessionId").parse(request.params);
    const query = pageQuerySchema.parse(request.query);
    const page = await dependencies.runtimeService.listSessionMessages(params.sessionId, query.pageSize, query.cursor);
    return reply.send(page);
  });

  app.post("/api/v1/sessions/:sessionId/messages", async (request, reply) => {
    const params = createParamsSchema("sessionId").parse(request.params);
    const input = createMessageRequestSchema.parse(request.body);
    const accepted = await dependencies.runtimeService.createSessionMessage({
      sessionId: params.sessionId,
      caller: toCallerContext(request),
      input
    });

    return reply.status(202).send(messageAcceptedSchema.parse(accepted));
  });

  app.get(
    "/api/v1/sessions/:sessionId/events",
    {
      // SSE connections can reconnect frequently, so keep this route out of routine request noise.
      logLevel: "warn"
    },
    async (request, reply) => {
      const params = createParamsSchema("sessionId").parse(request.params);
      const query = runEventsQuerySchema.parse(request.query);
      await dependencies.runtimeService.getSession(params.sessionId);

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      });
      reply.raw.flushHeaders?.();
      reply.raw.write(": connected\n\n");

      const backlog = await dependencies.runtimeService.listSessionEvents(params.sessionId, query.cursor, query.runId);
      for (const event of backlog) {
        writeSseEvent(reply, event.event, event.data, event.cursor);
      }

      const unsubscribe = dependencies.runtimeService.subscribeSessionEvents(params.sessionId, (event: SessionEvent) => {
        if (query.runId && event.runId !== query.runId) {
          return;
        }

        if (query.cursor && Number.parseInt(event.cursor, 10) <= Number.parseInt(query.cursor, 10)) {
          return;
        }

        writeSseEvent(reply, event.event, event.data, event.cursor);
      });

      request.raw.on("close", () => {
        unsubscribe();
        reply.raw.end();
      });
    }
  );

  app.get("/api/v1/runs/:runId", async (request, reply) => {
    const params = createParamsSchema("runId").parse(request.params);
    const run = await dependencies.runtimeService.getRun(params.runId);
    return reply.send(run);
  });

  app.get("/api/v1/runs/:runId/steps", async (request, reply) => {
    const params = createParamsSchema("runId").parse(request.params);
    const query = pageQuerySchema.parse(request.query);
    const page = await dependencies.runtimeService.listRunSteps(params.runId, query.pageSize, query.cursor);
    return reply.send(runStepPageSchema.parse(page));
  });

  app.post("/api/v1/runs/:runId/cancel", async (request, reply) => {
    const params = createParamsSchema("runId").parse(request.params);
    const result = await dependencies.runtimeService.cancelRun(params.runId);
    return reply.status(202).send(cancelRunAcceptedSchema.parse(result));
  });

  app.post("/internal/v1/models/generate", async (request, reply) => {
    const input = modelGenerateRequestSchema.parse(request.body);
    const response = await dependencies.modelGateway.generate(
      {
        ...input,
        model: input.model ?? dependencies.defaultModel
      },
      request.raw.aborted ? { signal: AbortSignal.abort() } : undefined
    );

    return reply.send(modelGenerateResponseSchema.parse(response));
  });

  app.post("/internal/v1/models/stream", async (request, reply) => {
    const input = modelGenerateRequestSchema.parse(request.body);
    const abortController = new AbortController();
    request.raw.on("close", () => abortController.abort());

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });

    try {
      const response = await dependencies.modelGateway.stream(
        {
          ...input,
          model: input.model ?? dependencies.defaultModel
        },
        { signal: abortController.signal }
      );

      writeSseEvent(reply, "response.started", {
        model: input.model ?? dependencies.defaultModel
      });

      for await (const chunk of response.chunks) {
        writeSseEvent(reply, "text.delta", {
          delta: chunk
        });
      }

      const completed = await response.completed;
      writeSseEvent(reply, "response.completed", {
        model: completed.model,
        finishReason: completed.finishReason ?? "stop"
      });
    } catch (error) {
      writeSseEvent(reply, "response.failed", {
        model: input.model ?? dependencies.defaultModel,
        message: error instanceof Error ? error.message : "Unknown stream error."
      });
    } finally {
      reply.raw.end();
    }
  });

  return app;
}

function createParamsSchema<T extends string>(...keys: T[]) {
  return {
    parse(input: unknown): Record<T, string> {
      if (!input || typeof input !== "object") {
        throw new AppError(400, "invalid_params", "Invalid route parameters.");
      }

      const parsed: Partial<Record<T, string>> = {};
      for (const key of keys) {
        const value = (input as Record<string, unknown>)[key];
        if (typeof value !== "string" || value.length === 0) {
          throw new AppError(400, "invalid_params", `Invalid route parameter: ${key}.`);
        }

        parsed[key] = value;
      }

      return parsed as Record<T, string>;
    }
  };
}
