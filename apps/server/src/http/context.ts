import { type FastifyReply, type FastifyRequest } from "fastify";

import { errorResponseSchema } from "@oah/api-contracts";
import type { CallerContext } from "@oah/runtime-core";
import { AppError } from "@oah/runtime-core";

export function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  details?: Record<string, unknown>
) {
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

export function writeSseEvent(reply: FastifyReply, event: string, data: Record<string, unknown>, cursor?: string): void {
  if (cursor) {
    reply.raw.write(`id: ${cursor}\n`);
  }

  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) {
    return false;
  }

  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function toCallerContext(request: FastifyRequest): CallerContext {
  if (!request.callerContext) {
    throw new AppError(401, "unauthorized", "Missing caller context.");
  }

  return request.callerContext;
}

export function createStandaloneCallerContext(): CallerContext {
  return {
    subjectRef: "standalone:anonymous",
    authSource: "standalone_server",
    scopes: [],
    // Standalone mode grants access to all workspaces.
    // When an upstream gateway provides resolveCallerContext, it is responsible
    // for populating workspaceAccess with the specific workspace IDs the caller
    // may access; an empty array then means "no access" and assertWorkspaceAccess
    // will enforce it.
    workspaceAccess: ["*"]
  };
}

export function assertWorkspaceAccess(context: CallerContext, workspaceId: string): void {
  if (context.workspaceAccess.includes("*")) {
    return;
  }

  if (context.workspaceAccess.length > 0 && !context.workspaceAccess.includes(workspaceId)) {
    throw new AppError(403, "workspace_access_denied", `Caller does not have access to workspace ${workspaceId}.`);
  }
}

export function createParamsSchema<T extends string>(...keys: T[]) {
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
