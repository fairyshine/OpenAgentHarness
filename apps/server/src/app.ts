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
  pageQuerySchema,
  runEventsQuerySchema,
  runStepPageSchema,
  workspaceTemplateListSchema
} from "@oah/api-contracts";
import type { CallerContext, ModelGateway, RuntimeService, SessionEvent } from "@oah/runtime-core";
import { AppError, isAppError } from "@oah/runtime-core";

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

function toCallerContext(request: FastifyRequest): CallerContext {
  if (!request.callerContext) {
    throw new AppError(401, "unauthorized", "Missing caller context.");
  }

  return request.callerContext;
}

export interface AppDependencies {
  runtimeService: RuntimeService;
  modelGateway: ModelGateway;
  defaultModel: string;
  listWorkspaceTemplates: () => Promise<import("@oah/config").WorkspaceTemplateDescriptor[]>;
}

export function createApp(dependencies: AppDependencies) {
  const app = Fastify({
    logger: true
  });

  app.setErrorHandler((error, _request, reply) => {
    if (isAppError(error)) {
      void sendError(reply, error.statusCode, error.code, error.message, error.details);
      return;
    }

    app.log.error(error);
    void sendError(reply, 500, "internal_error", error instanceof Error ? error.message : "Unknown server error.");
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/healthz" || request.url.startsWith("/internal/v1/models/")) {
      return;
    }

    if (!request.url.startsWith("/api/v1/")) {
      return;
    }

    const authorization = request.headers.authorization;
    const match = authorization?.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      await sendError(reply, 401, "unauthorized", "Missing or invalid bearer token.");
      return reply;
    }

    request.callerContext = {
      subjectRef: `dev:${match[1]}`,
      authSource: "bearer_stub",
      scopes: [],
      workspaceAccess: []
    };
  });

  app.get("/healthz", async () => ({
    status: "ok"
  }));

  app.get("/api/v1/workspace-templates", async (_request, reply) => {
    const templates = await dependencies.listWorkspaceTemplates();
    return reply.send(
      workspaceTemplateListSchema.parse({
        items: templates
      })
    );
  });

  app.post("/api/v1/workspaces", async (request, reply) => {
    const input = createWorkspaceRequestSchema.parse(request.body);
    const workspace = await dependencies.runtimeService.createWorkspace({ input });
    return reply.status(201).send(workspace);
  });

  app.get("/api/v1/workspaces/:workspaceId", async (request, reply) => {
    const params = createParamsSchema("workspaceId").parse(request.params);
    const workspace = await dependencies.runtimeService.getWorkspace(params.workspaceId);
    return reply.send(workspace);
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
        Connection: "keep-alive"
      });
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
