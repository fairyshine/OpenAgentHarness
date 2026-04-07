import path from "node:path";
import { watch, type FSWatcher } from "node:fs";
import { access, readdir, rm } from "node:fs/promises";

import {
  type DiscoveredWorkspace,
  discoverWorkspace,
  discoverWorkspaces,
  initializeWorkspaceFromTemplate,
  listWorkspaceTemplates,
  loadPlatformModels,
  loadServerConfig,
  resolveWorkspaceCreationRoot,
  updateWorkspaceHistoryMirrorSetting
} from "@oah/config";
import type { ServerConfig } from "@oah/config";
import { AppError, RuntimeService, createId, parseCursor } from "@oah/runtime-core";
import type {
  RuntimeLogger,
  Run,
  RunRepository,
  Session,
  SessionRepository,
  WorkspaceRecord,
  WorkspaceRepository
} from "@oah/runtime-core";
import { AiSdkModelGateway } from "@oah/model-gateway";
import { createPostgresRuntimePersistence } from "@oah/storage-postgres";
import { createSQLiteRuntimePersistence } from "@oah/storage-sqlite";
import {
  FanoutSessionEventStore,
  RedisRunWorker,
  createRedisSessionEventBus,
  createRedisSessionRunQueue
} from "@oah/storage-redis";
import { HistoryMirrorSyncer, inspectHistoryMirrorStatus } from "./history-mirror.js";
import { createBuiltInPlatformAgents } from "./platform-agents.js";
import { createStorageAdmin, type StorageAdmin } from "./storage-admin.js";

type PlatformAgentRegistry = Record<string, import("@oah/config").DiscoveredAgent>;

export interface BootstrapOptions {
  argv?: string[] | undefined;
  startWorker?: boolean | undefined;
  processKind?: "api" | "worker" | undefined;
  platformAgents?: PlatformAgentRegistry | undefined;
}

export interface RuntimeProcessDescriptor {
  mode: "api_embedded_worker" | "api_only" | "standalone_worker";
  label: "API + embedded worker" | "API only" | "standalone worker";
  execution: "redis_queue" | "local_inline" | "none";
}

