import { AppError } from "@oah/engine-core";
import type {
  AgentTaskNotificationRecord,
  AgentTaskNotificationRepository,
  AgentTaskRecord,
  AgentTaskRepository,
  ArtifactRecord,
  ArtifactRepository,
  HistoryEventRecord,
  HistoryEventRepository,
  HookRunAuditRecord,
  HookRunAuditRepository,
  Message,
  MessageRepository,
  Run,
  RunRepository,
  RunStep,
  RunStepRepository,
  EngineMessage,
  EngineMessageRepository,
  Session,
  SessionEvent,
  SessionEventStore,
  SessionPendingRunQueueEntry,
  SessionPendingRunQueueRepository,
  SessionRepository,
  ToolCallAuditRecord,
  ToolCallAuditRepository,
  WorkspaceArchiveRecord,
  WorkspaceArchiveRepository,
  WorkspaceRecord,
  WorkspaceRepository
} from "@oah/engine-core";
import {
  createPostgresRuntimePersistence,
  type CreatePostgresRuntimePersistenceOptions,
  type PostgresRuntimePersistence
} from "@oah/storage-postgres";
import {
  buildServiceDatabaseConnectionString,
  ensureServiceRoutingRegistrySchema,
  migrateServiceRoutingRegistry,
  normalizeServiceName,
  PostgresServiceRoutingRegistry,
  type PostgresPersistenceFactory,
  ServiceBackendRouter
} from "./service-routed-postgres-routing.js";

export { buildServiceDatabaseConnectionString } from "./service-routed-postgres-routing.js";

export interface ServiceRoutedPostgresRuntimePersistence {
  pool: PostgresRuntimePersistence["pool"];
  workspaceRepository: WorkspaceRepository;
  workspaceArchiveRepository: WorkspaceArchiveRepository;
  sessionRepository: SessionRepository;
  messageRepository: MessageRepository;
  engineMessageRepository: EngineMessageRepository;
  runRepository: RunRepository;
  runStepRepository: RunStepRepository;
  sessionEventStore: SessionEventStore;
  sessionPendingRunQueueRepository: SessionPendingRunQueueRepository;
  toolCallAuditRepository: ToolCallAuditRepository;
  hookRunAuditRepository: HookRunAuditRepository;
  artifactRepository: ArtifactRepository;
  agentTaskRepository: AgentTaskRepository;
  agentTaskNotificationRepository: AgentTaskNotificationRepository;
  historyEventRepository: HistoryEventRepository;
  listWorkspaceSnapshots(candidates: WorkspaceRecord[]): Promise<WorkspaceRecord[]>;
  close(): Promise<void>;
}

export interface CreateServiceRoutedPostgresRuntimePersistenceOptions {
  connectionString: string;
  archivePayloadRoot?: string | undefined;
  poolConfig?: CreatePostgresRuntimePersistenceOptions["poolConfig"] | undefined;
  persistenceFactory?: PostgresPersistenceFactory | undefined;
}

class RoutedWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly router: ServiceBackendRouter) {}

  async create(input: WorkspaceRecord): Promise<WorkspaceRecord> {
    const serviceName = normalizeServiceName(input.serviceName);
    const backend = await this.router.getBackendForServiceName(serviceName);
    const created = await backend.workspaceRepository.create({
      ...input,
      ...(serviceName ? { serviceName } : {})
    });

    await this.router.registry().upsertWorkspace({
      workspaceId: created.id,
      serviceName,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt
    });

    return created;
  }

  async upsert(input: WorkspaceRecord): Promise<WorkspaceRecord> {
    const existing = await this.router.getWorkspaceRegistry(input.id);
    const existingServiceName = normalizeServiceName(existing?.serviceName);
    const nextServiceName = normalizeServiceName(input.serviceName) ?? existingServiceName;

    if (existing && normalizeServiceName(input.serviceName) && existingServiceName !== normalizeServiceName(input.serviceName)) {
      throw new AppError(
        409,
        "workspace_service_name_immutable",
        `Workspace ${input.id} serviceName cannot be changed after the workspace has been created.`
      );
    }

    const backend = await this.router.getBackendForServiceName(nextServiceName);
    const updated = await backend.workspaceRepository.upsert({
      ...input,
      ...(nextServiceName ? { serviceName: nextServiceName } : {})
    });

    await this.router.registry().upsertWorkspace({
      workspaceId: updated.id,
      serviceName: nextServiceName,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt
    });

    return updated;
  }

  async getById(id: string): Promise<WorkspaceRecord | null> {
    const registryEntry = await this.router.getWorkspaceRegistry(id);
    if (!registryEntry) {
      return null;
    }

    return (await this.router.getBackendForServiceName(registryEntry.serviceName)).workspaceRepository.getById(id);
  }

  async list(pageSize: number, cursor?: string): Promise<WorkspaceRecord[]> {
    const entries = await this.router.registry().listWorkspaces(pageSize, cursor);
    const items = await Promise.all(
      entries.map(async (entry) =>
        (await this.router.getBackendForServiceName(entry.serviceName)).workspaceRepository.getById(entry.workspaceId)
      )
    );

    return items.filter((item): item is WorkspaceRecord => item !== null);
  }

  async delete(id: string): Promise<void> {
    const registryEntry = await this.router.getWorkspaceRegistry(id);
    if (registryEntry) {
      await (await this.router.getBackendForServiceName(registryEntry.serviceName)).workspaceRepository.delete(id);
    }

    await this.router.registry().deleteWorkspace(id);
  }
}

class RoutedSessionRepository implements SessionRepository {
  constructor(private readonly router: ServiceBackendRouter) {}

  async create(input: Session): Promise<Session> {
    const serviceName = await this.router.getWorkspaceServiceName(input.workspaceId);
    const created = await (await this.router.getBackendForServiceName(serviceName)).sessionRepository.create(input);
    await this.router.registry().upsertSession(created, serviceName);
    return created;
  }

  async getById(id: string): Promise<Session | null> {
    const session = await this.router.getSessionRegistry(id);
    if (!session) {
      return null;
    }

    const { serviceName: _serviceName, ...entry } = session;
    return entry;
  }

  async update(input: Session): Promise<Session> {
    const existing = await this.router.getSessionRegistry(input.id);
    const serviceName = existing?.serviceName ?? (await this.router.getWorkspaceServiceName(input.workspaceId));
    const updated = await (await this.router.getBackendForServiceName(serviceName)).sessionRepository.update(input);
    await this.router.registry().upsertSession(updated, serviceName);
    return updated;
  }

  listByWorkspaceId(workspaceId: string, pageSize: number, cursor?: string): Promise<Session[]> {
    return this.router.registry().listSessionsByWorkspaceId(workspaceId, pageSize, cursor);
  }

  listChildrenByParentSessionId(parentSessionId: string, pageSize: number, cursor?: string): Promise<Session[]> {
    return this.router.registry().listChildSessions(parentSessionId, pageSize, cursor);
  }

  async delete(id: string): Promise<void> {
    const existing = await this.router.getSessionRegistry(id);
    if (existing) {
      await (await this.router.getBackendForServiceName(existing.serviceName)).sessionRepository.delete(id);
    }

    await this.router.registry().deleteSession(id);
  }
}

class RoutedRunRepository implements RunRepository {
  constructor(private readonly router: ServiceBackendRouter) {}

  async create(input: Run): Promise<Run> {
    const serviceName = await this.router.getWorkspaceServiceName(input.workspaceId);
    const created = await (await this.router.getBackendForServiceName(serviceName)).runRepository.create(input);
    await this.router.registry().upsertRun(created, serviceName);
    return created;
  }

  async getById(id: string): Promise<Run | null> {
    const run = await this.router.getRunRegistry(id);
    if (!run) {
      return null;
    }

    const { serviceName: _serviceName, ...entry } = run;
    return entry;
  }

  async update(input: Run): Promise<Run> {
    const existing = await this.router.getRunRegistry(input.id);
    const serviceName = existing?.serviceName ?? (await this.router.getWorkspaceServiceName(input.workspaceId));
    const updated = await (await this.router.getBackendForServiceName(serviceName)).runRepository.update(input);
    await this.router.registry().upsertRun(updated, serviceName);
    return updated;
  }

