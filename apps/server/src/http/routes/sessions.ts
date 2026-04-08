import type { FastifyInstance } from "fastify";

import {
  cancelRunAcceptedSchema,
  createMessageRequestSchema,
  messageAcceptedSchema,
  messagePageSchema,
  pageQuerySchema,
  runEventsQuerySchema,
  runPageSchema,
  runStepPageSchema,
  updateSessionRequestSchema
} from "@oah/api-contracts";
import type { SessionEvent } from "@oah/runtime-core";

import { createParamsSchema, toCallerContext, writeSseEvent } from "../context.js";
import type { AppDependencies } from "../types.js";

export function registerSessionRoutes(app: FastifyInstance, dependencies: AppDependencies): void {
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
    return reply.send(messagePageSchema.parse(page));
  });

  app.get("/api/v1/sessions/:sessionId/runs", async (request, reply) => {
    const params = createParamsSchema("sessionId").parse(request.params);
    const query = pageQuerySchema.parse(request.query);
    const page = await dependencies.runtimeService.listSessionRuns(params.sessionId, query.pageSize, query.cursor);
    return reply.send(runPageSchema.parse(page));
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
}
