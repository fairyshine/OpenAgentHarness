import type { ServerConfig } from "@oah/config";
import {
  calculateRedisWorkerPoolSuggestion,
  type RedisRunWorkerPoolRebalanceReason,
  type RedisWorkerRegistryEntry,
  type SessionRunQueue,
  type SessionRunQueuePressure,
  type WorkerRegistry
} from "@oah/storage-redis";

import type { WorkerReplicaTarget, WorkerReplicaTargetResult } from "./scale-target.js";

export interface StandaloneWorkerControllerConfig {
  minReplicas: number;
  maxReplicas: number;
  slotsPerPod: number;
  readySessionsPerWorker: number;
  reservedSubagentCapacity: number;
  scaleIntervalMs: number;
  scaleUpCooldownMs: number;
  scaleDownCooldownMs: number;
  scaleUpSampleSize: number;
  scaleDownSampleSize: number;
  scaleUpBusyRatioThreshold: number;
  scaleUpMaxReadyAgeMs: number;
}

export interface StandaloneWorkerFleetSummary {
  activeReplicas: number;
  busyReplicas: number;
  activeSlots: number;
  busySlots: number;
  idleSlots: number;
  healthyWorkers: RedisWorkerRegistryEntry[];
}

export interface WorkerControllerDecision {
  timestamp: string;
  reason: Exclude<RedisRunWorkerPoolRebalanceReason, "shutdown">;
  suggestedReplicas: number;
  desiredReplicas: number;
  suggestedWorkers: number;
  activeReplicas: number;
  activeSlots: number;
  busySlots: number;
  readySessionCount?: number | undefined;
  oldestSchedulableReadyAgeMs?: number | undefined;
}

export interface WorkerControllerSnapshot {
  running: boolean;
  minReplicas: number;
  maxReplicas: number;
  slotsPerPod: number;
  suggestedReplicas: number;
  desiredReplicas: number;
  suggestedWorkers: number;
  activeReplicas: number;
  busyReplicas: number;
  activeSlots: number;
  busySlots: number;
  idleSlots: number;
  readySessionsPerWorker: number;
  reservedSubagentCapacity: number;
  readySessionCount?: number | undefined;
  subagentReadySessionCount?: number | undefined;
  oldestSchedulableReadyAgeMs?: number | undefined;
  lastRebalanceAt?: string | undefined;
  lastRebalanceReason?: Exclude<RedisRunWorkerPoolRebalanceReason, "shutdown"> | undefined;
  scaleUpPressureStreak: number;
  scaleDownPressureStreak: number;
  scaleUpCooldownRemainingMs: number;
  scaleDownCooldownRemainingMs: number;
  scaleTarget?: WorkerReplicaTargetResult | undefined;
  recentDecisions: WorkerControllerDecision[];
}

export interface WorkerControllerLogger {
  info?(message: string): void;
  warn(message: string, error?: unknown): void;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readRatioEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : fallback;
}

function appendDecision(decisions: WorkerControllerDecision[], nextDecision: WorkerControllerDecision, maxEntries = 8) {
  const lastDecision = decisions.at(-1);
  if (
    lastDecision &&
    lastDecision.reason === nextDecision.reason &&
    lastDecision.suggestedReplicas === nextDecision.suggestedReplicas &&
    lastDecision.desiredReplicas === nextDecision.desiredReplicas &&
    lastDecision.activeReplicas === nextDecision.activeReplicas &&
    lastDecision.activeSlots === nextDecision.activeSlots &&
    lastDecision.busySlots === nextDecision.busySlots &&
    lastDecision.readySessionCount === nextDecision.readySessionCount &&
    lastDecision.oldestSchedulableReadyAgeMs === nextDecision.oldestSchedulableReadyAgeMs
  ) {
    return [...decisions];
  }

  const next = [...decisions, nextDecision];
  return next.length > maxEntries ? next.slice(next.length - maxEntries) : next;
}

function cooldownRemainingMs(lastChangeAtMs: number | undefined, cooldownMs: number, nowMs: number): number {
  if (!lastChangeAtMs || cooldownMs <= 0) {
    return 0;
  }

  return Math.max(0, lastChangeAtMs + cooldownMs - nowMs);
}

