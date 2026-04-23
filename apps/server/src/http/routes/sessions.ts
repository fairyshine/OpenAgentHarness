import type { FastifyInstance } from "fastify";

import {
  batchRequeueRunsRequestSchema,
  batchRequeueRunsResponseSchema,
  cancelRunAcceptedSchema,
  compactSessionRequestSchema,
  createMessageRequestSchema,
  guideQueuedRunAcceptedSchema,
  messageAcceptedSchema,
  messageListQuerySchema,
  messagePageSchema,
  pageQuerySchema,
  requeueRunAcceptedSchema,
  sessionQueueSchema,
  runEventsQuerySchema,
  runPageSchema,
  runStepPageSchema,
  updateSessionRequestSchema
} from "@oah/api-contracts";
import type { SessionEvent } from "@oah/engine-core";

import { assertWorkspaceAccess, createParamsSchema, toCallerContext, writeSseEvent } from "../context.js";
import type { AppDependencies } from "../types.js";

function parseEventCursor(value: string | undefined): number {
  if (!value) {
    return -1;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : -1;
}

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
    const query = messageListQuerySchema.parse(request.query);
    const page = await dependencies.runtimeService.listSessionMessages(
      params.sessionId,
      query.pageSize,
      query.cursor,
      query.direction
    );
    return reply.send(messagePageSchema.parse(page));
  });

  app.get("/api/v1/sessions/:sessionId/runs", async (request, reply) => {
    const params = createParamsSchema("sessionId").parse(request.params);
    const query = pageQuerySchema.parse(request.query);
    const page = await dependencies.runtimeService.listSessionRuns(params.sessionId, query.pageSize, query.cursor);
    return reply.send(runPageSchema.parse(page));
  });

  app.get("/api/v1/sessions/:sessionId/queue", async (request, reply) => {
    const params = createParamsSchema("sessionId").parse(request.params);
    const queue = await dependencies.runtimeService.listSessionQueuedRuns(params.sessionId);
    return reply.send(sessionQueueSchema.parse(queue));
  });

  app.post("/api/v1/sessions/:sessionId/compact", async (request, reply) => {
    const params = createParamsSchema("sessionId").parse(request.params);
    const input = compactSessionRequestSchema.parse(request.body ?? {});
    const result = await dependencies.runtimeService.compactSession({
      sessionId: params.sessionId,
      caller: toCallerContext(request),
      input
    });
    return reply.send(result);
  });

  app.post(
    "/api/v1/sessions/:sessionId/messages",
    {
      bodyLimit: 16 * 1024 * 1024
    },
    async (request, reply) => {
      const params = createParamsSchema("sessionId").parse(request.params);
      const input = createMessageRequestSchema.parse(request.body);
      const accepted = await dependencies.runtimeService.createSessionMessage({
        sessionId: params.sessionId,
        caller: toCallerContext(request),
        input
      });

      return reply.status(202).send(messageAcceptedSchema.parse(accepted));
    }
  );

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

      const seenEventIds = new Set<string>();
      const seenOrder: string[] = [];
      const pendingEvents: SessionEvent[] = [];
      const initialCursor = parseEventCursor(query.cursor);
      let liveStreaming = false;

      const rememberEvent = (eventId: string) => {
        seenEventIds.add(eventId);
        seenOrder.push(eventId);
        if (seenOrder.length > 2048) {
          const oldestEventId = seenOrder.shift();
          if (oldestEventId) {
            seenEventIds.delete(oldestEventId);
          }
        }
      };

      const shouldForward = (event: SessionEvent): boolean => {
        if (query.runId && event.runId !== query.runId) {
          return false;
        }

        if (parseEventCursor(event.cursor) <= initialCursor || seenEventIds.has(event.id)) {
          return false;
        }

        return true;
      };

      const forwardEvent = (event: SessionEvent) => {
        if (!shouldForward(event)) {
          return;
        }

        rememberEvent(event.id);
        writeSseEvent(reply, event.event, event.data, event.cursor, event.createdAt);
      };

      const unsubscribe = dependencies.runtimeService.subscribeSessionEvents(params.sessionId, (event: SessionEvent) => {
        if (!liveStreaming) {
          pendingEvents.push(event);
          return;
        }

        forwardEvent(event);
      });

      const backlog = await dependencies.runtimeService.listSessionEvents(params.sessionId, query.cursor, query.runId);
      for (const event of backlog) {
        forwardEvent(event);
      }

      pendingEvents
        .sort((left, right) => parseEventCursor(left.cursor) - parseEventCursor(right.cursor))
        .forEach((event) => {
          forwardEvent(event);
        });
      liveStreaming = true;

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

  app.post("/api/v1/runs/:runId/guide", async (request, reply) => {
    const params = createParamsSchema("runId").parse(request.params);
    const caller = toCallerContext(request);
    const run = await dependencies.runtimeService.getRun(params.runId);
    assertWorkspaceAccess(caller, run.workspaceId);
    const result = await dependencies.runtimeService.guideQueuedRun(params.runId);
    return reply.status(202).send(guideQueuedRunAcceptedSchema.parse(result));
  });

  app.post("/api/v1/runs/:runId/requeue", async (request, reply) => {
    const params = createParamsSchema("runId").parse(request.params);
    const caller = toCallerContext(request);
    const run = await dependencies.runtimeService.getRun(params.runId);
    assertWorkspaceAccess(caller, run.workspaceId);
    const result = await dependencies.runtimeService.requeueRun(params.runId, caller.subjectRef);
    return reply.status(202).send(requeueRunAcceptedSchema.parse(result));
  });

  app.post("/api/v1/runs/requeue", async (request, reply) => {
    const caller = toCallerContext(request);
    const input = batchRequeueRunsRequestSchema.parse(request.body);
    const items = await Promise.all(
      input.runIds.map(async (runId) => {
        try {
          const run = await dependencies.runtimeService.getRun(runId);
          assertWorkspaceAccess(caller, run.workspaceId);
          return await dependencies.runtimeService.requeueRun(runId, caller.subjectRef);
        } catch (error) {
          if (error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string") {
            return {
              runId,
              status: "error" as const,
              errorCode: (error as { code: string }).code,
              errorMessage: error.message
            };
          }

          return {
            runId,
            status: "error" as const,
            errorCode: "run_requeue_failed",
            errorMessage: error instanceof Error ? error.message : String(error)
          };
        }
      })
    );

    return reply.status(200).send(batchRequeueRunsResponseSchema.parse({ items }));
  });
}