  listBySessionId(sessionId: string): Promise<Run[]> {
    return this.router.registry().listRunsBySessionId(sessionId);
  }

  listRecoverableActiveRuns(staleBefore: string, limit: number): Promise<Run[]> {
    return this.router.registry().listRecoverableActiveRuns(staleBefore, limit);
  }
}

class RoutedMessageRepository implements MessageRepository {
  constructor(private readonly router: ServiceBackendRouter) {}

  async create(input: Message): Promise<Message> {
    return (await this.router.getBackendForSessionId(input.sessionId)).messageRepository.create(input);
  }

  async getById(id: string): Promise<Message | null> {
    return this.router.findAcrossKnownBackends((backend) => backend.messageRepository.getById(id));
  }

  async update(input: Message): Promise<Message> {
    return (await this.router.getBackendForSessionId(input.sessionId)).messageRepository.update(input);
  }

  async listBySessionId(sessionId: string): Promise<Message[]> {
    return (await this.router.getBackendForSessionId(sessionId)).messageRepository.listBySessionId(sessionId);
  }

  async listPageBySessionId(input: {
    sessionId: string;
    pageSize: number;
    cursor?: string | undefined;
    direction?: "forward" | "backward" | undefined;
  }): Promise<{ items: Message[]; hasMore: boolean }> {
    return (await this.router.getBackendForSessionId(input.sessionId)).messageRepository.listPageBySessionId(input);
  }
}

class RoutedEngineMessageRepository implements EngineMessageRepository {
  constructor(private readonly router: ServiceBackendRouter) {}

  async replaceBySessionId(sessionId: string, messages: EngineMessage[]): Promise<void> {
    await (await this.router.getBackendForSessionId(sessionId)).engineMessageRepository.replaceBySessionId(sessionId, messages);
  }

  async listBySessionId(sessionId: string): Promise<EngineMessage[]> {
    return (await this.router.getBackendForSessionId(sessionId)).engineMessageRepository.listBySessionId(sessionId);
  }
}

class RoutedRunStepRepository implements RunStepRepository {
  constructor(private readonly router: ServiceBackendRouter) {}

  async create(input: RunStep): Promise<RunStep> {
    return (await this.router.getBackendForRunId(input.runId)).runStepRepository.create(input);
  }

  async update(input: RunStep): Promise<RunStep> {
    return (await this.router.getBackendForRunId(input.runId)).runStepRepository.update(input);
  }

  async listByRunId(runId: string): Promise<RunStep[]> {
    return (await this.router.getBackendForRunId(runId)).runStepRepository.listByRunId(runId);
  }
}

class RoutedSessionPendingRunQueueRepository implements SessionPendingRunQueueRepository {
  constructor(private readonly router: ServiceBackendRouter) {}

  async enqueue(input: {
    sessionId: string;
    runId: string;
    createdAt: string;
  }): Promise<SessionPendingRunQueueEntry> {
    return (await this.router.getBackendForSessionId(input.sessionId)).sessionPendingRunQueueRepository.enqueue(input);
  }

  async listBySessionId(sessionId: string): Promise<SessionPendingRunQueueEntry[]> {
    return (await this.router.getBackendForSessionId(sessionId)).sessionPendingRunQueueRepository.listBySessionId(sessionId);
  }

  async getByRunId(runId: string): Promise<SessionPendingRunQueueEntry | null> {
    return (await this.router.getBackendForRunId(runId)).sessionPendingRunQueueRepository.getByRunId(runId);
  }

  async promote(runId: string): Promise<void> {
    await (await this.router.getBackendForRunId(runId)).sessionPendingRunQueueRepository.promote(runId);
  }

  async dequeueNext(sessionId: string): Promise<SessionPendingRunQueueEntry | null> {
    return (await this.router.getBackendForSessionId(sessionId)).sessionPendingRunQueueRepository.dequeueNext(sessionId);
  }

  async remove(runId: string): Promise<void> {
    await (await this.router.getBackendForRunId(runId)).sessionPendingRunQueueRepository.remove(runId);
  }
}