export function resolveStandaloneWorkerControllerConfig(config: ServerConfig): StandaloneWorkerControllerConfig {
  const standalone = config.workers?.standalone;
  const controller = config.workers?.controller;
  const minReplicas = readPositiveIntEnv("OAH_STANDALONE_WORKER_MIN_REPLICAS", standalone?.min_replicas ?? 1);
  const maxReplicas = Math.max(
    minReplicas,
    readPositiveIntEnv("OAH_STANDALONE_WORKER_MAX_REPLICAS", standalone?.max_replicas ?? minReplicas)
  );

  return {
    minReplicas,
    maxReplicas,
    slotsPerPod: readPositiveIntEnv("OAH_STANDALONE_WORKER_SLOTS_PER_POD", standalone?.slots_per_pod ?? 1),
    readySessionsPerWorker: readPositiveIntEnv(
      "OAH_STANDALONE_WORKER_READY_SESSIONS_PER_WORKER",
      standalone?.ready_sessions_per_worker ?? 1
    ),
    reservedSubagentCapacity: readNonNegativeIntEnv(
      "OAH_STANDALONE_WORKER_RESERVED_CAPACITY_FOR_SUBAGENT",
      standalone?.reserved_capacity_for_subagent ?? 1
    ),
    scaleIntervalMs: readPositiveIntEnv("OAH_WORKER_CONTROLLER_SCALE_INTERVAL_MS", controller?.scale_interval_ms ?? 5_000),
    scaleUpCooldownMs: readPositiveIntEnv("OAH_WORKER_CONTROLLER_SCALE_UP_COOLDOWN_MS", controller?.cooldown_ms ?? 1_000),
    scaleDownCooldownMs: readPositiveIntEnv(
      "OAH_WORKER_CONTROLLER_SCALE_DOWN_COOLDOWN_MS",
      controller?.cooldown_ms ?? 15_000
    ),
    scaleUpSampleSize: readPositiveIntEnv("OAH_WORKER_CONTROLLER_SCALE_UP_SAMPLE_SIZE", controller?.scale_up_window ?? 2),
    scaleDownSampleSize: readPositiveIntEnv(
      "OAH_WORKER_CONTROLLER_SCALE_DOWN_SAMPLE_SIZE",
      controller?.scale_down_window ?? 3
    ),
    scaleUpBusyRatioThreshold: readRatioEnv(
      "OAH_WORKER_CONTROLLER_SCALE_UP_BUSY_RATIO_THRESHOLD",
      controller?.scale_up_busy_ratio_threshold ?? 0.75
    ),
    scaleUpMaxReadyAgeMs: readPositiveIntEnv(
      "OAH_WORKER_CONTROLLER_SCALE_UP_MAX_READY_AGE_MS",
      controller?.scale_up_max_ready_age_ms ?? 2_000
    )
  };
}

export function summarizeStandaloneWorkerFleet(activeWorkers: RedisWorkerRegistryEntry[]): StandaloneWorkerFleetSummary {
  const healthyStandaloneWorkers = activeWorkers.filter(
    (worker) => worker.processKind === "standalone" && worker.health === "healthy"
  );
  const replicaIds = new Set<string>();
  const busyReplicaIds = new Set<string>();

  for (const worker of healthyStandaloneWorkers) {
    const replicaId = worker.runtimeInstanceId ?? worker.workerId;
    replicaIds.add(replicaId);
    if (worker.state === "busy") {
      busyReplicaIds.add(replicaId);
    }
  }

  const activeSlots = healthyStandaloneWorkers.length;
  const busySlots = healthyStandaloneWorkers.filter((worker) => worker.state === "busy").length;

  return {
    activeReplicas: replicaIds.size,
    busyReplicas: busyReplicaIds.size,
    activeSlots,
    busySlots,
    idleSlots: Math.max(0, activeSlots - busySlots),
    healthyWorkers: healthyStandaloneWorkers
  };
}