export interface BootstrappedRuntime {
  config: Awaited<ReturnType<typeof loadServerConfig>>;
  runtimeService: RuntimeService;
  modelGateway: AiSdkModelGateway;
  process: RuntimeProcessDescriptor;
  workspaceMode:
    | {
        kind: "multi";
      }
    | {
        kind: "single";
        workspaceId: string;
        workspaceKind: "project" | "chat";
        rootPath: string;
      };
  listWorkspaceTemplates?: () => Promise<Array<{ name: string }>>;
  listPlatformModels?: () => Promise<
    Array<{
      id: string;
      provider: string;
      modelName: string;
      url?: string;
      hasKey: boolean;
      metadata?: Record<string, unknown>;
      isDefault: boolean;
    }>
  >;
  importWorkspace?: (input: {
    rootPath: string;
    kind?: "project" | "chat";
    name?: string;
    externalRef?: string;
  }) => Promise<import("@oah/api-contracts").Workspace>;
  getWorkspaceHistoryMirrorStatus(workspace: import("@oah/runtime-core").WorkspaceRecord): Promise<
    import("./history-mirror.js").HistoryMirrorStatus
  >;
  rebuildWorkspaceHistoryMirror(workspace: import("@oah/runtime-core").WorkspaceRecord): Promise<
    import("./history-mirror.js").HistoryMirrorStatus
  >;
  storageAdmin: StorageAdmin;
  healthReport(): Promise<{
    status: "ok" | "degraded";
    storage: {
      primary: "postgres" | "sqlite";
      events: "redis" | "memory";
      runQueue: "redis" | "in_process";
    };
    process: RuntimeProcessDescriptor;
    checks: {
      postgres: "up" | "down" | "not_configured";
      redisEvents: "up" | "down" | "not_configured";
      redisRunQueue: "up" | "down" | "not_configured";
      historyMirror: "up" | "degraded" | "not_configured";
    };
    worker: {
      mode: "embedded" | "external" | "disabled";
    };
    mirror: {
      worker: "running" | "disabled";
      enabledWorkspaces: number;
      idleWorkspaces: number;
      missingWorkspaces: number;
      errorWorkspaces: number;
    };
  }>;
  readinessReport(): Promise<{
    status: "ready" | "not_ready";
    checks: {
      postgres: "up" | "down" | "not_configured";
      redisEvents: "up" | "down" | "not_configured";
      redisRunQueue: "up" | "down" | "not_configured";
    };
  }>;
  close(): Promise<void>;
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isTruthyEnvValue(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/iu.test(value.trim());
}

function buildRuntimeDebugLogger(enabled: boolean): RuntimeLogger | undefined {
  if (!enabled) {
    return undefined;
  }

  return {
    debug(message, details) {
      if (details) {
        console.debug(`[oah-runtime-debug] ${message}`, details);
        return;
      }

      console.debug(`[oah-runtime-debug] ${message}`);
    },
    warn(message, details) {
      if (details) {
        console.warn(`[oah-runtime-debug] ${message}`, details);
        return;
      }

      console.warn(`[oah-runtime-debug] ${message}`);
    },
    error(message, details) {
      if (details) {
        console.error(`[oah-runtime-debug] ${message}`, details);
        return;
      }

      console.error(`[oah-runtime-debug] ${message}`);
    }
  };
}

function workspaceDiscoveryKey(workspace: Pick<WorkspaceRecord, "kind" | "rootPath">): string {
  return `${workspace.kind}:${path.resolve(workspace.rootPath)}`;
}

function managedWorkspaceDirForKind(
  paths: Pick<ServerConfig["paths"], "workspace_dir" | "chat_dir">,
  kind: WorkspaceRecord["kind"]
): string {
  return kind === "chat" ? paths.chat_dir : paths.workspace_dir;
}

function isManagedWorkspace(
  workspace: Pick<WorkspaceRecord, "kind" | "rootPath">,
  paths: Pick<ServerConfig["paths"], "workspace_dir" | "chat_dir">
): boolean {
  return isManagedWorkspaceRoot(workspace.rootPath, managedWorkspaceDirForKind(paths, workspace.kind));
}

async function listAllWorkspaces(repository: WorkspaceRepository): Promise<WorkspaceRecord[]> {
  const workspaces: WorkspaceRecord[] = [];
  let cursor: string | undefined;

  do {
    const page = await repository.list(100, cursor);
    workspaces.push(...page);
    cursor = page.length === 100 ? String((cursor ? Number.parseInt(cursor, 10) : 0) + 100) : undefined;
  } while (cursor);

  return workspaces;
}

export function reconcileDiscoveredWorkspaces(
  discoveredWorkspaces: WorkspaceRecord[],
  persistedWorkspaces: WorkspaceRecord[]
): WorkspaceRecord[] {
  const persistedByKey = new Map<string, WorkspaceRecord[]>();
  for (const workspace of persistedWorkspaces) {
    const key = workspaceDiscoveryKey(workspace);
    const existing = persistedByKey.get(key) ?? [];
    existing.push(workspace);
    persistedByKey.set(key, existing);
  }

  return discoveredWorkspaces.map((workspace) => {
    const persistedGroup = persistedByKey.get(workspaceDiscoveryKey(workspace)) ?? [];
    const persisted = persistedGroup.find((candidate) => candidate.id === workspace.id) ?? persistedGroup[0];
    if (!persisted) {
      return workspace;
    }

    return {
      ...workspace,
      id: persisted.id,
      name: persisted.name,
      executionPolicy: persisted.executionPolicy,
      status: persisted.status,
      createdAt: persisted.createdAt,
      updatedAt: persisted.updatedAt,
      ...(persisted.externalRef ? { externalRef: persisted.externalRef } : {})
    };
  });
}

export function findManagedWorkspaceIdsToDelete(
  discoveredWorkspaces: WorkspaceRecord[],
  persistedWorkspaces: WorkspaceRecord[],
  paths: Pick<ServerConfig["paths"], "workspace_dir" | "chat_dir">
): string[] {
  const discoveredKeys = new Set(discoveredWorkspaces.map((workspace) => workspaceDiscoveryKey(workspace)));
  const canonicalWorkspaceIds = new Set(
    reconcileDiscoveredWorkspaces(discoveredWorkspaces, persistedWorkspaces).map((workspace) => workspace.id)
  );

  return persistedWorkspaces
    .filter((workspace) => isManagedWorkspace(workspace, paths))
    .filter((workspace) => {
      const key = workspaceDiscoveryKey(workspace);
      return !discoveredKeys.has(key) || !canonicalWorkspaceIds.has(workspace.id);
    })
    .map((workspace) => workspace.id);
}

function isManagedWorkspaceRoot(workspaceRoot: string, managedWorkspaceDir: string): boolean {
  const relativePath = path.relative(path.resolve(managedWorkspaceDir), path.resolve(workspaceRoot));
  return relativePath.length > 0 && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

async function discoverProjectWorkspaces(input: {
  workspaceDir: string;
  models: Awaited<ReturnType<typeof loadPlatformModels>>;
  platformAgents: PlatformAgentRegistry;
  platformSkillDir: string;
  platformToolDir: string;
}): Promise<DiscoveredWorkspace[]> {
  const entries = await readdir(input.workspaceDir, {
    withFileTypes: true
  }).catch(() => []);

  const discovered = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) =>
        discoverWorkspace(path.join(input.workspaceDir, entry.name), "project", {
          platformModels: input.models,
          platformAgents: input.platformAgents,
          platformSkillDir: input.platformSkillDir,
          platformToolDir: input.platformToolDir
        } as Parameters<typeof discoverWorkspace>[2])
      )
  );

  return discovered.sort((left, right) => left.rootPath.localeCompare(right.rootPath));
}

