import type { FastifyRequest } from "fastify";

import { workspaceEntriesQuerySchema } from "@oah/api-contracts";
import type { WorkspaceEntryPage } from "@oah/engine-core";

import type { AppDependencies } from "./types.js";

type WorkspaceEntriesQuery = ReturnType<typeof workspaceEntriesQuerySchema.parse>;

export function parseWorkspaceEntriesQuery(request: FastifyRequest): WorkspaceEntriesQuery {
  return workspaceEntriesQuerySchema.parse(request.query);
}

export async function listWorkspaceEntriesWithFastPath(
  dependencies: AppDependencies,
  input: {
    workspaceId: string;
    query: WorkspaceEntriesQuery;
    logLabel: string;
  }
): Promise<WorkspaceEntryPage> {
  const fastPage = await dependencies.listWorkspaceEntriesFast?.({
    workspaceId: input.workspaceId,
    ...input.query
  }).catch((error) => {
    if (dependencies.logger) {
      console.warn(
        `[oah-http] Fast ${input.logLabel} file list failed for ${input.workspaceId}; falling back to workspace lease.`,
        error
      );
    }
    return undefined;
  });

  return fastPage ?? dependencies.runtimeService.listWorkspaceEntries(input.workspaceId, input.query);
}
