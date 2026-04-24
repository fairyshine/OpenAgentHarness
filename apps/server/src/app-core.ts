import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

import { isAppError } from "@oah/engine-core";

import { createStandaloneCallerContext, isLoopbackAddress, isPrivateNetworkAddress, sendError } from "./http/context.js";
import { registerInternalWorkspaceRoutes } from "./http/routes/internal-workspaces.js";
import { registerInternalSandboxRoutes } from "./http/routes/internal-sandboxes.js";
import { registerInternalModelRoutes } from "./http/routes/internal-models.js";
import type { AppDependencies } from "./http/types.js";
import { renderNativeWorkspaceSyncMetrics } from "./observability/native-workspace-sync.js";
import { describeSandboxTopology } from "./sandbox-topology.js";

function readRequestParam(request: FastifyRequest, key: string): string | undefined {
  const params = request.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }

  const value = (params as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function createBaseApp(dependencies: AppDependencies) {
  const app = Fastify({
    logger: dependencies.logger ?? true
  });
  const hostOwnsCallerContext = Boolean(dependencies.resolveCallerContext);
  const allowPrivateInternalRoutes =
    (process.env.OAH_ALLOW_PRIVATE_INTERNAL_ROUTES !== undefined &&
      /^(1|true|yes|on)$/iu.test(process.env.OAH_ALLOW_PRIVATE_INTERNAL_ROUTES.trim())) ||
    (process.env.OAH_ALLOW_PRIVATE_INTERNAL_MODEL_ROUTES !== undefined &&
      /^(1|true|yes|on)$/iu.test(process.env.OAH_ALLOW_PRIVATE_INTERNAL_MODEL_ROUTES.trim()));

  app.addContentTypeParser(/^application\/octet-stream(?:\s*;.*)?$/i, { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  app.setErrorHandler(async (error, request, reply) => {
    const sessionIdFromParams = readRequestParam(request, "sessionId");
    const runIdFromParams = readRequestParam(request, "runId");
    let resolvedSessionId = sessionIdFromParams;

    if (!resolvedSessionId && runIdFromParams) {
      const run = await dependencies.runtimeService.getRun(runIdFromParams).catch(() => null);
      resolvedSessionId = run?.sessionId;
    }

    if (resolvedSessionId && dependencies.appendEngineLog) {
      await dependencies.appendEngineLog({
        sessionId: resolvedSessionId,
        ...(runIdFromParams ? { runId: runIdFromParams } : {}),
        level: "error",
        category: "http",
        message: isAppError(error) ? error.message : "Unhandled HTTP request failure.",
        details: {
          code: isAppError(error) ? error.code : "internal_error",
          statusCode: isAppError(error) ? error.statusCode : 500,
          method: request.method,
          url: request.url,
          ...(isAppError(error) && error.details ? { details: error.details } : {}),
          ...(error instanceof Error ? { errorName: error.name } : {})
        },
        context: {
          sessionId: resolvedSessionId,
          ...(runIdFromParams ? { runId: runIdFromParams } : {})
        }
      }).catch(() => undefined);
    }

    if (isAppError(error)) {
      void sendError(reply, error.statusCode, error.code, error.message, error.details);
      return;
    }

    app.log.error(error);
    void sendError(reply, 500, "internal_error", error instanceof Error ? error.message : "Unknown server error.");
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/healthz" || request.url === "/readyz" || request.url === "/metrics") {
      return;
    }

    if (request.url.startsWith("/internal/v1/")) {
      const remoteAddress = request.ip || request.raw.socket.remoteAddress;
      if (!isLoopbackAddress(remoteAddress) && !(allowPrivateInternalRoutes && isPrivateNetworkAddress(remoteAddress))) {
        await sendError(reply, 403, "forbidden", "Internal routes are only available from loopback addresses.");
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

  return app;
}

export function registerInternalRoutes(app: ReturnType<typeof Fastify>, dependencies: AppDependencies): void {
  registerInternalWorkspaceRoutes(app, dependencies);
  registerInternalSandboxRoutes(app, dependencies);
  registerInternalModelRoutes(app, dependencies);
}

export function registerInternalOnlySurface(app: ReturnType<typeof Fastify>, dependencies: AppDependencies): void {
  app.get("/healthz", async () =>
    dependencies.healthCheck
      ? await dependencies.healthCheck()
      : {
          status: "ok",
          storage: {
            primary: "sqlite",
            events: "memory",
            runQueue: "in_process"
          },
          process: {
            mode: "standalone_worker",
            label: "standalone worker",
            execution: "redis_queue"
          },
          sandbox: describeSandboxTopology(dependencies.sandboxHostProviderKind),
          checks: {
            postgres: "not_configured",
            redisEvents: "not_configured",
            redisRunQueue: "not_configured"
          },
          worker: {
            mode: "disabled",
            draining: false,
            acceptsNewRuns: true,
            sessionSerialBoundary: "session",
            localSlots: [],
            activeWorkers: [],
            summary: {
              active: 0,
              healthy: 0,
              late: 0,
              busy: 0,
              embedded: 0,
              standalone: 0
            },
            pool: null
          }
        }
  );

  app.get("/readyz", async (_request: FastifyRequest, reply: FastifyReply) => {
    const payload = dependencies.readinessCheck
      ? await dependencies.readinessCheck()
      : {
          status: "ready",
          draining: false,
          checks: {
            postgres: "not_configured",
            redisEvents: "not_configured",
            redisRunQueue: "not_configured"
          }
        };

    if (payload.status === "not_ready") {
      return reply.status(503).send(payload);
    }

    return reply.send(payload);
  });

  app.get("/metrics", async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
    return reply.send(renderNativeWorkspaceSyncMetrics());
  });
}
