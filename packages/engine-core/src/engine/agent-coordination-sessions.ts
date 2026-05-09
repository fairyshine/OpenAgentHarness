import type { Run } from "@oah/api-contracts";

import type { AgentCoordinationPersistence } from "./agent-coordination-types.js";

export async function activeRunForSession(
  persistence: Pick<AgentCoordinationPersistence, "runs">,
  sessionId: string
): Promise<Run | null> {
  const runs = await persistence.runs.listBySessionId(sessionId).catch(() => []);
  return (
    runs
      .filter((run) => run.status === "queued" || run.status === "running" || run.status === "waiting_tool")
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] ?? null
  );
}