class RoutedSessionEventStore implements SessionEventStore {
  constructor(private readonly router: ServiceBackendRouter) {}

  async append(input: Omit<SessionEvent, "id" | "cursor" | "createdAt">): Promise<SessionEvent> {
    return (await this.router.getBackendForSessionId(input.sessionId)).sessionEventStore.append(input);
  }

  async deleteById(eventId: string): Promise<void> {
    await this.router.fanOutKnownBackends((backend) => backend.sessionEventStore.deleteById(eventId));
  }

  async listSince(sessionId: string, cursor?: string, runId?: string, limit?: number): Promise<SessionEvent[]> {
    return (await this.router.getBackendForSessionId(sessionId)).sessionEventStore.listSince(sessionId, cursor, runId, limit);
  }

  subscribe(sessionId: string, listener: (event: SessionEvent) => void): () => void {
    let unsubscribed = false;
    let unsubscribe: () => void = () => {};

    void this.router.getBackendForSessionId(sessionId).then((backend) => {
      if (unsubscribed) {
        return;
      }

      unsubscribe = backend.sessionEventStore.subscribe(sessionId, listener);
    });

    return () => {
      unsubscribed = true;
      unsubscribe();
    };
  }
}

class RoutedToolCallAuditRepository implements ToolCallAuditRepository {
  constructor(private readonly router: ServiceBackendRouter) {}

  async create(input: ToolCallAuditRecord): Promise<ToolCallAuditRecord> {
    return (await this.router.getBackendForRunId(input.runId)).toolCallAuditRepository.create(input);
  }
}

class RoutedHookRunAuditRepository implements HookRunAuditRepository {
  constructor(private readonly router: ServiceBackendRouter) {}

  async create(input: HookRunAuditRecord): Promise<HookRunAuditRecord> {
    return (await this.router.getBackendForRunId(input.runId)).hookRunAuditRepository.create(input);
  }
}

class RoutedArtifactRepository implements ArtifactRepository {
  constructor(private readonly router: ServiceBackendRouter) {}

  async create(input: ArtifactRecord): Promise<ArtifactRecord> {
    return (await this.router.getBackendForRunId(input.runId)).artifactRepository.create(input);
  }

  async listByRunId(runId: string): Promise<ArtifactRecord[]> {
    return (await this.router.getBackendForRunId(runId)).artifactRepository.listByRunId(runId);
  }
}

class RoutedAgentTaskRepository implements AgentTaskRepository {
  constructor(private readonly router: ServiceBackendRouter) {}

  async upsert(input: AgentTaskRecord): Promise<AgentTaskRecord> {
    return (await this.router.getBackendForWorkspaceId(input.workspaceId)).agentTaskRepository.upsert(input);
  }

  async getByTaskId(taskId: string): Promise<AgentTaskRecord | null> {
    const sessionBackend = await this.router.getBackendForSessionId(taskId);
    const bySession = await sessionBackend.agentTaskRepository.getByTaskId(taskId);
    if (bySession) {
      return bySession;
    }

    return this.router.findAcrossKnownBackends((backend) => backend.agentTaskRepository.getByTaskId(taskId));
  }

  async update(input: {
    taskId: string;
    status: AgentTaskRecord["status"];
    updatedAt: string;
    toolUseId?: string | undefined;
    outputRef?: string | undefined;
    outputFile?: string | undefined;
    finalText?: string | undefined;
    errorMessage?: string | undefined;
    usage?: Record<string, unknown> | undefined;
    notifiedAt?: string | undefined;
  }): Promise<AgentTaskRecord> {
    const existing = await this.getByTaskId(input.taskId);
    if (existing) {
      return (await this.router.getBackendForWorkspaceId(existing.workspaceId)).agentTaskRepository.update(input);
    }

    return (await this.router.getBackendForSessionId(input.taskId)).agentTaskRepository.update(input);
  }
}

class RoutedAgentTaskNotificationRepository implements AgentTaskNotificationRepository {
  constructor(private readonly router: ServiceBackendRouter) {}