export function calculateStandaloneWorkerReplicas(input: {
  config: StandaloneWorkerControllerConfig;
  activeWorkers: RedisWorkerRegistryEntry[];
  schedulingPressure?: SessionRunQueuePressure | undefined;
}): {
  fleet: StandaloneWorkerFleetSummary;
  suggestedWorkers: number;
  suggestedReplicas: number;
} {
  const fleet = summarizeStandaloneWorkerFleet(input.activeWorkers);
  const sizing = calculateRedisWorkerPoolSuggestion({
    minWorkers: input.config.minReplicas * input.config.slotsPerPod,
    maxWorkers: input.config.maxReplicas * input.config.slotsPerPod,
    readySessionsPerWorker: input.config.readySessionsPerWorker,
    reservedSubagentCapacity: input.config.reservedSubagentCapacity,
    localActiveWorkers: fleet.activeSlots,
    localBusyWorkers: fleet.busySlots,
    scaleUpBusyRatioThreshold: input.config.scaleUpBusyRatioThreshold,
    scaleUpMaxReadyAgeMs: input.config.scaleUpMaxReadyAgeMs,
    schedulingPressure: input.schedulingPressure
  });
  const suggestedWorkers = sizing.localSuggestedWorkers;

  return {
    fleet,
    suggestedWorkers,
    suggestedReplicas: Math.max(
      input.config.minReplicas,
      Math.min(input.config.maxReplicas, Math.ceil(suggestedWorkers / input.config.slotsPerPod))
    )
  };
}

export class RedisWorkerController {
  readonly #queue: SessionRunQueue;
  readonly #registry: WorkerRegistry;
  readonly #config: StandaloneWorkerControllerConfig;
  readonly #scaleTarget?: WorkerReplicaTarget | undefined;
  readonly #logger?: WorkerControllerLogger | undefined;
  #running = false;
  #timer: NodeJS.Timeout | undefined;
  #lastScaleUpAtMs: number | undefined;
  #lastScaleDownAtMs: number | undefined;
  #scaleUpPressureStreak = 0;
  #scaleDownPressureStreak = 0;
  #snapshot: WorkerControllerSnapshot;

