import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AppDependencies } from "../types.js";

type SessionRoutesModule = typeof import("./sessions.js");

let sessionRoutesModulePromise: Promise<SessionRoutesModule> | undefined;

async function loadSessionRoutesModule(): Promise<SessionRoutesModule> {
  if (!sessionRoutesModulePromise) {
    sessionRoutesModulePromise = import("./sessions.js");
  }

  return sessionRoutesModulePromise;
}

async function dispatchSessionRoute(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AppDependencies
) {
  const module = await loadSessionRoutesModule();
  return module.dispatchRegisteredSessionRoute(request, reply, dependencies);
}

export function registerSessionRoutes(app: FastifyInstance, dependencies: AppDependencies): void {
  app.get("/api/v1/sessions/:sessionId", async (request, reply) =>
    dispatchSessionRoute(request, reply, dependencies)
  );
  app.get("/api/v1/sessions/:sessionId/snapshot", async (request, reply) =>
    dispatchSessionRoute(request, reply, dependencies)
  );
  app.patch("/api/v1/sessions/:sessionId", async (request, reply) =>
    dispatchSessionRoute(request, reply, dependencies)
  );
  app.delete("/api/v1/sessions/:sessionId", async (request, reply) =>
    dispatchSessionRoute(request, reply, dependencies)
  );
  app.get("/api/v1/sessions/:sessionId/messages", async (request, reply) =>
    dispatchSessionRoute(request, reply, dependencies)
  );
  app.get("/api/v1/sessions/:sessionId/children", async (request, reply) =>
    dispatchSessionRoute(request, reply, dependencies)
  );
  app.get("/api/v1/sessions/:sessionId/messages/:messageId", async (request, reply) =>
    dispatchSessionRoute(request, reply, dependencies)
  );
  app.get("/api/v1/sessions/:sessionId/messages/:messageId/context", async (request, reply) =>
    dispatchSessionRoute(request, reply, dependencies)
  );
  app.get("/api/v1/sessions/:sessionId/runs", async (request, reply) =>
    dispatchSessionRoute(request, reply, dependencies)
  );
  app.get("/api/v1/sessions/:sessionId/queue", async (request, reply) =>
    dispatchSessionRoute(request, reply, dependencies)
  );
  app.get("/api/v1/sessions/:sessionId/terminals/:terminalId", async (request, reply) =>
    dispatchSessionRoute(request, reply, dependencies)
  );
  app.post("/api/v1/sessions/:sessionId/terminals/:terminalId/input", async (request, reply) =>
    dispatchSessionRoute(request, reply, dependencies)
  );
  app.post("/api/v1/sessions/:sessionId/compact", async (request, reply) =>
    dispatchSessionRoute(request, reply, dependencies)
  );
  app.post(
    "/api/v1/sessions/:sessionId/messages",
    {
      bodyLimit: 16 * 1024 * 1024
    },
    async (request, reply) => dispatchSessionRoute(request, reply, dependencies)
  );
  app.get(
    "/api/v1/sessions/:sessionId/events",
    {
      logLevel: "warn"
    },
    async (request, reply) => dispatchSessionRoute(request, reply, dependencies)
  );
  app.get("/api/v1/runs/:runId", async (request, reply) =>
    dispatchSessionRoute(request, reply, dependencies)
  );
  app.get("/api/v1/runs/:runId/steps", async (request, reply) =>
    dispatchSessionRoute(request, reply, dependencies)
  );
  app.post("/api/v1/runs/:runId/cancel", async (request, reply) =>
    dispatchSessionRoute(request, reply, dependencies)
  );
  app.post("/api/v1/runs/:runId/guide", async (request, reply) =>
    dispatchSessionRoute(request, reply, dependencies)
  );
  app.post("/api/v1/runs/:runId/requeue", async (request, reply) =>
    dispatchSessionRoute(request, reply, dependencies)
  );
  app.post("/api/v1/runs/requeue", async (request, reply) =>
    dispatchSessionRoute(request, reply, dependencies)
  );
}
