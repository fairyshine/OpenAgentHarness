import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AppDependencies, AppRouteOptions } from "../types.js";

type WorkspaceRoutesModule = typeof import("./workspaces.js");

let workspaceRoutesModulePromise: Promise<WorkspaceRoutesModule> | undefined;

async function loadWorkspaceRoutesModule(): Promise<WorkspaceRoutesModule> {
  if (!workspaceRoutesModulePromise) {
    workspaceRoutesModulePromise = import("./workspaces.js");
  }

  return workspaceRoutesModulePromise;
}

async function dispatchWorkspaceRoute(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AppDependencies,
  options: AppRouteOptions
) {
  const module = await loadWorkspaceRoutesModule();
  return module.dispatchRegisteredWorkspaceRoute(request, reply, dependencies, options);
}

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  dependencies: AppDependencies,
  options: AppRouteOptions
): void {
  app.post("/api/v1/workspaces", async (request, reply) =>
    dispatchWorkspaceRoute(request, reply, dependencies, options)
  );
  app.post("/api/v1/workspaces/import", async (request, reply) =>
    dispatchWorkspaceRoute(request, reply, dependencies, options)
  );
  app.post("/api/v1/local/workspaces/register", async (request, reply) =>
    dispatchWorkspaceRoute(request, reply, dependencies, options)
  );
  app.post("/api/v1/local/workspaces/:workspaceId/repair", async (request, reply) =>
    dispatchWorkspaceRoute(request, reply, dependencies, options)
  );
  app.get("/api/v1/workspaces", async (request, reply) =>
    dispatchWorkspaceRoute(request, reply, dependencies, options)
  );
  app.get("/api/v1/workspaces/:workspaceId", async (request, reply) =>
    dispatchWorkspaceRoute(request, reply, dependencies, options)
  );
  app.delete("/api/v1/workspaces/:workspaceId", async (request, reply) =>
    dispatchWorkspaceRoute(request, reply, dependencies, options)
  );
  app.get("/api/v1/workspaces/:workspaceId/catalog", async (request, reply) =>
    dispatchWorkspaceRoute(request, reply, dependencies, options)
  );
  app.get("/api/v1/workspaces/:workspaceId/memory/status", async (request, reply) =>
    dispatchWorkspaceRoute(request, reply, dependencies, options)
  );
  app.get("/api/v1/workspaces/:workspaceId/memory", async (request, reply) =>
    dispatchWorkspaceRoute(request, reply, dependencies, options)
  );
  app.get("/api/v1/workspaces/:workspaceId/memory/search", async (request, reply) =>
    dispatchWorkspaceRoute(request, reply, dependencies, options)
  );
  app.get("/api/v1/workspaces/:workspaceId/memory/read", async (request, reply) =>
    dispatchWorkspaceRoute(request, reply, dependencies, options)
  );
  app.get("/api/v1/workspaces/:workspaceId/memory/proposals", async (request, reply) =>
    dispatchWorkspaceRoute(request, reply, dependencies, options)
  );
  app.post("/api/v1/workspaces/:workspaceId/memory/proposals/apply", async (request, reply) =>
    dispatchWorkspaceRoute(request, reply, dependencies, options)
  );
  app.post("/api/v1/workspaces/:workspaceId/memory/proposals/reject", async (request, reply) =>
    dispatchWorkspaceRoute(request, reply, dependencies, options)
  );
  app.get("/api/v1/workspaces/:workspaceId/entries", async (request, reply) =>
    dispatchWorkspaceRoute(request, reply, dependencies, options)
  );
  app.get("/api/v1/workspaces/:workspaceId/files/content", async (request, reply) =>
    dispatchWorkspaceRoute(request, reply, dependencies, options)
  );
  app.put("/api/v1/workspaces/:workspaceId/files/content", async (request, reply) =>
    dispatchWorkspaceRoute(request, reply, dependencies, options)
  );
  app.put("/api/v1/workspaces/:workspaceId/files/upload", async (request, reply) =>
    dispatchWorkspaceRoute(request, reply, dependencies, options)
  );
  app.get("/api/v1/workspaces/:workspaceId/files/download", async (request, reply) =>
    dispatchWorkspaceRoute(request, reply, dependencies, options)
  );
  app.post("/api/v1/workspaces/:workspaceId/directories", async (request, reply) =>
    dispatchWorkspaceRoute(request, reply, dependencies, options)
  );
  app.delete("/api/v1/workspaces/:workspaceId/entries", async (request, reply) =>
    dispatchWorkspaceRoute(request, reply, dependencies, options)
  );
  app.patch("/api/v1/workspaces/:workspaceId/entries/move", async (request, reply) =>
    dispatchWorkspaceRoute(request, reply, dependencies, options)
  );
  app.post("/api/v1/workspaces/:workspaceId/sessions", async (request, reply) =>
    dispatchWorkspaceRoute(request, reply, dependencies, options)
  );
  app.get("/api/v1/workspaces/:workspaceId/sessions", async (request, reply) =>
    dispatchWorkspaceRoute(request, reply, dependencies, options)
  );
  app.post("/api/v1/workspaces/:workspaceId/actions/:actionName/runs", async (request, reply) =>
    dispatchWorkspaceRoute(request, reply, dependencies, options)
  );
}
