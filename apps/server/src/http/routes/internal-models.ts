import type { FastifyInstance } from "fastify";

import { modelGenerateRequestSchema, modelGenerateResponseSchema, platformModelSnapshotSchema } from "@oah/api-contracts";
import { AppError } from "@oah/runtime-core";

import { writeSseEvent } from "../context.js";
import type { AppDependencies } from "../types.js";

export function registerInternalModelRoutes(app: FastifyInstance, dependencies: AppDependencies): void {
  app.post("/internal/v1/platform-models/refresh", async (_request, reply) => {
    if (!dependencies.refreshPlatformModels) {
      throw new AppError(404, "platform_models_unavailable", "Platform model refresh is not available.");
    }

    return reply.send(platformModelSnapshotSchema.parse(await dependencies.refreshPlatformModels()));
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
}