function openFsWatcher(targetPath: string, onChange: () => void, recursive = false): FSWatcher | undefined {
  try {
    return watch(
      targetPath,
      {
        persistent: false,
        ...(recursive ? { recursive: true } : {})
      },
      () => onChange()
    );
  } catch {
    if (!recursive) {
      return undefined;
    }

    try {
      return watch(
        targetPath,
        {
          persistent: false
        },
        () => onChange()
      );
    } catch {
      return undefined;
    }
  }
}

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

class ScopedWorkspaceRepository implements WorkspaceRepository {
  constructor(
    private readonly inner: WorkspaceRepository,
    private readonly visibleWorkspaceIds: Set<string>
  ) {}

  async create(input: WorkspaceRecord): Promise<WorkspaceRecord> {
    this.visibleWorkspaceIds.add(input.id);
    return this.inner.create(input);
  }

  async upsert(input: WorkspaceRecord): Promise<WorkspaceRecord> {
    this.visibleWorkspaceIds.add(input.id);
    return this.inner.upsert(input);
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
    this.visibleWorkspaceIds.delete(id);
    await this.inner.delete(id);
  }
}

class ScopedSessionRepository implements SessionRepository {
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

class ScopedRunRepository implements RunRepository {
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

function readFlagValue(argv: string[], flag: string): string | undefined {
  const flagIndex = argv.findIndex((value) => value === flag);
  if (flagIndex < 0) {
    return undefined;
  }

  const value = argv[flagIndex + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }

  return value;
}

interface SingleWorkspaceCliOptions {
  rootPath: string;
  kind: "project" | "chat";
  modelDir?: string | undefined;
  defaultModel?: string | undefined;
  toolDir?: string | undefined;
  skillDir?: string | undefined;
  host?: string | undefined;
  port?: number | undefined;
}

export function parseSingleWorkspaceOptions(argv: string[]): SingleWorkspaceCliOptions | undefined {
  const workspaceRoot = readFlagValue(argv, "--workspace");
  if (!workspaceRoot) {
    return undefined;
  }

  const workspaceKind = readFlagValue(argv, "--workspace-kind") ?? "project";
  if (workspaceKind !== "project" && workspaceKind !== "chat") {
    throw new Error(`Invalid value for --workspace-kind: ${workspaceKind}`);
  }

  const portValue = readFlagValue(argv, "--port");
  let port: number | undefined;
  if (portValue !== undefined) {
    const parsed = Number.parseInt(portValue, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new Error(`Invalid value for --port: ${portValue}`);
    }
    port = parsed;
  }

  return {
    rootPath: path.resolve(process.cwd(), workspaceRoot),
    kind: workspaceKind,
    ...(readFlagValue(argv, "--model-dir") ? { modelDir: path.resolve(process.cwd(), readFlagValue(argv, "--model-dir")!) } : {}),
    ...(readFlagValue(argv, "--default-model") ? { defaultModel: readFlagValue(argv, "--default-model") } : {}),
    ...(readFlagValue(argv, "--tool-dir") ? { toolDir: path.resolve(process.cwd(), readFlagValue(argv, "--tool-dir")!) } : {}),
    ...(readFlagValue(argv, "--skill-dir") ? { skillDir: path.resolve(process.cwd(), readFlagValue(argv, "--skill-dir")!) } : {}),
    ...(readFlagValue(argv, "--host") ? { host: readFlagValue(argv, "--host") } : {}),
    ...(port !== undefined ? { port } : {})
  };
}

function buildSingleWorkspaceConfig(
  baseConfig: Awaited<ReturnType<typeof loadServerConfig>> | undefined,
  singleWorkspace: SingleWorkspaceCliOptions
): ServerConfig {
  const modelDir = singleWorkspace.modelDir ?? baseConfig?.paths.model_dir;
  const defaultModel = singleWorkspace.defaultModel ?? baseConfig?.llm.default_model;
  if (!modelDir) {
    throw new Error("Single-workspace mode requires --model-dir or config.paths.model_dir.");
  }
  if (!defaultModel) {
    throw new Error("Single-workspace mode requires --default-model or config.llm.default_model.");
  }

  return {
    server: {
      host: singleWorkspace.host ?? baseConfig?.server.host ?? "127.0.0.1",
      port: singleWorkspace.port ?? baseConfig?.server.port ?? 8787
    },
    storage: {
      ...(baseConfig?.storage ?? {})
    },
    paths: {
      workspace_dir: baseConfig?.paths.workspace_dir ?? path.dirname(singleWorkspace.rootPath),
      chat_dir: baseConfig?.paths.chat_dir ?? path.dirname(singleWorkspace.rootPath),
      template_dir: baseConfig?.paths.template_dir ?? path.join(singleWorkspace.rootPath, ".openharness", "__templates__"),
      model_dir: modelDir,
      tool_dir: singleWorkspace.toolDir ?? baseConfig?.paths.tool_dir ?? path.join(singleWorkspace.rootPath, ".openharness", "__platform_tools__"),
      skill_dir:
        singleWorkspace.skillDir ?? baseConfig?.paths.skill_dir ?? path.join(singleWorkspace.rootPath, ".openharness", "__platform_skills__")
    },
    llm: {
      default_model: defaultModel
    }
  };
}

export function parseConfigPath(argv: string[]): { path: string; explicit: boolean } {
  const configFlagIndex = argv.findIndex((value) => value === "--config");
  if (configFlagIndex >= 0) {
    const configPath = argv[configFlagIndex + 1];
    if (!configPath) {
      throw new Error("Missing value for --config.");
    }

    return {
      path: path.resolve(process.cwd(), configPath),
      explicit: true
    };
  }

  const envPath = process.env.OAH_CONFIG;
  if (envPath) {
    return {
      path: path.resolve(process.cwd(), envPath),
      explicit: true
    };
  }

  return {
    path: path.resolve(process.cwd(), "server.yaml"),
    explicit: false
  };
}

export function shouldStartEmbeddedWorker(argv: string[]): boolean {
  if (argv.includes("--api-only") || argv.includes("--no-worker")) {
    return false;
  }

  const inlineWorkerEnv = process.env.OAH_INLINE_WORKER;
  if (inlineWorkerEnv !== undefined) {
    return !["0", "false", "off"].includes(inlineWorkerEnv.toLowerCase());
  }

  return true;
}

export const shouldStartInlineWorker = shouldStartEmbeddedWorker;

export function describeRuntimeProcess(options: {
  processKind: "api" | "worker";
  startWorker: boolean;
  hasRedisRunQueue: boolean;
}): RuntimeProcessDescriptor {
  if (options.processKind === "worker") {
    return {
      mode: "standalone_worker",
      label: "standalone worker",
      execution: options.hasRedisRunQueue ? "redis_queue" : "none"
    };
  }

  if (options.startWorker) {
    return {
      mode: "api_embedded_worker",
      label: "API + embedded worker",
      execution: options.hasRedisRunQueue ? "redis_queue" : "local_inline"
    };
  }

  return {
    mode: "api_only",
    label: "API only",
    execution: options.hasRedisRunQueue ? "redis_queue" : "local_inline"
  };
}

export function shouldRunHistoryMirrorSync(options: {
  processKind: "api" | "worker";
  startWorker: boolean;
  hasRedisRunQueue: boolean;
}): boolean {
  if (options.processKind === "worker") {
    return true;
  }

  if (options.startWorker) {
    return true;
  }

  return !options.hasRedisRunQueue;
}

export async function bootstrapRuntime(options: BootstrapOptions = {}): Promise<BootstrappedRuntime> {
  const argv = options.argv ?? process.argv.slice(2);
  const startWorker = options.startWorker ?? false;
  const processKind = options.processKind ?? "api";
  const singleWorkspace = parseSingleWorkspaceOptions(argv);
  const requestedConfig = parseConfigPath(argv);
  const config =
    singleWorkspace !== undefined
      ? buildSingleWorkspaceConfig(
          (await fileExists(requestedConfig.path))
            ? await loadServerConfig(requestedConfig.path)
            : requestedConfig.explicit
              ? await loadServerConfig(requestedConfig.path)
              : undefined,
          singleWorkspace
        )
      : await loadServerConfig(
          (await fileExists(requestedConfig.path))
            ? requestedConfig.path
            : requestedConfig.explicit
              ? requestedConfig.path
              : path.resolve(process.cwd(), "server.example.yaml")
        );
  const modelDir = config.paths.model_dir;
  const toolDir = config.paths.tool_dir;
  const models = await loadPlatformModels(modelDir);
  const platformAgents: PlatformAgentRegistry = {
    ...createBuiltInPlatformAgents(),
    ...(options.platformAgents ?? {})
  };
  const discoveredWorkspaces =
    singleWorkspace !== undefined
      ? [
          await discoverWorkspace(singleWorkspace.rootPath, singleWorkspace.kind, {
            platformModels: models,
            platformAgents,
            platformSkillDir: config.paths.skill_dir,
            platformToolDir: toolDir
          } as Parameters<typeof discoverWorkspace>[2])
        ]
      : await discoverWorkspaces({
          paths: config.paths,
          platformModels: models,
          platformAgents
        } as Parameters<typeof discoverWorkspaces>[0]);
  const runtimeDebugLogger = buildRuntimeDebugLogger(isTruthyEnvValue(process.env.OAH_RUNTIME_DEBUG));
  const modelGateway = new AiSdkModelGateway({
    defaultModelName: config.llm.default_model,
    models,
    logger: runtimeDebugLogger
  });
  const postgresConfigured = Boolean(config.storage.postgres_url && config.storage.postgres_url.trim().length > 0);
  const persistence = postgresConfigured
    ? await createPostgresRuntimePersistence({
        connectionString: config.storage.postgres_url
      }).catch((error) => {
        throw new Error(
          `Configured PostgreSQL persistence is unavailable: ${error instanceof Error ? error.message : "unknown error"}`
        );
      })
    : await createSQLiteRuntimePersistence({
        shadowRoot: path.join(config.paths.workspace_dir, ".openharness", "data", "workspace-state")
      });
  const primaryStorageMode = "driver" in persistence && persistence.driver === "sqlite" ? "sqlite" : "postgres";
  const redisBus =
    config.storage.redis_url && config.storage.redis_url.trim().length > 0
      ? await createRedisSessionEventBus({
          url: config.storage.redis_url
        }).catch((error) => {
          console.warn(
            `Redis event bus unavailable (${error instanceof Error ? error.message : "unknown error"}); continuing without Redis fanout.`
          );
          return undefined;
        })
      : undefined;
  const redisRunQueue =
    config.storage.redis_url && config.storage.redis_url.trim().length > 0
      ? await createRedisSessionRunQueue({
          url: config.storage.redis_url
        }).catch((error) => {
          console.warn(
            `Redis run queue unavailable (${error instanceof Error ? error.message : "unknown error"}); continuing with in-process scheduling.`
          );
          return undefined;
        })
      : undefined;
  const redisConfigured = Boolean(config.storage.redis_url && config.storage.redis_url.trim().length > 0);
  const storageAdmin = createStorageAdmin({
    ...("pool" in persistence ? { postgresPool: persistence.pool } : {}),
    redisUrl: config.storage.redis_url,
    redisAvailable: redisConfigured,
    redisEventBusEnabled: Boolean(redisBus),
    redisRunQueueEnabled: Boolean(redisRunQueue)
  });
  const runtimeProcess = describeRuntimeProcess({
    processKind,
    startWorker,
    hasRedisRunQueue: Boolean(redisRunQueue)
  });
  const workerMode = startWorker ? "embedded" : redisRunQueue ? "external" : "disabled";
  const sessionEventStore = redisBus
    ? new FanoutSessionEventStore(persistence.sessionEventStore, redisBus)
    : persistence.sessionEventStore;
  const persistedWorkspaceSnapshots =
    "listWorkspaceSnapshots" in persistence
      ? await persistence.listWorkspaceSnapshots(discoveredWorkspaces as WorkspaceRecord[])
      : await listAllWorkspaces(persistence.workspaceRepository);
  const reconciledWorkspaces = reconcileDiscoveredWorkspaces(
    discoveredWorkspaces,
    persistedWorkspaceSnapshots
  );
  const visibleWorkspaceIds = new Set<string>();
  const workspaceRepository = new ScopedWorkspaceRepository(persistence.workspaceRepository, visibleWorkspaceIds);
  const sessionRepository = new ScopedSessionRepository(persistence.sessionRepository, visibleWorkspaceIds);
  const runRepository = new ScopedRunRepository(persistence.runRepository, visibleWorkspaceIds);
  let workspaceRegistrySyncPromise: Promise<void> | undefined;
  let lastWorkspaceRegistrySyncAt = 0;
  let workspaceRegistryPollTimer: NodeJS.Timeout | undefined;
  let watchedProjectRoots = new Map<string, FSWatcher>();
  const rootWorkspaceWatcher =
    singleWorkspace === undefined ? openFsWatcher(config.paths.workspace_dir, scheduleWorkspaceRegistrySync) : undefined;
  let workspaceSyncTimer: NodeJS.Timeout | undefined;

  reconciledWorkspaces.forEach((workspace) => {
    visibleWorkspaceIds.add(workspace.id);
  });
  await Promise.all(reconciledWorkspaces.map((workspace) => workspaceRepository.upsert(workspace)));

  const syncWorkspaceRegistry =
    singleWorkspace === undefined
      ? async () => {
          const now = Date.now();
          if (workspaceRegistrySyncPromise) {
            return workspaceRegistrySyncPromise;
          }
          if (now - lastWorkspaceRegistrySyncAt < 200) {
            return;
          }

          workspaceRegistrySyncPromise = (async () => {
            const latestProjectWorkspaces = await discoverProjectWorkspaces({
              workspaceDir: config.paths.workspace_dir,
              models,
              platformAgents,
              platformSkillDir: config.paths.skill_dir,
              platformToolDir: toolDir
            });
            const persistedWorkspaces = await listAllWorkspaces(persistence.workspaceRepository);
            const staticWorkspaces = persistedWorkspaces.filter(
              (workspace) => workspace.kind === "chat" || !isManagedWorkspace(workspace, config.paths)
            );
            const latestDiscoveredWorkspaces = [...latestProjectWorkspaces, ...staticWorkspaces];
            const staleWorkspaceIds = findManagedWorkspaceIdsToDelete(latestDiscoveredWorkspaces, persistedWorkspaces, config.paths);

            await Promise.all(staleWorkspaceIds.map(async (workspaceId) => persistence.workspaceRepository.delete(workspaceId)));

            const latestPersistedWorkspaces =
              staleWorkspaceIds.length > 0 ? await listAllWorkspaces(persistence.workspaceRepository) : persistedWorkspaces;
            const latestReconciledWorkspaces = reconcileDiscoveredWorkspaces(
              latestDiscoveredWorkspaces,
              latestPersistedWorkspaces
            );

            await Promise.all(latestReconciledWorkspaces.map(async (workspace) => persistence.workspaceRepository.upsert(workspace)));

            visibleWorkspaceIds.clear();
            latestReconciledWorkspaces.forEach((workspace) => {
              visibleWorkspaceIds.add(workspace.id);
            });
            updateWatchedProjectRoots(latestReconciledWorkspaces);
            lastWorkspaceRegistrySyncAt = Date.now();
          })().finally(() => {
            workspaceRegistrySyncPromise = undefined;
          });

          return workspaceRegistrySyncPromise;
        }
      : undefined;

  function updateWatchedProjectRoots(workspaces: WorkspaceRecord[]): void {
    if (singleWorkspace !== undefined) {
      return;
    }

    const nextRoots = new Set(
      workspaces
        .filter((workspace) => workspace.kind === "project" && isManagedWorkspaceRoot(workspace.rootPath, config.paths.workspace_dir))
        .map((workspace) => workspace.rootPath)
    );

    for (const [rootPath, watcher] of watchedProjectRoots.entries()) {
      if (nextRoots.has(rootPath)) {
        continue;
      }

      watcher.close();
      watchedProjectRoots.delete(rootPath);
    }

    for (const rootPath of nextRoots) {
      if (watchedProjectRoots.has(rootPath)) {
        continue;
      }

      const watcher = openFsWatcher(rootPath, scheduleWorkspaceRegistrySync, true);
      if (watcher) {
        watchedProjectRoots.set(rootPath, watcher);
      }
    }
  }

  function scheduleWorkspaceRegistrySync(): void {
    if (!syncWorkspaceRegistry) {
      return;
    }

    if (workspaceSyncTimer) {
      clearTimeout(workspaceSyncTimer);
    }

    workspaceSyncTimer = setTimeout(() => {
      workspaceSyncTimer = undefined;
      void syncWorkspaceRegistry().catch((error) => {
        console.warn("Workspace registry sync failed.", error);
      });
    }, 150);
    workspaceSyncTimer.unref?.();
  }
  const workspaceMode =
    singleWorkspace !== undefined
      ? {
        kind: "single" as const,
          workspaceId: reconciledWorkspaces[0]!.id,
          workspaceKind: reconciledWorkspaces[0]!.kind,
          rootPath: reconciledWorkspaces[0]!.rootPath
        }
        : {
          kind: "multi" as const
        };
  updateWatchedProjectRoots(reconciledWorkspaces);
  if (syncWorkspaceRegistry) {
    await syncWorkspaceRegistry();
    workspaceRegistryPollTimer = setInterval(() => {
      void syncWorkspaceRegistry().catch((error) => {
        console.warn("Workspace registry poll sync failed.", error);
      });
    }, 2_000);
    workspaceRegistryPollTimer.unref?.();
  }
  const runtimeService = new RuntimeService({
    defaultModel: config.llm.default_model,
    modelGateway,
    logger: runtimeDebugLogger,
    platformModels: models,
    ...persistence,
    workspaceRepository,
    sessionRepository,
    runRepository,
    sessionEventStore,
    runQueue: redisRunQueue,
    ...(singleWorkspace === undefined
      ? {
          workspaceDeletionHandler: {
            async deleteWorkspace(workspace) {
              if (workspace.kind !== "project") {
                return;
              }

              if (!isManagedWorkspaceRoot(workspace.rootPath, config.paths.workspace_dir)) {
                return;
              }

              await rm(workspace.rootPath, {
                recursive: true,
                force: true
              });
            }
          }
        }
      : {}),
    workspaceSettingsManager: {
      async updateHistoryMirrorEnabled(workspace, enabled) {
        await updateWorkspaceHistoryMirrorSetting(workspace.rootPath, enabled);
        const refreshed = await discoverWorkspace(workspace.rootPath, workspace.kind, {
          platformModels: models,
          platformAgents,
          platformSkillDir: config.paths.skill_dir,
          platformToolDir: toolDir
        } as Parameters<typeof discoverWorkspace>[2]);
        return workspaceRepository.upsert({
          ...refreshed,
          name: workspace.name,
          executionPolicy: workspace.executionPolicy,
          status: workspace.status,
          createdAt: workspace.createdAt,
          externalRef: workspace.externalRef
        });
      }
    },
    ...(singleWorkspace === undefined
      ? {
          workspaceInitializer: {
            async initialize(input) {
              const workspaceId = createId("ws");
              const workspaceRoot = resolveWorkspaceCreationRoot({
                workspaceDir: config.paths.workspace_dir,
                name: input.name,
                workspaceId,
                rootPath: input.rootPath
              });

              await initializeWorkspaceFromTemplate(
                {
                  templateDir: config.paths.template_dir,
                  templateName: input.template,
                  rootPath: workspaceRoot,
                  agentsMd: input.agentsMd,
                  toolServers: (input as typeof input & { toolServers?: Record<string, Record<string, unknown>> | undefined }).toolServers,
                  skills: input.skills
                } as Parameters<typeof initializeWorkspaceFromTemplate>[0]
              );

              const discovered = await discoverWorkspace(workspaceRoot, "project", {
                platformModels: models,
                platformAgents,
                platformSkillDir: config.paths.skill_dir,
                platformToolDir: toolDir
              } as Parameters<typeof discoverWorkspace>[2]);

              return {
                ...discovered,
                id: workspaceId
              };
            }
          }
        }
      : {})
  });
  const redisRunWorker =
    startWorker && redisRunQueue
      ? new RedisRunWorker({
          queue: redisRunQueue,
          runtimeService,
          logger: {
            warn(message, error) {
              console.warn(message, error);
            },
            error(message, error) {
              console.error(message, error);
            }
          }
        })
      : undefined;
  redisRunWorker?.start();
  const historyMirrorSyncer =
    primaryStorageMode === "postgres" &&
    shouldRunHistoryMirrorSync({
      processKind,
      startWorker,
      hasRedisRunQueue: Boolean(redisRunQueue)
    }) &&
    "historyEventRepository" in persistence &&
    persistence.historyEventRepository
      ? new HistoryMirrorSyncer({
          workspaceRepository,
          historyEventRepository: persistence.historyEventRepository,
          logger: {
            warn(message, error) {
              console.warn(message, error);
            },
            error(message, error) {
              console.error(message, error);
            }
          }
        })
      : undefined;
  historyMirrorSyncer?.start();

  const closePersistence =
    "close" in persistence && typeof persistence.close === "function" ? () => persistence.close() : async () => undefined;

  async function postgresCheck(): Promise<"up" | "down" | "not_configured"> {
    if (!postgresConfigured) {
      return "not_configured";
    }

    if (primaryStorageMode !== "postgres" || !("pool" in persistence)) {
      return "down";
    }

    try {
      await persistence.pool.query("select 1");
      return "up";
    } catch {
      return "down";
    }
  }

  async function redisEventsCheck(): Promise<"up" | "down" | "not_configured"> {
    if (!redisConfigured) {
      return "not_configured";
    }

    if (!redisBus) {
      return "down";
    }

    return (await redisBus.ping()) ? "up" : "down";
  }

  async function redisRunQueueCheck(): Promise<"up" | "down" | "not_configured"> {
    if (!redisConfigured) {
      return "not_configured";
    }

    if (!redisRunQueue) {
      return "down";
    }

    return (await redisRunQueue.ping()) ? "up" : "down";
  }

  async function historyMirrorSummary(): Promise<{
    check: "up" | "degraded" | "not_configured";
    worker: "running" | "disabled";
    enabledWorkspaces: number;
    idleWorkspaces: number;
    missingWorkspaces: number;
    errorWorkspaces: number;
  }> {
    if (primaryStorageMode !== "postgres") {
      return {
        check: "not_configured",
        worker: "disabled",
        enabledWorkspaces: 0,
        idleWorkspaces: 0,
        missingWorkspaces: 0,
        errorWorkspaces: 0
      };
    }

    const workspaces: import("@oah/runtime-core").WorkspaceRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await workspaceRepository.list(100, cursor);
      workspaces.push(...page);
      cursor = page.length === 100 ? String((cursor ? Number.parseInt(cursor, 10) : 0) + 100) : undefined;
    } while (cursor);

    const enabledWorkspaces = workspaces.filter((workspace) => workspace.kind === "project" && workspace.historyMirrorEnabled);

    if (enabledWorkspaces.length === 0) {
      return {
        check: "not_configured",
        worker: historyMirrorSyncer ? "running" : "disabled",
        enabledWorkspaces: 0,
        idleWorkspaces: 0,
        missingWorkspaces: 0,
        errorWorkspaces: 0
      };
    }

    const statuses = await Promise.all(enabledWorkspaces.map((workspace) => inspectHistoryMirrorStatus(workspace)));
    const idleWorkspaces = statuses.filter((status) => status.state === "idle").length;
    const missingWorkspaces = statuses.filter((status) => status.state === "missing").length;
    const errorWorkspaces = statuses.filter((status) => status.state === "error").length;
    const degraded = !historyMirrorSyncer || missingWorkspaces > 0 || errorWorkspaces > 0;

    return {
      check: degraded ? "degraded" : "up",
      worker: historyMirrorSyncer ? "running" : "disabled",
      enabledWorkspaces: enabledWorkspaces.length,
      idleWorkspaces,
      missingWorkspaces,
      errorWorkspaces
    };
  }