  constructor(options: {
    queue: SessionRunQueue;
    registry: WorkerRegistry;
    config: StandaloneWorkerControllerConfig;
    scaleTarget?: WorkerReplicaTarget | undefined;
    logger?: WorkerControllerLogger | undefined;
  }) {
    this.#queue = options.queue;
    this.#registry = options.registry;
    this.#config = options.config;
    this.#scaleTarget = options.scaleTarget;
    this.#logger = options.logger;
    this.#snapshot = {
      running: false,
      minReplicas: options.config.minReplicas,
      maxReplicas: options.config.maxReplicas,
      slotsPerPod: options.config.slotsPerPod,
      suggestedReplicas: options.config.minReplicas,
      desiredReplicas: options.config.minReplicas,
      suggestedWorkers: options.config.minReplicas * options.config.slotsPerPod,
      activeReplicas: 0,
      busyReplicas: 0,
      activeSlots: 0,
      busySlots: 0,
      idleSlots: 0,
      readySessionsPerWorker: options.config.readySessionsPerWorker,
      reservedSubagentCapacity: options.config.reservedSubagentCapacity,
      scaleUpPressureStreak: 0,
      scaleDownPressureStreak: 0,
      scaleUpCooldownRemainingMs: 0,
      scaleDownCooldownRemainingMs: 0,
      recentDecisions: []
    };
  }

  start(options?: { skipInitialEvaluation?: boolean | undefined }): void {
    if (this.#running) {
      return;
    }

    this.#running = true;
    if (!options?.skipInitialEvaluation) {
      void this.evaluateNow("startup");
    }
    this.#timer = setInterval(() => {
      void this.evaluateNow("interval");
    }, this.#config.scaleIntervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  async close(): Promise<void> {
    this.stop();
    await this.#scaleTarget?.close?.();
  }

  snapshot(): WorkerControllerSnapshot {
    return {
      ...this.#snapshot,
      recentDecisions: [...this.#snapshot.recentDecisions]
    };
  }

  async evaluateNow(reason: "startup" | "interval" = "interval"): Promise<WorkerControllerSnapshot> {
    const [activeWorkers, schedulingPressure] = await Promise.all([
      this.#registry.listActive ? this.#registry.listActive(Date.now()) : Promise.resolve([]),
      this.#readSchedulingPressure()
    ]);
    const { fleet, suggestedWorkers, suggestedReplicas } = calculateStandaloneWorkerReplicas({
      config: this.#config,
      activeWorkers,
      schedulingPressure
    });
    const desiredReplicas = this.#desiredReplicas(suggestedReplicas, fleet.activeReplicas, reason);
    const rebalanceReason = this.#rebalanceReason(reason, desiredReplicas, suggestedReplicas, fleet.activeReplicas);
    const nowMs = Date.now();
    const timestamp = new Date(nowMs).toISOString();
    const scaleTarget = await this.#reconcileScaleTarget({
      timestamp,
      reason: rebalanceReason,
      desiredReplicas,
      suggestedReplicas,
      activeReplicas: fleet.activeReplicas,
      activeSlots: fleet.activeSlots,
      busySlots: fleet.busySlots,
      ...(typeof schedulingPressure?.readySessionCount === "number" ? { readySessionCount: schedulingPressure.readySessionCount } : {}),
      ...(typeof schedulingPressure?.oldestSchedulableReadyAgeMs === "number"
        ? { oldestSchedulableReadyAgeMs: schedulingPressure.oldestSchedulableReadyAgeMs }
        : {})
    });

    this.#snapshot = {
      running: this.#running,
      minReplicas: this.#config.minReplicas,
      maxReplicas: this.#config.maxReplicas,
      slotsPerPod: this.#config.slotsPerPod,
      suggestedReplicas,
      desiredReplicas,
      suggestedWorkers,
      activeReplicas: fleet.activeReplicas,
      busyReplicas: fleet.busyReplicas,
      activeSlots: fleet.activeSlots,
      busySlots: fleet.busySlots,
      idleSlots: fleet.idleSlots,
      readySessionsPerWorker: this.#config.readySessionsPerWorker,
      reservedSubagentCapacity: this.#config.reservedSubagentCapacity,
      ...(typeof schedulingPressure?.readySessionCount === "number" ? { readySessionCount: schedulingPressure.readySessionCount } : {}),
      ...(typeof schedulingPressure?.subagentReadySessionCount === "number"
        ? { subagentReadySessionCount: schedulingPressure.subagentReadySessionCount }
        : {}),
      ...(typeof schedulingPressure?.oldestSchedulableReadyAgeMs === "number"
        ? { oldestSchedulableReadyAgeMs: schedulingPressure.oldestSchedulableReadyAgeMs }
        : {}),
      lastRebalanceAt: timestamp,
      lastRebalanceReason: rebalanceReason,
      scaleUpPressureStreak: this.#scaleUpPressureStreak,
      scaleDownPressureStreak: this.#scaleDownPressureStreak,
      scaleUpCooldownRemainingMs: cooldownRemainingMs(this.#lastScaleUpAtMs, this.#config.scaleUpCooldownMs, nowMs),
      scaleDownCooldownRemainingMs: cooldownRemainingMs(
        this.#lastCapacityChangeAtMs(),
        this.#config.scaleDownCooldownMs,
        nowMs
      ),
      ...(scaleTarget ? { scaleTarget } : {}),
      recentDecisions: appendDecision(this.#snapshot.recentDecisions, {
        timestamp,
        reason: rebalanceReason,
        suggestedReplicas,
        desiredReplicas,
        suggestedWorkers,
        activeReplicas: fleet.activeReplicas,
        activeSlots: fleet.activeSlots,
        busySlots: fleet.busySlots,
        ...(typeof schedulingPressure?.readySessionCount === "number" ? { readySessionCount: schedulingPressure.readySessionCount } : {}),
        ...(typeof schedulingPressure?.oldestSchedulableReadyAgeMs === "number"
          ? { oldestSchedulableReadyAgeMs: schedulingPressure.oldestSchedulableReadyAgeMs }
          : {})
      })
    };

    this.#logger?.info?.(
      `[worker-controller] rebalance=${rebalanceReason} activeReplicas=${fleet.activeReplicas} desiredReplicas=${desiredReplicas} suggestedReplicas=${suggestedReplicas} activeSlots=${fleet.activeSlots} busySlots=${fleet.busySlots} readySessions=${schedulingPressure?.readySessionCount ?? "n/a"} target=${scaleTarget?.kind ?? "none"} targetOutcome=${scaleTarget?.outcome ?? "n/a"}`
    );

    return this.snapshot();
  }

  async #readSchedulingPressure(): Promise<SessionRunQueuePressure | undefined> {
    if (typeof this.#queue.getSchedulingPressure === "function") {
      return this.#queue.getSchedulingPressure();
    }

    if (typeof this.#queue.getReadySessionCount === "function") {
      return {
        readySessionCount: await this.#queue.getReadySessionCount()
      };
    }

    return undefined;
  }

  #desiredReplicas(suggestedReplicas: number, currentReplicas: number, reason: "startup" | "interval"): number {
    if (suggestedReplicas > currentReplicas) {
      this.#scaleUpPressureStreak += 1;
    } else {
      this.#scaleUpPressureStreak = 0;
    }

    if (suggestedReplicas < currentReplicas) {
      this.#scaleDownPressureStreak += 1;
    } else {
      this.#scaleDownPressureStreak = 0;
    }

    const targetReplicas =
      suggestedReplicas > currentReplicas
        ? this.#scaleUpPressureStreak >= this.#config.scaleUpSampleSize
          ? suggestedReplicas
          : currentReplicas
        : suggestedReplicas < currentReplicas
          ? this.#scaleDownPressureStreak >= this.#config.scaleDownSampleSize
            ? suggestedReplicas
            : currentReplicas
          : suggestedReplicas;

    if (reason === "startup") {
      return suggestedReplicas;
    }

    const nowMs = Date.now();
    if (targetReplicas > currentReplicas) {
      if (cooldownRemainingMs(this.#lastScaleUpAtMs, this.#config.scaleUpCooldownMs, nowMs) > 0) {
        return currentReplicas;
      }
      this.#lastScaleUpAtMs = nowMs;
      return targetReplicas;
    }

    if (targetReplicas < currentReplicas) {
      if (cooldownRemainingMs(this.#lastCapacityChangeAtMs(), this.#config.scaleDownCooldownMs, nowMs) > 0) {
        return currentReplicas;
      }
      this.#lastScaleDownAtMs = nowMs;
      return targetReplicas;
    }

    return targetReplicas;
  }

  #lastCapacityChangeAtMs(): number | undefined {
    const lastScaleUpAtMs = this.#lastScaleUpAtMs ?? 0;
    const lastScaleDownAtMs = this.#lastScaleDownAtMs ?? 0;
    const latest = Math.max(lastScaleUpAtMs, lastScaleDownAtMs);
    return latest > 0 ? latest : undefined;
  }

  #rebalanceReason(
    reason: "startup" | "interval",
    desiredReplicas: number,
    suggestedReplicas: number,
    activeReplicas: number
  ): Exclude<RedisRunWorkerPoolRebalanceReason, "shutdown"> {
    if (reason === "startup") {
      return "startup";
    }

    if (desiredReplicas > activeReplicas) {
      return "scale_up";
    }

    if (desiredReplicas < activeReplicas) {
      return "scale_down";
    }

    if (desiredReplicas !== suggestedReplicas) {
      return "cooldown_hold";
    }

    return "steady";
  }

  async #reconcileScaleTarget(
    input: Parameters<Exclude<WorkerReplicaTarget, undefined>["reconcile"]>[0]
  ): Promise<WorkerReplicaTargetResult | undefined> {
    if (!this.#scaleTarget) {
      return undefined;
    }

    try {
      return await this.#scaleTarget.reconcile(input);
    } catch (error) {
      this.#logger?.warn("[worker-controller] failed to reconcile scale target", error);
      return {
        kind: this.#scaleTarget.kind,
        attempted: true,
        applied: false,
        desiredReplicas: input.desiredReplicas,
        outcome: "error",
        at: input.timestamp,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }
}
