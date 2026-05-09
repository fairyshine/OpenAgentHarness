import {
  type RedisWorkspacePlacementEntry,
  type RedisWorkerRegistryEntry,
  type SessionRunQueue,
  type SessionRunQueuePressure,
  type WorkerRegistry,
  type WorkspacePlacementRegistry
} from "@oah/storage-redis-control";

import type { WorkerReplicaTarget, WorkerReplicaTargetResult } from "./scale-target.js";
import { readPositiveIntEnv } from "./controller-config.js";
import type { SandboxFleetConfig, StandaloneControllerConfig } from "./controller-config.js";
import {
  buildPlacementExecutionOperations,
  calculateStandaloneWorkerReplicas,
  summarizePlacementActionPlan,
  summarizePlacementPolicy,
  summarizePlacementRecommendations,
  summarizeSandboxFleet,
  summarizeStandaloneWorkerFleet,
  summarizeWorkspacePlacements
} from "./controller-placement.js";
import {
  appendDecision,
  buildControllerLoggedState,
  cooldownRemainingMs,
  formatControllerRebalanceLog,
  shouldLogControllerRebalance
} from "./controller-rebalance-state.js";
import type {
  ControllerDecision,
  ControllerHealthProbe,
  ControllerLoggedState,
  ControllerLogger,
  ControllerPlacementActionItem,
  ControllerPlacementActionPlan,
  ControllerPlacementExecutionOperation,
  ControllerPlacementExecutionReport,
  ControllerPlacementExecutionResult,
  ControllerPlacementExecutor,
  ControllerPlacementOwnershipRegistry,
  ControllerPlacementPolicySummary,
  ControllerPlacementRecommendation,
  ControllerPlacementSummary,
  ControllerRebalanceReason,
  ControllerSandboxFleetSummary,
  ControllerScaleDownBlocker,
  ControllerScaleDownGate,
  ControllerScaleDownPlacementBlocker,
  ControllerSnapshot,
  ControllerWorkerHealth,
  ControllerWorkspacePlacementEntry,
  StandaloneWorkerFleetSummary
} from "./controller-types.js";

export { resolveSandboxFleetConfig, resolveStandaloneControllerConfig } from "./controller-config.js";
export {
  buildPlacementExecutionOperations,
  calculateStandaloneWorkerReplicas,
  summarizePlacementActionPlan,
  summarizePlacementPolicy,
  summarizePlacementRecommendations,
  summarizeSandboxFleet,
  summarizeStandaloneWorkerFleet,
  summarizeWorkspacePlacements
} from "./controller-placement.js";
export {
  appendDecision,
  buildControllerLoggedState,
  cooldownRemainingMs,
  formatControllerRebalanceLog,
  shouldLogControllerRebalance
} from "./controller-rebalance-state.js";
export type { SandboxFleetConfig, StandaloneControllerConfig } from "./controller-config.js";
export type {
  ControllerDecision,
  ControllerHealthProbe,
  ControllerLogger,
  ControllerPlacementActionItem,
  ControllerPlacementActionPlan,
  ControllerPlacementExecutionOperation,
  ControllerPlacementExecutionReport,
  ControllerPlacementExecutionResult,
  ControllerPlacementExecutor,
  ControllerPlacementOwnershipRegistry,
  ControllerPlacementPolicySummary,
  ControllerPlacementRecommendation,
  ControllerPlacementSummary,
  ControllerRebalanceReason,
  ControllerSandboxFleetSummary,
  ControllerScaleDownBlocker,
  ControllerScaleDownGate,
  ControllerScaleDownPlacementBlocker,
  ControllerSnapshot,
  ControllerWorkerHealth,
  StandaloneWorkerFleetSummary
} from "./controller-types.js";