  return {
    config,
    runtimeService,
    modelGateway,
    process: runtimeProcess,
    workspaceMode,
    listPlatformModels: async () =>
      Object.entries(models).map(([id, definition]) => ({
        id,
        provider: definition.provider,
        modelName: definition.name,
        ...(definition.url ? { url: definition.url } : {}),
        hasKey: Boolean(definition.key),
        ...(definition.metadata ? { metadata: definition.metadata } : {}),
        isDefault: config.llm.default_model === id
      })),
    ...(singleWorkspace === undefined
      ? {
          listWorkspaceTemplates: () => listWorkspaceTemplates(config.paths.template_dir),
          async importWorkspace(input) {
            const discovered = await discoverWorkspace(input.rootPath, input.kind ?? "project", {
              platformModels: models,
              platformAgents,
              platformSkillDir: config.paths.skill_dir,
              platformToolDir: toolDir
            } as Parameters<typeof discoverWorkspace>[2]);
            const existing = await workspaceRepository.getById(discovered.id);
            const persisted = await workspaceRepository.upsert({
              ...discovered,
              name: input.name ?? existing?.name ?? discovered.name,
              createdAt: existing?.createdAt ?? discovered.createdAt,
              externalRef: input.externalRef ?? existing?.externalRef
            });
            return runtimeService.getWorkspace(persisted.id);
          }
        }
      : {}),
    async getWorkspaceHistoryMirrorStatus(workspace) {
      if (primaryStorageMode !== "postgres") {
        return {
          workspaceId: workspace.id,
          supported: false,
          enabled: false,
          state: "unsupported"
        };
      }

      return inspectHistoryMirrorStatus(workspace);
    },
    rebuildWorkspaceHistoryMirror(workspace) {
      if (!historyMirrorSyncer) {
        throw new Error("History mirror rebuild is unavailable because the mirror sync worker is not running.");
      }

      return historyMirrorSyncer.rebuildWorkspace(workspace);
    },
    storageAdmin,
    async healthReport() {
      const mirror = await historyMirrorSummary();
      const checks = {
        postgres: await postgresCheck(),
        redisEvents: await redisEventsCheck(),
        redisRunQueue: await redisRunQueueCheck(),
        historyMirror: mirror.check
      };

      return {
        status: Object.values(checks).some((value) => value === "down" || value === "degraded") ? "degraded" : "ok",
        storage: {
          primary: primaryStorageMode,
          events: redisBus ? "redis" : "memory",
          runQueue: redisRunQueue ? "redis" : "in_process"
        },
        process: runtimeProcess,
        checks,
        worker: {
          mode: workerMode
        },
        mirror
      };
    },
    async readinessReport() {
      const checks = {
        postgres: await postgresCheck(),
        redisEvents: await redisEventsCheck(),
        redisRunQueue: await redisRunQueueCheck()
      };

      return {
        status: Object.values(checks).includes("down") ? "not_ready" : "ready",
        checks
      };
    },
    async close() {
      await Promise.all([
        historyMirrorSyncer?.close() ?? Promise.resolve(),
        redisRunWorker?.close() ?? Promise.resolve(),
        storageAdmin.close(),
        closePersistence(),
        redisBus?.close() ?? Promise.resolve(),
        redisRunQueue?.close() ?? Promise.resolve()
      ]);
      if (workspaceSyncTimer) {
        clearTimeout(workspaceSyncTimer);
      }
      if (workspaceRegistryPollTimer) {
        clearInterval(workspaceRegistryPollTimer);
      }
      rootWorkspaceWatcher?.close();
      for (const watcher of watchedProjectRoots.values()) {
        watcher.close();
      }
      watchedProjectRoots.clear();
    }
  };
}

export function installSignalHandlers(close: () => Promise<void>): void {
  let closing: Promise<void> | undefined;

  const shutdown = () => {
    if (!closing) {
      closing = close().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    }

    return closing;
  };

  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit());
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit());
  });
}
