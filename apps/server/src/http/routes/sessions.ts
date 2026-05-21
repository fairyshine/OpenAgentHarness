import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  batchRequeueRunsRequestSchema,
  batchRequeueRunsResponseSchema,
  cancelRunAcceptedSchema,
  compactSessionRequestSchema,
  createMessageRequestSchema,
  guideQueuedRunAcceptedSchema,
  messageAcceptedSchema,
  messageContextQuerySchema,
  messageContextSchema,
  messageListQuerySchema,
  messagePageSchema,
  messageSchema,
  pageQuerySchema,
  requeueRunAcceptedSchema,
  sessionQueueSchema,
  sessionPageSchema,
  sessionTerminalInputAcceptedSchema,
  sessionTerminalInputRequestSchema,
  sessionTerminalSnapshotSchema,
  runEventsQuerySchema,
  runPageSchema,
  runStepPageSchema,
  updateSessionRequestSchema
} from "@oah/api-contracts";
import type { SessionEvent } from "@oah/engine-core";

import { assertWorkspaceAccess, createParamsSchema, toCallerContext, writeSseEvent } from "../context.js";
import type { AppDependencies } from "../types.js";

const SESSION_EVENT_BACKLOG_PAGE_SIZE = 500;
const SESSION_SNAPSHOT_MESSAGE_PAGE_SIZE = 8;
const SESSION_SNAPSHOT_RUN_PAGE_SIZE = 80;
const SESSION_SNAPSHOT_RUN_STEP_PAGE_SIZE = 100;
const SESSION_EVENT_CURSOR_LATEST = "$latest";