export function createPlacementRegistryActionExecutor(options: {
  placementRegistry: ControllerPlacementOwnershipRegistry;
  maxWorkspacesPerSandbox?: number | undefined;
  resourceCpuPressureThreshold?: number | undefined;
  resourceMemoryPressureThreshold?: number | undefined;
  resourceDiskPressureThreshold?: number | undefined;
  logger?: ControllerLogger | undefined;
}): ControllerPlacementExecutor {
  return {
    async execute(input) {
      const operations = buildPlacementExecutionOperations({
        placements: input.placements,
        activeWorkers: input.activeWorkers,
        maxWorkspacesPerSandbox: options.maxWorkspacesPerSandbox,
        resourceCpuPressureThreshold: options.resourceCpuPressureThreshold,
        resourceMemoryPressureThreshold: options.resourceMemoryPressureThreshold,
        resourceDiskPressureThreshold: options.resourceDiskPressureThreshold
      });
      if (operations.length === 0) {
        return undefined;
      }

      const results: ControllerPlacementExecutionResult[] = [];
      for (const operation of operations) {
        try {
          if (operation.action === "set_preferred_worker" && !operation.targetWorkerId) {
            results.push({
              ...operation,
              status: "skipped",
              message: "no healthy target worker was available for the requested placement hint update"
            });
            continue;
          }

          if (operation.action === "set_preferred_worker" && operation.targetWorkerId) {
            await options.placementRegistry.setPreferredWorker(operation.workspaceId, operation.targetWorkerId, {
              reason: "controller_target",
              overwrite: true,
              updatedAt: input.timestamp
            });
            results.push({
              ...operation,
              status: "applied",
              message: `controller preferred worker hint was updated to ${operation.targetWorkerId}`
            });
          } else {
            await options.placementRegistry.releaseOwnership(operation.workspaceId, {
              state: "unassigned",
              ...(operation.targetWorkerId
                ? {
                    preferredWorkerId: operation.targetWorkerId,
                    preferredWorkerReason: "controller_target" as const
                  }
                : {}),
              updatedAt: input.timestamp
            });
            results.push({
              ...operation,
              status: "applied",
              message: operation.targetWorkerId
                ? `workspace ownership was released for controller-driven reassignment toward ${operation.targetWorkerId}`
                : "workspace ownership was released for controller-driven reassignment"
            });
          }
        } catch (error) {
          options.logger?.warn?.(
            `[controller] failed to execute placement action ${operation.kind} for workspace ${operation.workspaceId}`,
            error
          );
          results.push({
            ...operation,
            status: "failed",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }

      return {
        attempted: results.length,
        applied: results.filter((result) => result.status === "applied").length,
        skipped: results.filter((result) => result.status === "skipped").length,
        failed: results.filter((result) => result.status === "failed").length,
        operations: results
      };
    }
  };
}

export class RedisController {
  readonly #queue: SessionRunQueue;
  readonly #registry: WorkerRegistry;
  readonly #placementRegistry?: WorkspacePlacementRegistry | undefined;
  readonly #placementExecutor?: ControllerPlacementExecutor | undefined;
  readonly #config: StandaloneControllerConfig;
  readonly #sandboxConfig: SandboxFleetConfig;
  readonly #scaleTarget?: WorkerReplicaTarget | undefined;
  readonly #logger?: ControllerLogger | undefined;
  readonly #healthProbe: ControllerHealthProbe;
  #running = false;
  #timer: NodeJS.Timeout | undefined;
  #lastScaleUpAtMs: number | undefined;
  #lastScaleDownAtMs: number | undefined;
  #lastLoggedAtMs: number | undefined;
  #lastLoggedState: ControllerLoggedState | undefined;
  #scaleUpPressureStreak = 0;
  #scaleDownPressureStreak = 0;
  #snapshot: ControllerSnapshot;

  constructor(options: {
    queue: SessionRunQueue;
    registry: WorkerRegistry;
    placementRegistry?: WorkspacePlacementRegistry | undefined;
    placementExecutor?: ControllerPlacementExecutor | undefined;
    config: StandaloneControllerConfig;
    sandboxConfig?: SandboxFleetConfig | undefined;
    scaleTarget?: WorkerReplicaTarget | undefined;
    logger?: ControllerLogger | undefined;
    healthProbe?: ControllerHealthProbe | undefined;
  }) {
    this.#queue = options.queue;
    this.#registry = options.registry;
    this.#placementRegistry = options.placementRegistry;
    this.#placementExecutor = options.placementExecutor;
    this.#config = options.config;
    this.#sandboxConfig = options.sandboxConfig ?? {
      providerKind: "embedded",
      managedByController: false,
      minCount: 0,
      maxCount: 1,
      maxWorkspacesPerSandbox: 32,
      ownerlessPool: "shared",
      warmEmptyCount: 0,
      resourceCpuPressureThreshold: 0.8,
      resourceMemoryPressureThreshold: 0.8,
      resourceDiskPressureThreshold: 0.85
    };
    this.#scaleTarget = options.scaleTarget;
    this.#logger = options.logger;
    this.#healthProbe = options.healthProbe ?? defaultControllerHealthProbe;
    this.#snapshot = {
      running: false,
      minReplicas: options.config.minReplicas,
      maxReplicas: options.config.maxReplicas,
      suggestedReplicas: options.config.minReplicas,
      desiredReplicas: options.config.minReplicas,
      suggestedWorkers: options.config.minReplicas,
      activeReplicas: 0,
      busyReplicas: 0,
      activeSlots: 0,
      busySlots: 0,
      idleSlots: 0,
      effectiveCapacityPerReplica: 1,
      readySessionsPerCapacityUnit: options.config.readySessionsPerCapacityUnit,
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
    await this.#placementExecutor?.close?.();
    await this.#scaleTarget?.close?.();
  }

  snapshot(): ControllerSnapshot {
    return {
      ...this.#snapshot,
      recentDecisions: [...this.#snapshot.recentDecisions]
    };
  }

  async evaluateNow(reason: "startup" | "interval" = "interval"): Promise<ControllerSnapshot> {
    const [activeWorkers, schedulingPressure, listedWorkspacePlacements] = await Promise.all([
      this.#registry.listActive ? this.#registry.listActive(Date.now()) : Promise.resolve([]),
      this.#readSchedulingPressure(),
      this.#placementRegistry?.listAll() ?? Promise.resolve(undefined)
    ]);
    let workspacePlacements = listedWorkspacePlacements;
    const { fleet, suggestedWorkers, suggestedReplicas: workloadSuggestedReplicas } = calculateStandaloneWorkerReplicas({
      config: this.#config,
      activeWorkers,
      schedulingPressure
    });
    let placementSummary = summarizeWorkspacePlacements(workspacePlacements, activeWorkers);
    let placementPolicy = summarizePlacementPolicy({
      placements: workspacePlacements,
      activeWorkers,
      maxWorkspacesPerSandbox: this.#sandboxConfig.maxWorkspacesPerSandbox
    });
    let placementRecommendations = placementPolicy?.attentionRequired
      ? summarizePlacementRecommendations({
          placementSummary,
          placementPolicy,
          placements: workspacePlacements,
          activeWorkers,
          maxWorkspacesPerSandbox: this.#sandboxConfig.maxWorkspacesPerSandbox
        })
      : undefined;
    let placementActionPlan = placementRecommendations ? summarizePlacementActionPlan(placementRecommendations) : undefined;
    const timestamp = new Date().toISOString();
    const placementExecution =
      this.#placementExecutor && workspacePlacements && placementPolicy?.attentionRequired
        ? await this.#placementExecutor.execute({
            timestamp,
            placements: workspacePlacements,
            activeWorkers
          })
        : undefined;
    if ((placementExecution?.applied ?? 0) > 0 && this.#placementRegistry) {
      workspacePlacements = await this.#placementRegistry.listAll();
      placementSummary = summarizeWorkspacePlacements(workspacePlacements, activeWorkers);
      placementPolicy = summarizePlacementPolicy({
        placements: workspacePlacements,
        activeWorkers,
        maxWorkspacesPerSandbox: this.#sandboxConfig.maxWorkspacesPerSandbox
      });
      placementRecommendations = placementPolicy?.attentionRequired
        ? summarizePlacementRecommendations({
            placementSummary,
            placementPolicy,
            placements: workspacePlacements,
            activeWorkers,
            maxWorkspacesPerSandbox: this.#sandboxConfig.maxWorkspacesPerSandbox
          })
        : undefined;
      placementActionPlan = placementRecommendations ? summarizePlacementActionPlan(placementRecommendations) : undefined;
    }
    const sandboxFleet = summarizeSandboxFleet({
      placements: workspacePlacements,
      activeWorkers,
      config: this.#sandboxConfig
    });
    const placementSuggestedReplicas = sandboxFleet.managedByController
      ? Math.max(
          this.#config.minReplicas,
          Math.min(this.#config.maxReplicas, Math.max(0, sandboxFleet.desiredSandboxes))
        )
      : this.#config.minReplicas;
    const suggestedReplicas = Math.max(workloadSuggestedReplicas, placementSuggestedReplicas);
    const scaleDownTargetReplicas = this.#scaleDownTargetReplicas(suggestedReplicas, fleet.activeReplicas);
    const scaleDownGate =
      scaleDownTargetReplicas < fleet.activeReplicas
        ? await this.#evaluateScaleDownGate(activeWorkers, placementSummary)
        : undefined;
    const desiredReplicas = this.#desiredReplicas({
      suggestedReplicas,
      currentReplicas: fleet.activeReplicas,
      reason,
      scaleDownTargetReplicas,
      allowScaleDown: scaleDownGate?.allowed ?? true
    });
    const rebalanceReason = this.#rebalanceReason({
      reason,
      desiredReplicas,
      suggestedReplicas,
      activeReplicas: fleet.activeReplicas,
      scaleDownGate,
      placementPolicy
    });
    const nowMs = Date.now();
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
      suggestedReplicas,
      desiredReplicas,
      suggestedWorkers,
      activeReplicas: fleet.activeReplicas,
      busyReplicas: fleet.busyReplicas,
      activeSlots: fleet.activeSlots,
      busySlots: fleet.busySlots,
      idleSlots: fleet.idleSlots,
      effectiveCapacityPerReplica: fleet.effectiveCapacityPerReplica,
      readySessionsPerCapacityUnit: this.#config.readySessionsPerCapacityUnit,
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
      sandboxFleet,
      ...(placementSummary ? { placement: placementSummary } : {}),
      ...(placementPolicy ? { placementPolicy } : {}),
      ...(placementRecommendations ? { placementRecommendations } : {}),
      ...(placementActionPlan ? { placementActionPlan } : {}),
      ...(placementExecution ? { placementExecution } : {}),
      ...(scaleDownGate ? { scaleDownGate } : {}),
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
        ...(scaleDownGate ? { scaleDownAllowed: scaleDownGate.allowed, scaleDownBlockedReplicas: scaleDownGate.blockedReplicas } : {}),
        ...(typeof schedulingPressure?.readySessionCount === "number" ? { readySessionCount: schedulingPressure.readySessionCount } : {}),
        ...(typeof schedulingPressure?.oldestSchedulableReadyAgeMs === "number"
          ? { oldestSchedulableReadyAgeMs: schedulingPressure.oldestSchedulableReadyAgeMs }
          : {})
      })
    };

    const loggedState = buildControllerLoggedState({
      reason: rebalanceReason,
      desiredReplicas,
      suggestedReplicas,
      activeReplicas: fleet.activeReplicas,
      activeSlots: fleet.activeSlots,
      busySlots: fleet.busySlots,
      effectiveCapacityPerReplica: fleet.effectiveCapacityPerReplica,
      schedulingPressure,
      scaleDownGate,
      sandboxFleet,
      placementSummary,
      placementPolicy,
      placementRecommendations,
      placementActionPlan,
      placementExecution,
      scaleTarget
    });
    if (shouldLogControllerRebalance(this.#lastLoggedState, this.#lastLoggedAtMs, loggedState, nowMs, this.#config.scaleIntervalMs)) {
      this.#logger?.info?.(formatControllerRebalanceLog(loggedState));
      this.#lastLoggedState = loggedState;
      this.#lastLoggedAtMs = nowMs;
    }

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

  #scaleDownTargetReplicas(suggestedReplicas: number, currentReplicas: number): number {
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

    return suggestedReplicas < currentReplicas && this.#scaleDownPressureStreak >= this.#config.scaleDownSampleSize
      ? suggestedReplicas
      : currentReplicas;
  }

  #desiredReplicas(input: {
    suggestedReplicas: number;
    currentReplicas: number;
    reason: "startup" | "interval";
    scaleDownTargetReplicas: number;
    allowScaleDown: boolean;
  }): number {
    const { suggestedReplicas, currentReplicas, reason, scaleDownTargetReplicas, allowScaleDown } = input;

    if (reason === "startup") {
      if (suggestedReplicas < currentReplicas && !allowScaleDown) {
        return currentReplicas;
      }
      return suggestedReplicas;
    }

    const nowMs = Date.now();
    if (suggestedReplicas > currentReplicas) {
      const targetReplicas =
        this.#scaleUpPressureStreak >= this.#config.scaleUpSampleSize ? suggestedReplicas : currentReplicas;
      if (targetReplicas <= currentReplicas) {
        return currentReplicas;
      }
      if (cooldownRemainingMs(this.#lastScaleUpAtMs, this.#config.scaleUpCooldownMs, nowMs) > 0) {
        return currentReplicas;
      }
      this.#lastScaleUpAtMs = nowMs;
      return targetReplicas;
    }

    if (scaleDownTargetReplicas < currentReplicas) {
      if (!allowScaleDown) {
        return currentReplicas;
      }
      if (cooldownRemainingMs(this.#lastCapacityChangeAtMs(), this.#config.scaleDownCooldownMs, nowMs) > 0) {
        return currentReplicas;
      }
      this.#lastScaleDownAtMs = nowMs;
      return scaleDownTargetReplicas;
    }

    return suggestedReplicas > currentReplicas ? currentReplicas : suggestedReplicas;
  }

  #lastCapacityChangeAtMs(): number | undefined {
    const lastScaleUpAtMs = this.#lastScaleUpAtMs ?? 0;
    const lastScaleDownAtMs = this.#lastScaleDownAtMs ?? 0;
    const latest = Math.max(lastScaleUpAtMs, lastScaleDownAtMs);
    return latest > 0 ? latest : undefined;
  }

  #rebalanceReason(input: {
    reason: "startup" | "interval";
    desiredReplicas: number;
    suggestedReplicas: number;
    activeReplicas: number;
    scaleDownGate?: ControllerScaleDownGate | undefined;
    placementPolicy?: ControllerPlacementPolicySummary | undefined;
  }): ControllerRebalanceReason {
    if (input.reason === "startup") {
      if (input.suggestedReplicas < input.activeReplicas && input.scaleDownGate && !input.scaleDownGate.allowed) {
        return "scale_down_blocked";
      }
      return "startup";
    }

    if (input.desiredReplicas > input.activeReplicas) {
      return "scale_up";
    }

    if (input.desiredReplicas < input.activeReplicas) {
      return "scale_down";
    }

    if (input.suggestedReplicas < input.activeReplicas && input.scaleDownGate && !input.scaleDownGate.allowed) {
      return "scale_down_blocked";
    }

    if (input.desiredReplicas !== input.suggestedReplicas) {
      return "cooldown_hold";
    }

    if (input.placementPolicy?.attentionRequired) {
      return "placement_attention";
    }

    return "steady";
  }

  async #evaluateScaleDownGate(
    activeWorkers: RedisWorkerRegistryEntry[],
    placementSummary?: ControllerPlacementSummary | undefined
  ): Promise<ControllerScaleDownGate> {
    const replicaWorkers = new Map<string, RedisWorkerRegistryEntry[]>();

    for (const worker of activeWorkers) {
      if (worker.processKind !== "standalone" || worker.health !== "healthy") {
        continue;
      }

      const replicaId = worker.runtimeInstanceId ?? worker.workerId;
      const existing = replicaWorkers.get(replicaId);
      if (existing) {
        existing.push(worker);
      } else {
        replicaWorkers.set(replicaId, [worker]);
      }
    }

    const blockerResults: Array<ControllerScaleDownBlocker | undefined> = await Promise.all(
      [...replicaWorkers.entries()].map(async ([replicaId, workers]) => {
        const ownerBaseUrl = workers.find((worker) => worker.ownerBaseUrl)?.ownerBaseUrl;
        if (!ownerBaseUrl) {
          return {
            replicaId,
            workerIds: workers.map((worker) => worker.workerId).sort(),
            reason: "missing_owner_base_url" as const,
            message: "worker registry entry is missing ownerBaseUrl for scale-down health probing"
          };
        }

        try {
          const health = await this.#healthProbe({
            replicaId,
            ownerBaseUrl,
            workers
          });
          if (health.draining) {
            return {
              replicaId,
              workerIds: workers.map((worker) => worker.workerId).sort(),
              ownerBaseUrl,
              reason: "worker_draining" as const,
              message: "worker is currently draining and should not be selected for scale-down"
            };
          }
          if (health.materializationBlockerCount > 0 || health.materializationFailureCount > 0) {
            return {
              replicaId,
              workerIds: workers.map((worker) => worker.workerId).sort(),
              ownerBaseUrl,
              reason: "materialization_blocked" as const,
              message: `worker reported ${health.materializationBlockerCount} materialization blocker(s) and ${health.materializationFailureCount} failure(s)`,
              materializationBlockerCount: health.materializationBlockerCount,
              materializationFailureCount: health.materializationFailureCount
            };
          }
          return undefined;
        } catch (error) {
          return {
            replicaId,
            workerIds: workers.map((worker) => worker.workerId).sort(),
            ownerBaseUrl,
            reason: "probe_failed" as const,
            message: error instanceof Error ? error.message : String(error)
          };
        }
      })
    );
    const blockers = blockerResults
      .reduce<ControllerScaleDownBlocker[]>((accumulator, blocker) => {
        if (blocker) {
          accumulator.push(blocker);
        }
        return accumulator;
      }, [])
      .sort((left, right) => left.replicaId.localeCompare(right.replicaId));
    const placementBlockers: ControllerScaleDownPlacementBlocker[] = [];
    if ((placementSummary?.ownedByMissingWorkers ?? 0) > 0) {
      placementBlockers.push({
        reason: "missing_owner_worker",
        workspaceCount: placementSummary?.ownedByMissingWorkers ?? 0,
        workerCount: placementSummary?.workersWithMissingPlacements ?? 0,
        message: `workspace placement still references ${placementSummary?.workersWithMissingPlacements ?? 0} missing worker(s) across ${placementSummary?.ownedByMissingWorkers ?? 0} workspace(s)`
      });
    }
    if ((placementSummary?.ownedByLateWorkers ?? 0) > 0) {
      placementBlockers.push({
        reason: "late_owner_worker",
        workspaceCount: placementSummary?.ownedByLateWorkers ?? 0,
        workerCount: placementSummary?.workersWithLatePlacements ?? 0,
        message: `workspace placement still references ${placementSummary?.workersWithLatePlacements ?? 0} late worker(s) across ${placementSummary?.ownedByLateWorkers ?? 0} workspace(s)`
      });
    }

    return {
      allowed: blockers.length === 0 && placementBlockers.length === 0,
      checkedReplicas: replicaWorkers.size,
      blockedReplicas: blockers.length,
      blockers,
      ...(placementBlockers.length > 0 ? { placementBlockers } : {}),
      evaluatedAt: new Date().toISOString()
    };
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
      this.#logger?.warn("[controller] failed to reconcile scale target", error);
      return {
        kind: this.#scaleTarget.kind,
        attempted: true,
        applied: false,
        desiredReplicas: input.desiredReplicas,
        outcome: "error",
        at: input.timestamp,
        phase: "error",
        reasonCode: "target_reconcile_exception",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }
}