  async create(input: AgentTaskNotificationRecord): Promise<AgentTaskNotificationRecord> {
    return (await this.router.getBackendForSessionId(input.parentSessionId)).agentTaskNotificationRepository.create(input);
  }

  async listPendingBySessionId(parentSessionId: string): Promise<AgentTaskNotificationRecord[]> {
    return (await this.router.getBackendForSessionId(parentSessionId)).agentTaskNotificationRepository.listPendingBySessionId(
      parentSessionId
    );
  }

  async markConsumed(input: { ids: string[]; consumedAt: string }): Promise<void> {
    if (input.ids.length === 0) {
      return;
    }

    await this.router.fanOutKnownBackends((backend) => backend.agentTaskNotificationRepository.markConsumed(input));
  }
}

class RoutedHistoryEventRepository implements HistoryEventRepository {
  constructor(private readonly router: ServiceBackendRouter) {}

  async append(input: Omit<HistoryEventRecord, "id">): Promise<HistoryEventRecord> {
    return (await this.router.getBackendForWorkspaceId(input.workspaceId)).historyEventRepository.append(input);
  }

  async listByWorkspaceId(workspaceId: string, limit: number, afterId?: number): Promise<HistoryEventRecord[]> {
    return (await this.router.getBackendForWorkspaceId(workspaceId)).historyEventRepository.listByWorkspaceId(
      workspaceId,
      limit,
      afterId
    );
  }
}

class RoutedWorkspaceArchiveRepository implements WorkspaceArchiveRepository {
  constructor(private readonly router: ServiceBackendRouter) {}

  async archiveWorkspace(input: {
    workspace: WorkspaceRecord;
    archiveDate: string;
    archivedAt: string;
    deletedAt: string;
    timezone: string;
  }): Promise<WorkspaceArchiveRecord> {
    return (await this.router.getBackendForServiceName(input.workspace.serviceName)).workspaceArchiveRepository.archiveWorkspace(input);
  }

  async archiveSessionTree(input: {
    workspace: WorkspaceRecord;
    rootSessionId: string;
    sessionIds: string[];
    archiveDate: string;
    archivedAt: string;
    deletedAt: string;
    timezone: string;
  }): Promise<WorkspaceArchiveRecord> {
    return (await this.router.getBackendForServiceName(input.workspace.serviceName)).workspaceArchiveRepository.archiveSessionTree(input);
  }

  async listPendingArchiveDates(beforeArchiveDate: string, limit: number): Promise<string[]> {
    const dates = new Set<string>();
    for (const backend of await this.router.listKnownBackends()) {
      for (const archiveDate of await backend.workspaceArchiveRepository.listPendingArchiveDates(beforeArchiveDate, limit)) {
        dates.add(archiveDate);
      }
    }

    return [...dates].sort((left, right) => left.localeCompare(right)).slice(0, limit);
  }

  async listByArchiveDate(archiveDate: string): Promise<WorkspaceArchiveRecord[]> {
    const items = (
      await Promise.all(
        (await this.router.listKnownBackends()).map((backend) => backend.workspaceArchiveRepository.listByArchiveDate(archiveDate))
      )
    ).flat();

    return items.sort((left, right) => {
      if (left.archivedAt !== right.archivedAt) {
        return left.archivedAt.localeCompare(right.archivedAt);
      }

      return left.id.localeCompare(right.id);
    });
  }

  async forEachByArchiveDate(
    archiveDate: string,
    visitor: (archive: WorkspaceArchiveRecord) => Promise<void> | void,
    options?: {
      pageSize?: number | undefined;
    }
  ): Promise<number> {
    type IterableWorkspaceArchiveRepository = WorkspaceArchiveRepository & {
      forEachByArchiveDate?: (
        archiveDate: string,
        visitor: (archive: WorkspaceArchiveRecord) => Promise<void> | void,
        options?: {
          pageSize?: number | undefined;
        }
      ) => Promise<number>;
    };

    let count = 0;

    for (const backend of await this.router.listKnownBackends()) {
      const repository = backend.workspaceArchiveRepository as IterableWorkspaceArchiveRepository;
      if (repository.forEachByArchiveDate) {
        count += await repository.forEachByArchiveDate(archiveDate, async (archive: WorkspaceArchiveRecord) => {
          await visitor(archive);
        }, options);
        continue;
      }

      const archives = await repository.listByArchiveDate(archiveDate);
      for (const archive of archives) {
        await visitor(archive);
        count += 1;
      }
    }

    return count;
  }