function parseEventCursor(value: string | undefined): number {
  if (!value) {
    return -1;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : -1;
}

function readRegisteredRouteUrl(request: FastifyRequest): string {
  return typeof request.routeOptions.url === "string" ? request.routeOptions.url : request.url.split("?")[0] ?? request.url;
}

export async function dispatchRegisteredSessionRoute(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AppDependencies
) {
  const routeUrl = readRegisteredRouteUrl(request);

  switch (`${request.method} ${routeUrl}`) {
    case "GET /api/v1/sessions/:sessionId": {
      const params = createParamsSchema("sessionId").parse(request.params);
      const session = await dependencies.runtimeService.getSession(params.sessionId);
      return reply.send(session);
    }
    case "GET /api/v1/sessions/:sessionId/snapshot": {
      const params = createParamsSchema("sessionId").parse(request.params);
      const rawQuery =
        request.query && typeof request.query === "object" ? (request.query as Record<string, unknown>) : {};
      const requestedRunId = typeof rawQuery.selectedRunId === "string" ? rawQuery.selectedRunId.trim() : "";
      const [session, currentState, messages, queue] = await Promise.all([
        dependencies.runtimeService.getSession(params.sessionId),
        dependencies.runtimeService.getSessionCurrentState(params.sessionId),
        dependencies.runtimeService.listSessionTranscriptMessages(
          params.sessionId,
          SESSION_SNAPSHOT_MESSAGE_PAGE_SIZE,
          undefined,
          "backward"
        ),
        dependencies.runtimeService.listSessionQueuedRuns(params.sessionId)
      ]);
      const requestedRunCandidate = requestedRunId ? await dependencies.runtimeService.getRun(requestedRunId).catch(() => null) : null;
      const latestRunCandidate =
        currentState.latestRunId && currentState.latestRunId !== requestedRunId
          ? await dependencies.runtimeService.getRun(currentState.latestRunId).catch(() => null)
          : null;
      const selectedRun =
        requestedRunCandidate?.sessionId === session.id
          ? requestedRunCandidate
          : latestRunCandidate?.sessionId === session.id
            ? latestRunCandidate
            : null;
      const runs = selectedRun
        ? { items: [selectedRun] }
        : await dependencies.runtimeService.listSessionRuns(params.sessionId, SESSION_SNAPSHOT_RUN_PAGE_SIZE);
      const selectedRunSteps = selectedRun
        ? await dependencies.runtimeService.listRunSteps(selectedRun.id, SESSION_SNAPSHOT_RUN_STEP_PAGE_SIZE)
        : undefined;

      return reply.send(
        {
          session,
          messages: messagePageSchema.parse(messages),
          runs: runPageSchema.parse(runs),
          ...(selectedRun ? { selectedRunId: selectedRun.id } : {}),
          ...(selectedRunSteps ? { selectedRunSteps: runStepPageSchema.parse(selectedRunSteps) } : {}),
          queue: sessionQueueSchema.parse(queue)
        }
      );
    }
    case "PATCH /api/v1/sessions/:sessionId": {
      const params = createParamsSchema("sessionId").parse(request.params);
      const input = updateSessionRequestSchema.parse(request.body);
      const session = await dependencies.runtimeService.updateSession({
        sessionId: params.sessionId,
        input
      });
      return reply.send(session);
    }
    case "DELETE /api/v1/sessions/:sessionId": {
      const params = createParamsSchema("sessionId").parse(request.params);
      await dependencies.runtimeService.deleteSession(params.sessionId);
      return reply.status(204).send();
    }
    case "GET /api/v1/sessions/:sessionId/messages": {
      const params = createParamsSchema("sessionId").parse(request.params);
      const query = messageListQuerySchema.parse(request.query);
      const page =
        query.view === "transcript"
          ? await dependencies.runtimeService.listSessionTranscriptMessages(
              params.sessionId,
              query.pageSize,
              query.cursor,
              query.direction
            )
          : await dependencies.runtimeService.listSessionMessages(
              params.sessionId,
              query.pageSize,
              query.cursor,
              query.direction
            );
      return reply.send(messagePageSchema.parse(page));
    }
    case "GET /api/v1/sessions/:sessionId/children": {
      const params = createParamsSchema("sessionId").parse(request.params);
      const query = pageQuerySchema.parse(request.query);
      const page = await dependencies.runtimeService.listChildSessions(params.sessionId, query.pageSize, query.cursor);
      return reply.send(sessionPageSchema.parse(page));
    }
    case "GET /api/v1/sessions/:sessionId/messages/:messageId": {
      const params = createParamsSchema("sessionId", "messageId").parse(request.params);
      const message = await dependencies.runtimeService.getSessionMessage(params.sessionId, params.messageId);
      return reply.send(messageSchema.parse(message));
    }
    case "GET /api/v1/sessions/:sessionId/messages/:messageId/context": {
      const params = createParamsSchema("sessionId", "messageId").parse(request.params);
      const query = messageContextQuerySchema.parse(request.query);
      const context = await dependencies.runtimeService.getSessionMessageContext(
        params.sessionId,
        params.messageId,
        query.before,
        query.after
      );
      return reply.send(messageContextSchema.parse(context));
    }
    case "GET /api/v1/sessions/:sessionId/runs": {
      const params = createParamsSchema("sessionId").parse(request.params);
      const query = pageQuerySchema.parse(request.query);
      const page = await dependencies.runtimeService.listSessionRuns(params.sessionId, query.pageSize, query.cursor);
      return reply.send(runPageSchema.parse(page));
    }
    case "GET /api/v1/sessions/:sessionId/queue": {
      const params = createParamsSchema("sessionId").parse(request.params);
      const queue = await dependencies.runtimeService.listSessionQueuedRuns(params.sessionId);
      return reply.send(sessionQueueSchema.parse(queue));
    }
    case "GET /api/v1/sessions/:sessionId/terminals/:terminalId": {
      const params = createParamsSchema("sessionId", "terminalId").parse(request.params);
      const rawQuery =
        request.query && typeof request.query === "object" ? (request.query as Record<string, unknown>) : {};
      const maxBytes = Number.parseInt(String(rawQuery.maxBytes ?? ""), 10);
      const snapshot = await dependencies.runtimeService.getSessionTerminalSnapshot(
        params.sessionId,
        params.terminalId,
        {
          maxBytes: Number.isFinite(maxBytes) ? Math.min(Math.max(maxBytes, 1024), 1024 * 1024) : 256 * 1024
        }
      );
      return reply.send(sessionTerminalSnapshotSchema.parse(snapshot));
    }
    case "POST /api/v1/sessions/:sessionId/terminals/:terminalId/input": {
      const params = createParamsSchema("sessionId", "terminalId").parse(request.params);
      const input = sessionTerminalInputRequestSchema.parse(request.body);
      const accepted = await dependencies.runtimeService.writeSessionTerminalInput(
        params.sessionId,
        params.terminalId,
        input
      );
      return reply.status(202).send(sessionTerminalInputAcceptedSchema.parse(accepted));
    }
    case "POST /api/v1/sessions/:sessionId/compact": {
      const params = createParamsSchema("sessionId").parse(request.params);
      const input = compactSessionRequestSchema.parse(request.body ?? {});
      const result = await dependencies.runtimeService.compactSession({
        sessionId: params.sessionId,
        caller: toCallerContext(request),
        input
      });
      return reply.send(result);
    }
    case "POST /api/v1/sessions/:sessionId/messages": {
      const params = createParamsSchema("sessionId").parse(request.params);
      const input = createMessageRequestSchema.parse(request.body);
      const accepted = await dependencies.runtimeService.createSessionMessage({
        sessionId: params.sessionId,
        caller: toCallerContext(request),
        input
      });

      return reply.status(202).send(messageAcceptedSchema.parse(accepted));
    }
    case "GET /api/v1/sessions/:sessionId/events": {
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
      const startAtLatest = query.cursor === SESSION_EVENT_CURSOR_LATEST;
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

        if ((!startAtLatest && parseEventCursor(event.cursor) <= initialCursor) || seenEventIds.has(event.id)) {
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

      let backlogCursor = query.cursor;
      if (!startAtLatest) {
        while (!request.raw.destroyed) {
          const backlog = await dependencies.runtimeService.listSessionEvents(
            params.sessionId,
            backlogCursor,
            query.runId,
            SESSION_EVENT_BACKLOG_PAGE_SIZE
          );
          if (backlog.length === 0) {
            break;
          }

          for (const event of backlog) {
            forwardEvent(event);
          }

          if (backlog.length < SESSION_EVENT_BACKLOG_PAGE_SIZE) {
            break;
          }
          backlogCursor = backlog.at(-1)?.cursor ?? backlogCursor;
        }
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
      return reply;
    }
    case "GET /api/v1/runs/:runId": {
      const params = createParamsSchema("runId").parse(request.params);
      const run = await dependencies.runtimeService.getRun(params.runId);
      return reply.send(run);
    }
    case "GET /api/v1/runs/:runId/steps": {
      const params = createParamsSchema("runId").parse(request.params);
      const query = pageQuerySchema.parse(request.query);
      const page = await dependencies.runtimeService.listRunSteps(params.runId, query.pageSize, query.cursor);
      return reply.send(runStepPageSchema.parse(page));
    }
    case "POST /api/v1/runs/:runId/cancel": {
      const params = createParamsSchema("runId").parse(request.params);
      const result = await dependencies.runtimeService.cancelRun(params.runId);
      return reply.status(202).send(cancelRunAcceptedSchema.parse(result));
    }
    case "POST /api/v1/runs/:runId/guide": {
      const params = createParamsSchema("runId").parse(request.params);
      const caller = toCallerContext(request);
      const run = await dependencies.runtimeService.getRun(params.runId);
      assertWorkspaceAccess(caller, run.workspaceId);
      const result = await dependencies.runtimeService.guideQueuedRun(params.runId);
      return reply.status(202).send(guideQueuedRunAcceptedSchema.parse(result));
    }
    case "POST /api/v1/runs/:runId/requeue": {
      const params = createParamsSchema("runId").parse(request.params);
      const caller = toCallerContext(request);
      const run = await dependencies.runtimeService.getRun(params.runId);
      assertWorkspaceAccess(caller, run.workspaceId);
      const result = await dependencies.runtimeService.requeueRun(params.runId, caller.subjectRef);
      return reply.status(202).send(requeueRunAcceptedSchema.parse(result));
    }
    case "POST /api/v1/runs/requeue": {
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
    }
    default:
      throw new Error(`Unsupported session route: ${request.method} ${routeUrl}`);
  }
}

export function registerSessionRoutes(app: FastifyInstance, dependencies: AppDependencies): void {
  app.get("/api/v1/sessions/:sessionId", async (request, reply) =>
    dispatchRegisteredSessionRoute(request, reply, dependencies)
  );
  app.get("/api/v1/sessions/:sessionId/snapshot", async (request, reply) =>
    dispatchRegisteredSessionRoute(request, reply, dependencies)
  );
  app.patch("/api/v1/sessions/:sessionId", async (request, reply) =>
    dispatchRegisteredSessionRoute(request, reply, dependencies)
  );
  app.delete("/api/v1/sessions/:sessionId", async (request, reply) =>
    dispatchRegisteredSessionRoute(request, reply, dependencies)
  );
  app.get("/api/v1/sessions/:sessionId/messages", async (request, reply) =>
    dispatchRegisteredSessionRoute(request, reply, dependencies)
  );
  app.get("/api/v1/sessions/:sessionId/children", async (request, reply) =>
    dispatchRegisteredSessionRoute(request, reply, dependencies)
  );
  app.get("/api/v1/sessions/:sessionId/messages/:messageId", async (request, reply) =>
    dispatchRegisteredSessionRoute(request, reply, dependencies)
  );
  app.get("/api/v1/sessions/:sessionId/messages/:messageId/context", async (request, reply) =>
    dispatchRegisteredSessionRoute(request, reply, dependencies)
  );
  app.get("/api/v1/sessions/:sessionId/runs", async (request, reply) =>
    dispatchRegisteredSessionRoute(request, reply, dependencies)
  );
  app.get("/api/v1/sessions/:sessionId/queue", async (request, reply) =>
    dispatchRegisteredSessionRoute(request, reply, dependencies)
  );
  app.get("/api/v1/sessions/:sessionId/terminals/:terminalId", async (request, reply) =>
    dispatchRegisteredSessionRoute(request, reply, dependencies)
  );
  app.post("/api/v1/sessions/:sessionId/terminals/:terminalId/input", async (request, reply) =>
    dispatchRegisteredSessionRoute(request, reply, dependencies)
  );
  app.post("/api/v1/sessions/:sessionId/compact", async (request, reply) =>
    dispatchRegisteredSessionRoute(request, reply, dependencies)
  );
  app.post(
    "/api/v1/sessions/:sessionId/messages",
    {
      bodyLimit: 16 * 1024 * 1024
    },
    async (request, reply) => dispatchRegisteredSessionRoute(request, reply, dependencies)
  );
  app.get(
    "/api/v1/sessions/:sessionId/events",
    {
      logLevel: "warn"
    },
    async (request, reply) => dispatchRegisteredSessionRoute(request, reply, dependencies)
  );
  app.get("/api/v1/runs/:runId", async (request, reply) =>
    dispatchRegisteredSessionRoute(request, reply, dependencies)
  );
  app.get("/api/v1/runs/:runId/steps", async (request, reply) =>
    dispatchRegisteredSessionRoute(request, reply, dependencies)
  );
  app.post("/api/v1/runs/:runId/cancel", async (request, reply) =>
    dispatchRegisteredSessionRoute(request, reply, dependencies)
  );
  app.post("/api/v1/runs/:runId/guide", async (request, reply) =>
    dispatchRegisteredSessionRoute(request, reply, dependencies)
  );
  app.post("/api/v1/runs/:runId/requeue", async (request, reply) =>
    dispatchRegisteredSessionRoute(request, reply, dependencies)
  );
  app.post("/api/v1/runs/requeue", async (request, reply) =>
    dispatchRegisteredSessionRoute(request, reply, dependencies)
  );
}