async function defaultControllerHealthProbe(input: {
  replicaId: string;
  ownerBaseUrl: string;
}): Promise<ControllerWorkerHealth> {
  const timeoutMs = readPositiveIntEnv("OAH_CONTROLLER_HEALTH_TIMEOUT_MS", 1_500);
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, timeoutMs);
  timeout.unref?.();

  try {
    const response = await fetch(`${input.ownerBaseUrl.replace(/\/+$/u, "")}/healthz`, {
      signal: abortController.signal
    });
    if (!response.ok) {
      throw new Error(`healthz probe failed for ${input.replicaId} with status ${response.status}`);
    }

    const payload = (await response.json()) as {
      worker?: {
        draining?: unknown;
        materialization?: {
          blockerCount?: unknown;
          failureCount?: unknown;
        } | undefined;
      } | null;
    };
    const materialization = payload?.worker?.materialization;

    return {
      draining: payload?.worker?.draining === true,
      materializationBlockerCount:
        typeof materialization?.blockerCount === "number" && Number.isFinite(materialization.blockerCount)
          ? Math.max(0, Math.floor(materialization.blockerCount))
          : 0,
      materializationFailureCount:
        typeof materialization?.failureCount === "number" && Number.isFinite(materialization.failureCount)
          ? Math.max(0, Math.floor(materialization.failureCount))
          : 0
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`healthz probe timed out for ${input.replicaId} after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