  async markExported(ids: string[], input: { exportedAt: string; exportPath: string }): Promise<void> {
    await this.router.fanOutKnownBackends((backend) => backend.workspaceArchiveRepository.markExported(ids, input));
  }

  async pruneExportedBefore(beforeArchiveDate: string, limit: number): Promise<number> {
    let remaining = Math.max(0, limit);
    let pruned = 0;

    for (const backend of await this.router.listKnownBackends()) {
      if (remaining <= 0) {
        break;
      }

      const deleted = await backend.workspaceArchiveRepository.pruneExportedBefore(beforeArchiveDate, remaining);
      pruned += deleted;
      remaining -= deleted;
    }

    return pruned;
  }
}

export async function createServiceRoutedPostgresRuntimePersistence(
  options: CreateServiceRoutedPostgresRuntimePersistenceOptions
): Promise<ServiceRoutedPostgresRuntimePersistence> {
  const persistenceFactory = options.persistenceFactory ?? createPostgresRuntimePersistence;
  const defaultBackend = await persistenceFactory({
    connectionString: options.connectionString,
    ...(options.poolConfig ? { poolConfig: options.poolConfig } : {}),
    ...(options.archivePayloadRoot ? { archivePayloadRoot: options.archivePayloadRoot } : {})
  });
  await ensureServiceRoutingRegistrySchema(defaultBackend.pool);
  await migrateServiceRoutingRegistry(defaultBackend.pool);

  const router = new ServiceBackendRouter({
    defaultBackend,
    connectionString: options.connectionString,
    archivePayloadRoot: options.archivePayloadRoot,
    poolConfig: options.poolConfig,
    persistenceFactory,
    registry: new PostgresServiceRoutingRegistry(defaultBackend.pool)
  });

  return {
    pool: defaultBackend.pool,
    workspaceRepository: new RoutedWorkspaceRepository(router),
    workspaceArchiveRepository: new RoutedWorkspaceArchiveRepository(router),
    sessionRepository: new RoutedSessionRepository(router),
    messageRepository: new RoutedMessageRepository(router),
    engineMessageRepository: new RoutedEngineMessageRepository(router),
    runRepository: new RoutedRunRepository(router),
    runStepRepository: new RoutedRunStepRepository(router),
    sessionEventStore: new RoutedSessionEventStore(router),
    sessionPendingRunQueueRepository: new RoutedSessionPendingRunQueueRepository(router),
    toolCallAuditRepository: new RoutedToolCallAuditRepository(router),
    hookRunAuditRepository: new RoutedHookRunAuditRepository(router),
    artifactRepository: new RoutedArtifactRepository(router),
    agentTaskRepository: new RoutedAgentTaskRepository(router),
    agentTaskNotificationRepository: new RoutedAgentTaskNotificationRepository(router),
    historyEventRepository: new RoutedHistoryEventRepository(router),
    async listWorkspaceSnapshots(candidates) {
      const snapshots = new Map<string, WorkspaceRecord>();

      for (const candidate of candidates) {
        const registryEntry = await router.getWorkspaceRegistry(candidate.id);
        const backend = await router.getBackendForServiceName(registryEntry?.serviceName ?? candidate.serviceName);
        const backendSnapshots =
          typeof backend.listWorkspaceSnapshots === "function"
            ? await backend.listWorkspaceSnapshots([candidate])
            : [await backend.workspaceRepository.getById(candidate.id)].filter(
                (workspace): workspace is WorkspaceRecord => workspace !== null
              );

        for (const snapshot of backendSnapshots) {
          snapshots.set(snapshot.id, snapshot);
        }
      }

      return [...snapshots.values()];
    },
    close() {
      return router.close();
    }
  };
}
