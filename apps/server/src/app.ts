import Fastify from "fastify";

import { isAppError } from "@oah/runtime-core";

import { createStandaloneCallerContext, isLoopbackAddress, sendError } from "./http/context.js";
import { registerPublicRoutes } from "./http/routes/public.js";
import { registerWorkspaceRoutes } from "./http/routes/workspaces.js";
import { registerSessionRoutes } from "./http/routes/sessions.js";
import { registerInternalModelRoutes } from "./http/routes/internal-models.js";
import type { AppDependencies } from "./http/types.js";

export type { AppDependencies } from "./http/types.js";

export function createApp(dependencies: AppDependencies) {
  const app = Fastify({
    logger: dependencies.logger ?? true
  });
  const hostOwnsCallerContext = Boolean(dependencies.resolveCallerContext);
  const workspaceMode = dependencies.workspaceMode ?? "multi";

  app.addContentTypeParser(/^application\/octet-stream(?:\s*;.*)?$/i, { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
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

  registerPublicRoutes(app, dependencies, { workspaceMode });
  registerWorkspaceRoutes(app, dependencies, { workspaceMode });
  registerSessionRoutes(app, dependencies);
  registerInternalModelRoutes(app, dependencies);

  return app;
}
