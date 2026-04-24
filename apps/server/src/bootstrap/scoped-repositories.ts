import type { Run, Session } from "@oah/api-contracts";
import { AppError } from "../../../../packages/engine-core/src/errors.js";
import { parseCursor } from "../../../../packages/engine-core/src/utils.js";
import type {
  RunRepository,
  SessionRepository,
  WorkspaceRecord,
  WorkspaceRepository
} from "../../../../packages/engine-core/src/types.js";

async function listVisibleWorkspaces(
  repository: WorkspaceRepository,
  visibleWorkspaceIds: ReadonlySet<string>,
  pageSize: number,
  cursor?: string
): Promise<WorkspaceRecord[]> {
  const visibleItems: WorkspaceRecord[] = [];
  let rawCursor: string | undefined;

  do {
    const page = await repository.list(Math.max(pageSize, 100), rawCursor);
    visibleItems.push(...page.filter((workspace) => visibleWorkspaceIds.has(workspace.id)));
    rawCursor = page.length === Math.max(pageSize, 100) ? String(parseCursor(rawCursor) + Math.max(pageSize, 100)) : undefined;
  } while (rawCursor);

  const startIndex = parseCursor(cursor);
  return visibleItems.slice(startIndex, startIndex + pageSize);
}

export async function describeQueuedRunWithScopedVisibility(
  repository: Pick<RunRepository, "getById">,
  visibleWorkspaceIds: Set<string>,
  runId: string
): Promise<{ workspaceId?: string | undefined } | undefined> {
  const run = await repository.getById(runId);
  if (!run) {
    return undefined;
  }

  visibleWorkspaceIds.add(run.workspaceId);
  return {
    workspaceId: run.workspaceId
  };
}

export class ScopedWorkspaceRepository implements WorkspaceRepository {
  constructor(
    private readonly inner: WorkspaceRepository,
    private readonly visibleWorkspaceIds: Set<string>
  ) {}

  async create(input: WorkspaceRecord): Promise<WorkspaceRecord> {
    try {
      const created = await this.inner.create(input);
      this.visibleWorkspaceIds.add(input.id);
      return created;
    } catch (error) {
      const existing = await this.inner.getById(input.id);
      if (!existing) {
        throw error;
      }

      this.visibleWorkspaceIds.add(input.id);
      return existing;
    }
  }

  async upsert(input: WorkspaceRecord): Promise<WorkspaceRecord> {
    const upserted = await this.inner.upsert(input);
    this.visibleWorkspaceIds.add(input.id);
    return upserted;
  }

  async getById(id: string): Promise<WorkspaceRecord | null> {
    if (!this.visibleWorkspaceIds.has(id)) {
      return null;
    }

    return this.inner.getById(id);
  }

  async list(pageSize: number, cursor?: string): Promise<WorkspaceRecord[]> {
    return listVisibleWorkspaces(this.inner, this.visibleWorkspaceIds, pageSize, cursor);
  }

  async delete(id: string): Promise<void> {
    await this.inner.delete(id);
    this.visibleWorkspaceIds.delete(id);
  }
}

export class ScopedSessionRepository implements SessionRepository {
  constructor(
    private readonly inner: SessionRepository,
    private readonly visibleWorkspaceIds: ReadonlySet<string>
  ) {}

  async create(input: Session): Promise<Session> {
    return this.inner.create(input);
  }

  async getById(id: string): Promise<Session | null> {
    const session = await this.inner.getById(id);
    if (!session || !this.visibleWorkspaceIds.has(session.workspaceId)) {
      return null;
    }

    return session;
  }

  async update(input: Session): Promise<Session> {
    if (!this.visibleWorkspaceIds.has(input.workspaceId)) {
      throw new AppError(404, "session_not_found", `Session ${input.id} was not found.`);
    }

    return this.inner.update(input);
  }

  async listByWorkspaceId(workspaceId: string, pageSize: number, cursor?: string): Promise<Session[]> {
    if (!this.visibleWorkspaceIds.has(workspaceId)) {
      return [];
    }

    return this.inner.listByWorkspaceId(workspaceId, pageSize, cursor);
  }

  async delete(id: string): Promise<void> {
    const session = await this.inner.getById(id);
    if (!session || !this.visibleWorkspaceIds.has(session.workspaceId)) {
      throw new AppError(404, "session_not_found", `Session ${id} was not found.`);
    }

    return this.inner.delete(id);
  }
}

export class ScopedRunRepository implements RunRepository {
  constructor(
    private readonly inner: RunRepository,
    private readonly visibleWorkspaceIds: ReadonlySet<string>
  ) {}

  async create(input: Run): Promise<Run> {
    return this.inner.create(input);
  }

  async getById(id: string): Promise<Run | null> {
    const run = await this.inner.getById(id);
    if (!run || !this.visibleWorkspaceIds.has(run.workspaceId)) {
      return null;
    }

    return run;
  }

  async update(input: Run): Promise<Run> {
    if (!this.visibleWorkspaceIds.has(input.workspaceId)) {
      throw new AppError(404, "run_not_found", `Run ${input.id} was not found.`);
    }

    return this.inner.update(input);
  }

  async listBySessionId(sessionId: string): Promise<Run[]> {
    const runs = await this.inner.listBySessionId(sessionId);
    return runs.filter((run) => this.visibleWorkspaceIds.has(run.workspaceId));
  }

  async listRecoverableActiveRuns(staleBefore: string, limit: number): Promise<Run[]> {
    const runs = await this.inner.listRecoverableActiveRuns(staleBefore, limit * 4);
    return runs.filter((run) => this.visibleWorkspaceIds.has(run.workspaceId)).slice(0, limit);
  }
}
