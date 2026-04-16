import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RedisWorkerRegistryEntry, RedisWorkspacePlacementEntry } from "@oah/storage-redis";

import {
  createControllerLeaderElector,
  resolveControllerLeaderElectionConfig
} from "../apps/controller/src/leader-election.ts";
import {
  calculateStandaloneWorkerReplicas,
  buildPlacementExecutionOperations,
  createPlacementRegistryActionExecutor,
  RedisController,
  resolveStandaloneControllerConfig,
  summarizePlacementActionPlan,
  summarizePlacementPolicy,
  summarizePlacementRecommendations,
  summarizeWorkspacePlacements,
  summarizeStandaloneWorkerFleet
} from "../apps/controller/src/controller.ts";
import {
  createKubernetesWorkerReplicaTarget,
  resolveWorkerReplicaTargetConfig
} from "../apps/controller/src/scale-target.ts";
import {
  createControllerObservabilityServer,
  renderControllerMetrics
} from "../apps/controller/src/observability.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("controller", () => {
  it("groups standalone worker slots by runtime instance when counting replicas", () => {
    const fleet = summarizeStandaloneWorkerFleet([
      {
        workerId: "worker_1",
        runtimeInstanceId: "pod-a",
        processKind: "standalone",
        state: "busy",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        leaseTtlMs: 5_000,
        expiresAt: "2026-04-14T00:00:05.000Z",
        lastSeenAgeMs: 0,
        health: "healthy"
      },
      {
        workerId: "worker_2",
        runtimeInstanceId: "pod-a",
        processKind: "standalone",
        state: "idle",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        leaseTtlMs: 5_000,
        expiresAt: "2026-04-14T00:00:05.000Z",
        lastSeenAgeMs: 0,
        health: "healthy"
      },
      {
        workerId: "worker_3",
        runtimeInstanceId: "pod-b",
        processKind: "standalone",
        state: "idle",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        leaseTtlMs: 5_000,
        expiresAt: "2026-04-14T00:00:05.000Z",
        lastSeenAgeMs: 0,
        health: "healthy"
      }
    ] satisfies RedisWorkerRegistryEntry[]);

    expect(fleet).toMatchObject({
      activeReplicas: 2,
      busyReplicas: 1,
      activeSlots: 3,
      busySlots: 1,
      idleSlots: 2
    });
  });

  it("translates slot pressure into suggested replica count", () => {
    const result = calculateStandaloneWorkerReplicas({
      config: {
        minReplicas: 1,
        maxReplicas: 6,
        slotsPerPod: 2,
        readySessionsPerWorker: 1,
        reservedSubagentCapacity: 1,
        scaleIntervalMs: 5_000,
        scaleUpCooldownMs: 1_000,
        scaleDownCooldownMs: 15_000,
        scaleUpSampleSize: 2,
        scaleDownSampleSize: 3,
        scaleUpBusyRatioThreshold: 0.75,
        scaleUpMaxReadyAgeMs: 2_000
      },
      activeWorkers: [
        {
          workerId: "worker_1",
          runtimeInstanceId: "pod-a",
          processKind: "standalone",
          state: "busy",
          lastSeenAt: "2026-04-14T00:00:00.000Z",
          leaseTtlMs: 5_000,
          expiresAt: "2026-04-14T00:00:05.000Z",
          lastSeenAgeMs: 0,
          health: "healthy"
        },
        {
          workerId: "worker_2",
          runtimeInstanceId: "pod-a",
          processKind: "standalone",
          state: "busy",
          lastSeenAt: "2026-04-14T00:00:00.000Z",
          leaseTtlMs: 5_000,
          expiresAt: "2026-04-14T00:00:05.000Z",
          lastSeenAgeMs: 0,
          health: "healthy"
        }
      ] satisfies RedisWorkerRegistryEntry[],
      schedulingPressure: {
        readySessionCount: 5,
        oldestSchedulableReadyAgeMs: 3_000
      }
    });

    expect(result.suggestedWorkers).toBeGreaterThan(2);
    expect(result.suggestedReplicas).toBe(4);
  });

  it("summarizes first-class workspace placement state for controller snapshots", () => {
    const summary = summarizeWorkspacePlacements([
      {
        workspaceId: "ws_1",
        version: "live",
        userId: "user_1",
        ownerWorkerId: "worker_1",
        state: "active",
        updatedAt: "2026-04-15T00:00:00.000Z"
      },
      {
        workspaceId: "ws_2",
        version: "live",
        state: "idle",
        ownerWorkerId: "worker_1",
        updatedAt: "2026-04-15T00:00:01.000Z"
      },
      {
        workspaceId: "ws_3",
        version: "live",
        userId: "user_2",
        state: "evicted",
        updatedAt: "2026-04-15T00:00:02.000Z"
      },
      {
        workspaceId: "ws_4",
        version: "live",
        state: "unassigned",
        updatedAt: "2026-04-15T00:00:03.000Z"
      }
    ] satisfies RedisWorkspacePlacementEntry[], [
      {
        workerId: "worker_1",
        processKind: "standalone",
        state: "idle",
        health: "healthy",
        lastSeenAt: "2026-04-15T00:00:00.000Z",
        leaseTtlMs: 5_000,
        expiresAt: "2026-04-15T00:00:05.000Z",
        lastSeenAgeMs: 0
      }
    ] satisfies RedisWorkerRegistryEntry[]);

    expect(summary).toEqual({
      totalWorkspaces: 4,
      assignedUsers: 2,
      unassignedUsers: 2,
      ownedWorkspaces: 2,
      workersWithPlacements: 1,
      ownedByActiveWorkers: 2,
      ownedByLateWorkers: 0,
      ownedByMissingWorkers: 0,
      workersWithLatePlacements: 0,
      workersWithMissingPlacements: 0,
      active: 1,
      idle: 1,
      draining: 0,
      evicted: 1,
      unassigned: 1
    });
  });

  it("summarizes placement policy signals for rebalance attention", () => {
    const policy = summarizePlacementPolicy({
      placements: [
        {
          workspaceId: "ws_1",
          version: "live",
          userId: "user_1",
          ownerWorkerId: "worker_1",
          state: "active",
          refCount: 2,
          updatedAt: "2026-04-15T00:00:00.000Z"
        },
        {
          workspaceId: "ws_2",
          version: "live",
          userId: "user_1",
          ownerWorkerId: "worker_2",
          state: "idle",
          refCount: 1,
          updatedAt: "2026-04-15T00:00:01.000Z"
        },
        {
          workspaceId: "ws_3",
          version: "live",
          ownerWorkerId: "worker_3",
          state: "draining",
          updatedAt: "2026-04-15T00:00:02.000Z"
        },
        {
          workspaceId: "ws_4",
          version: "live",
          state: "unassigned",
          updatedAt: "2026-04-15T00:00:03.000Z"
        }
      ] satisfies RedisWorkspacePlacementEntry[],
      activeWorkers: [
        {
          workerId: "worker_1",
          processKind: "standalone",
          state: "idle",
          health: "healthy",
          lastSeenAt: "2026-04-15T00:00:00.000Z",
          leaseTtlMs: 5_000,
          expiresAt: "2026-04-15T00:00:05.000Z",
          lastSeenAgeMs: 0
        },
        {
          workerId: "worker_2",
          processKind: "standalone",
          state: "idle",
          health: "healthy",
          lastSeenAt: "2026-04-15T00:00:00.000Z",
          leaseTtlMs: 5_000,
          expiresAt: "2026-04-15T00:00:05.000Z",
          lastSeenAgeMs: 0
        },
        {
          workerId: "worker_3",
          processKind: "standalone",
          state: "stopping",
          health: "healthy",
          lastSeenAt: "2026-04-15T00:00:00.000Z",
          leaseTtlMs: 5_000,
          expiresAt: "2026-04-15T00:00:05.000Z",
          lastSeenAgeMs: 0
        }
      ] satisfies RedisWorkerRegistryEntry[],
      slotsPerPod: 1
    });

    expect(policy).toEqual({
      attentionRequired: true,
      unassignedWorkspaces: 1,
      missingOwnerWorkspaces: 0,
      lateOwnerWorkspaces: 0,
      drainingOwnerWorkspaces: 1,
      usersSpanningWorkers: 1,
      maxWorkersPerUser: 2,
      workersAboveSoftCapacity: 1,
      maxRefCountPerWorker: 2
    });
  });

  it("builds actionable placement recommendations from policy signals", () => {
    const recommendations = summarizePlacementRecommendations({
      placementSummary: {
        totalWorkspaces: 4,
        assignedUsers: 2,
        unassignedUsers: 2,
        ownedWorkspaces: 3,
        workersWithPlacements: 2,
        ownedByActiveWorkers: 2,
        ownedByLateWorkers: 1,
        ownedByMissingWorkers: 1,
        workersWithLatePlacements: 1,
        workersWithMissingPlacements: 1,
        active: 1,
        idle: 1,
        draining: 1,
        evicted: 0,
        unassigned: 1
      },
      placementPolicy: {
        attentionRequired: true,
        unassignedWorkspaces: 1,
        missingOwnerWorkspaces: 1,
        lateOwnerWorkspaces: 1,
        drainingOwnerWorkspaces: 1,
        usersSpanningWorkers: 1,
        maxWorkersPerUser: 2,
        workersAboveSoftCapacity: 1,
        maxRefCountPerWorker: 3
      },
      placements: [
        {
          workspaceId: "ws_1",
          version: "live",
          userId: "user_1",
          ownerWorkerId: "worker_missing",
          state: "active",
          refCount: 2,
          updatedAt: "2026-04-15T00:00:00.000Z"
        },
        {
          workspaceId: "ws_2",
          version: "live",
          userId: "user_1",
          ownerWorkerId: "worker_late",
          state: "idle",
          updatedAt: "2026-04-15T00:00:01.000Z"
        },
        {
          workspaceId: "ws_3",
          version: "live",
          userId: "user_2",
          ownerWorkerId: "worker_3",
          state: "draining",
          updatedAt: "2026-04-15T00:00:02.000Z"
        },
        {
          workspaceId: "ws_4",
          version: "live",
          state: "unassigned",
          updatedAt: "2026-04-15T00:00:03.000Z"
        }
      ] satisfies RedisWorkspacePlacementEntry[],
      activeWorkers: [
        {
          workerId: "worker_late",
          processKind: "standalone",
          state: "idle",
          health: "late",
          lastSeenAt: "2026-04-15T00:00:00.000Z",
          leaseTtlMs: 5_000,
          expiresAt: "2026-04-15T00:00:05.000Z",
          lastSeenAgeMs: 4_000
        },
        {
          workerId: "worker_3",
          processKind: "standalone",
          state: "stopping",
          health: "healthy",
          lastSeenAt: "2026-04-15T00:00:00.000Z",
          leaseTtlMs: 5_000,
          expiresAt: "2026-04-15T00:00:05.000Z",
          lastSeenAgeMs: 0
        }
      ] satisfies RedisWorkerRegistryEntry[],
      slotsPerPod: 1
    });

    expect(recommendations).toEqual([
      {
        kind: "assign_unassigned",
        priority: "high",
        workspaceCount: 1,
        sampleWorkspaceIds: ["ws_4"],
        message: "assign 1 unassigned workspace(s) to healthy workers before new locality assumptions form"
      },
      {
        kind: "recover_missing_owner",
        priority: "high",
        workspaceCount: 1,
        workerCount: 1,
        sampleWorkspaceIds: ["ws_1"],
        sampleWorkerIds: ["worker_missing"],
        message: "recover or reassign 1 workspace(s) still pointing at missing owners"
      },
      {
        kind: "reassign_late_owner",
        priority: "high",
        workspaceCount: 1,
        workerCount: 1,
        sampleWorkspaceIds: ["ws_2"],
        sampleWorkerIds: ["worker_late"],
        message: "stabilize or reassign 1 workspace(s) currently attached to late owners"
      },
      {
        kind: "finish_draining_owner",
        priority: "medium",
        workspaceCount: 1,
        sampleWorkspaceIds: ["ws_3"],
        sampleWorkerIds: ["worker_3"],
        message: "finish draining or hand off 1 workspace(s) on workers that are stopping"
      },
      {
        kind: "consolidate_user_affinity",
        priority: "medium",
        workspaceCount: 0,
        userCount: 1,
        sampleUserIds: ["user_1"],
        message: "consider consolidating 1 user affinity group(s) that currently span multiple workers"
      },
      {
        kind: "rebalance_soft_capacity",
        priority: "medium",
        workspaceCount: 0,
        workerCount: 1,
        sampleWorkerIds: ["worker_missing"],
        message: "rebalance placements away from 1 worker(s) above the soft slots-per-pod capacity"
      }
    ]);
  });

  it("derives a placement action plan from recommendations", () => {
    const actionPlan = summarizePlacementActionPlan([
      {
        kind: "recover_missing_owner",
        priority: "high",
        workspaceCount: 2,
        workerCount: 1,
        sampleWorkspaceIds: ["ws_1", "ws_2"],
        sampleWorkerIds: ["worker_missing"],
        message: "recover missing owners"
      },
      {
        kind: "consolidate_user_affinity",
        priority: "medium",
        workspaceCount: 0,
        userCount: 1,
        sampleUserIds: ["user_1"],
        message: "consolidate user affinity"
      }
    ]);

    expect(actionPlan).toEqual({
      totalItems: 2,
      highPriorityItems: 1,
      nextItem: {
        id: "recover_missing_owner:1",
        phase: "stabilize",
        kind: "recover_missing_owner",
        priority: "high",
        blockers: ["owner_missing"],
        workspaceIds: ["ws_1", "ws_2"],
        workerIds: ["worker_missing"],
        summary: "recover missing owners"
      },
      items: [
        {
          id: "recover_missing_owner:1",
          phase: "stabilize",
          kind: "recover_missing_owner",
          priority: "high",
          blockers: ["owner_missing"],
          workspaceIds: ["ws_1", "ws_2"],
          workerIds: ["worker_missing"],
          summary: "recover missing owners"
        },
        {
          id: "consolidate_user_affinity:2",
          phase: "optimize",
          kind: "consolidate_user_affinity",
          priority: "medium",
          blockers: ["user_affinity_split"],
          userIds: ["user_1"],
          summary: "consolidate user affinity"
        }
      ]
    });
  });

  it("builds executable placement operations from placement ownership signals", () => {
    const operations = buildPlacementExecutionOperations({
      placements: [
        {
          workspaceId: "ws_missing",
          version: "live",
          ownerWorkerId: "worker_missing",
          state: "active",
          updatedAt: "2026-04-15T00:00:00.000Z"
        },
        {
          workspaceId: "ws_drain",
          version: "live",
          ownerWorkerId: "worker_draining",
          state: "draining",
          updatedAt: "2026-04-15T00:00:01.000Z"
        },
        {
          workspaceId: "ws_late",
          version: "live",
          ownerWorkerId: "worker_late",
          state: "idle",
          updatedAt: "2026-04-15T00:00:02.000Z"
        }
      ] satisfies RedisWorkspacePlacementEntry[],
      activeWorkers: [
        {
          workerId: "worker_draining",
          processKind: "standalone",
          state: "stopping",
          health: "healthy",
          lastSeenAt: "2026-04-15T00:00:00.000Z",
          leaseTtlMs: 5_000,
          expiresAt: "2026-04-15T00:00:05.000Z",
          lastSeenAgeMs: 0
        },
        {
          workerId: "worker_late",
          processKind: "standalone",
          state: "idle",
          health: "late",
          lastSeenAt: "2026-04-15T00:00:00.000Z",
          leaseTtlMs: 5_000,
          expiresAt: "2026-04-15T00:00:05.000Z",
          lastSeenAgeMs: 4_000
        }
      ] satisfies RedisWorkerRegistryEntry[]
    });

    expect(operations).toEqual([
      {
        id: "finish_draining_owner:ws_drain",
        kind: "finish_draining_owner",
        workspaceId: "ws_drain",
        ownerWorkerId: "worker_draining",
        state: "draining",
        action: "release_ownership",
        reason: "worker_draining"
      },
      {
        id: "reassign_late_owner:ws_late",
        kind: "reassign_late_owner",
        workspaceId: "ws_late",
        ownerWorkerId: "worker_late",
        state: "idle",
        action: "release_ownership",
        reason: "owner_late"
      },
      {
        id: "recover_missing_owner:ws_missing",
        kind: "recover_missing_owner",
        workspaceId: "ws_missing",
        ownerWorkerId: "worker_missing",
        state: "active",
        action: "release_ownership",
        reason: "owner_missing"
      }
    ]);
  });

  it("derives target-worker hints for unassigned and optimization-focused placement actions", () => {
    const operations = buildPlacementExecutionOperations({
      placements: [
        {
          workspaceId: "ws_unassigned",
          version: "live",
          userId: "user_1",
          state: "unassigned",
          updatedAt: "2026-04-15T00:00:00.000Z"
        },
        {
          workspaceId: "ws_busy",
          version: "live",
          userId: "user_1",
          ownerWorkerId: "worker_1",
          state: "active",
          refCount: 2,
          updatedAt: "2026-04-15T00:00:01.000Z"
        },
        {
          workspaceId: "ws_idle_split",
          version: "live",
          userId: "user_1",
          ownerWorkerId: "worker_2",
          state: "idle",
          updatedAt: "2026-04-15T00:00:02.000Z"
        }
      ] satisfies RedisWorkspacePlacementEntry[],
      activeWorkers: [
        {
          workerId: "worker_1",
          processKind: "standalone",
          state: "idle",
          health: "healthy",
          lastSeenAt: "2026-04-15T00:00:00.000Z",
          leaseTtlMs: 5_000,
          expiresAt: "2026-04-15T00:00:05.000Z",
          lastSeenAgeMs: 0
        },
        {
          workerId: "worker_2",
          processKind: "standalone",
          state: "idle",
          health: "healthy",
          lastSeenAt: "2026-04-15T00:00:00.000Z",
          leaseTtlMs: 5_000,
          expiresAt: "2026-04-15T00:00:05.000Z",
          lastSeenAgeMs: 0
        }
      ] satisfies RedisWorkerRegistryEntry[],
      slotsPerPod: 1
    });

    expect(operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "assign_unassigned:ws_unassigned",
          kind: "assign_unassigned",
          action: "set_preferred_worker",
          reason: "unassigned_workspace",
          targetWorkerId: "worker_1"
        }),
        expect.objectContaining({
          id: "consolidate_user_affinity:ws_idle_split",
          kind: "consolidate_user_affinity",
          action: "set_preferred_worker",
          reason: "user_affinity_split",
          targetWorkerId: "worker_1"
        })
      ])
    );
  });

  it("resolves controller config from standalone/controller settings", () => {
    const config = resolveStandaloneControllerConfig({
      server: { host: "127.0.0.1", port: 8787 },
      storage: { redis_url: "redis://local/0" },
      paths: {
        workspace_dir: "/tmp/workspaces",
        blueprint_dir: "/tmp/blueprints",
        model_dir: "/tmp/models",
        tool_dir: "/tmp/tools",
        skill_dir: "/tmp/skills"
      },
      workers: {
        standalone: {
          min_replicas: 2,
          max_replicas: 7,
          slots_per_pod: 3,
          ready_sessions_per_worker: 2,
          reserved_capacity_for_subagent: 5
        },
        controller: {
          scale_interval_ms: 1500,
          scale_up_window: 4,
          scale_down_window: 6,
          cooldown_ms: 2500,
          scale_up_busy_ratio_threshold: 0.9,
          scale_up_max_ready_age_ms: 3200
        }
      },
      llm: {
        default_model: "openai-default"
      }
    });

    expect(config).toEqual({
      minReplicas: 2,
      maxReplicas: 7,
      slotsPerPod: 3,
      readySessionsPerWorker: 2,
      reservedSubagentCapacity: 5,
      scaleIntervalMs: 1500,
      scaleUpCooldownMs: 2500,
      scaleDownCooldownMs: 2500,
      scaleUpSampleSize: 4,
      scaleDownSampleSize: 6,
      scaleUpBusyRatioThreshold: 0.9,
      scaleUpMaxReadyAgeMs: 3200
    });
  });

  it("holds scale-down during cooldown before changing desired replicas", async () => {
    const queue = {
      async getSchedulingPressure() {
        return {
          readySessionCount: 0
        };
      }
    };
    let activeWorkers: RedisWorkerRegistryEntry[] = [
      {
        workerId: "worker_1",
        runtimeInstanceId: "pod-a",
        ownerBaseUrl: "http://worker-a.internal:8787",
        processKind: "standalone",
        state: "idle",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        leaseTtlMs: 5_000,
        expiresAt: "2026-04-14T00:00:05.000Z",
        lastSeenAgeMs: 0,
        health: "healthy"
      },
      {
        workerId: "worker_2",
        runtimeInstanceId: "pod-b",
        ownerBaseUrl: "http://worker-b.internal:8787",
        processKind: "standalone",
        state: "idle",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        leaseTtlMs: 5_000,
        expiresAt: "2026-04-14T00:00:05.000Z",
        lastSeenAgeMs: 0,
        health: "healthy"
      }
    ];
    const registry = {
      async heartbeat() {},
      async remove() {},
      async listActive() {
        return activeWorkers;
      }
    };

    const controller = new RedisController({
      queue: queue as never,
      registry: registry,
      config: {
        minReplicas: 1,
        maxReplicas: 6,
        slotsPerPod: 1,
        readySessionsPerWorker: 1,
        reservedSubagentCapacity: 0,
        scaleIntervalMs: 5_000,
        scaleUpCooldownMs: 1,
        scaleDownCooldownMs: 60_000,
        scaleUpSampleSize: 1,
      scaleDownSampleSize: 1,
      scaleUpBusyRatioThreshold: 0.75,
      scaleUpMaxReadyAgeMs: 2_000
      },
      healthProbe: async () => ({
        draining: false,
        materializationBlockerCount: 0,
        materializationFailureCount: 0
      })
    });

    const startup = await controller.evaluateNow("startup");
    expect(startup.desiredReplicas).toBe(1);

    const interval = await controller.evaluateNow("interval");
    expect(interval.suggestedReplicas).toBe(1);
    expect(interval.desiredReplicas).toBe(1);
    expect(interval.lastRebalanceReason).toBe("scale_down");

    activeWorkers = activeWorkers.slice(0, 1);
    await controller.close();
  });

  it("reconciles controller decisions through an injected scale target", async () => {
    const queue = {
      async getSchedulingPressure() {
        return {
          readySessionCount: 4,
          oldestSchedulableReadyAgeMs: 3_000
        };
      }
    };
    const registry = {
      async heartbeat() {},
      async remove() {},
      async listActive() {
        return [
          {
            workerId: "worker_1",
            runtimeInstanceId: "pod-a",
            processKind: "standalone",
            state: "busy",
            lastSeenAt: "2026-04-14T00:00:00.000Z",
            leaseTtlMs: 5_000,
            expiresAt: "2026-04-14T00:00:05.000Z",
            lastSeenAgeMs: 0,
            health: "healthy"
          }
        ] satisfies RedisWorkerRegistryEntry[];
      }
    };
    const controller = new RedisController({
      queue: queue as never,
      registry,
      config: {
        minReplicas: 1,
        maxReplicas: 6,
        slotsPerPod: 1,
        readySessionsPerWorker: 1,
        reservedSubagentCapacity: 0,
        scaleIntervalMs: 5_000,
        scaleUpCooldownMs: 1,
        scaleDownCooldownMs: 60_000,
        scaleUpSampleSize: 1,
        scaleDownSampleSize: 1,
        scaleUpBusyRatioThreshold: 0.75,
        scaleUpMaxReadyAgeMs: 2_000
      },
      scaleTarget: {
        kind: "test-target",
        async reconcile(input) {
          return {
            kind: "test-target",
            attempted: true,
            applied: true,
            desiredReplicas: input.desiredReplicas,
            observedReplicas: 1,
            appliedReplicas: input.desiredReplicas,
            outcome: "scaled",
            at: input.timestamp
          };
        }
      }
    });

    const snapshot = await controller.evaluateNow("interval");
    expect(snapshot.scaleTarget).toEqual({
      kind: "test-target",
      attempted: true,
      applied: true,
      desiredReplicas: 5,
      observedReplicas: 1,
      appliedReplicas: 5,
      outcome: "scaled",
      at: snapshot.lastRebalanceAt
    });
    await controller.close();
  });

  it("blocks scale-down when workspace placement still points at a missing owner worker", async () => {
    const queue = {
      async getSchedulingPressure() {
        return {
          readySessionCount: 0
        };
      }
    };
    const registry = {
      async heartbeat() {},
      async remove() {},
      async listActive() {
        return [
          {
            workerId: "worker_1",
            runtimeInstanceId: "pod-a",
            ownerBaseUrl: "http://worker-a.internal:8787",
            processKind: "standalone",
            state: "idle",
            lastSeenAt: "2026-04-14T00:00:00.000Z",
            leaseTtlMs: 5_000,
            expiresAt: "2026-04-14T00:00:05.000Z",
            lastSeenAgeMs: 0,
            health: "healthy"
          },
          {
            workerId: "worker_2",
            runtimeInstanceId: "pod-b",
            ownerBaseUrl: "http://worker-b.internal:8787",
            processKind: "standalone",
            state: "idle",
            lastSeenAt: "2026-04-14T00:00:00.000Z",
            leaseTtlMs: 5_000,
            expiresAt: "2026-04-14T00:00:05.000Z",
            lastSeenAgeMs: 0,
            health: "healthy"
          }
        ] satisfies RedisWorkerRegistryEntry[];
      }
    };
    const placementRegistry = {
      async upsert() {},
      async assignUser() {},
      async setPreferredWorker() {},
      async releaseOwnership() {},
      async listAll() {
        return [
          {
            workspaceId: "ws_1",
            version: "live",
            ownerWorkerId: "worker_missing",
            state: "active",
            updatedAt: "2026-04-15T00:00:00.000Z"
          }
        ] satisfies RedisWorkspacePlacementEntry[];
      },
      async getByWorkspaceId() {
        return undefined;
      }
    };

    const controller = new RedisController({
      queue: queue as never,
      registry,
      placementRegistry,
      config: {
        minReplicas: 1,
        maxReplicas: 6,
        slotsPerPod: 1,
        readySessionsPerWorker: 1,
        reservedSubagentCapacity: 0,
        scaleIntervalMs: 5_000,
        scaleUpCooldownMs: 1,
        scaleDownCooldownMs: 60_000,
        scaleUpSampleSize: 1,
        scaleDownSampleSize: 1,
        scaleUpBusyRatioThreshold: 0.75,
        scaleUpMaxReadyAgeMs: 2_000
      },
      healthProbe: async () => ({
        draining: false,
        materializationBlockerCount: 0,
        materializationFailureCount: 0
      })
    });

    const snapshot = await controller.evaluateNow("interval");

    expect(snapshot.suggestedReplicas).toBe(1);
    expect(snapshot.desiredReplicas).toBe(2);
    expect(snapshot.lastRebalanceReason).toBe("scale_down_blocked");
    expect(snapshot.placement).toMatchObject({
      ownedByMissingWorkers: 1,
      workersWithMissingPlacements: 1
    });
    expect(snapshot.scaleDownGate).toMatchObject({
      allowed: false
    });
    expect(snapshot.scaleDownGate?.placementBlockers).toEqual([
      {
        reason: "missing_owner_worker",
        workspaceCount: 1,
        workerCount: 1,
        message: "workspace placement still references 1 missing worker(s) across 1 workspace(s)"
      }
    ]);

    await controller.close();
  });

  it("marks steady replicas as placement attention when user affinity and drain signals need follow-up", async () => {
    const queue = {
      async getSchedulingPressure() {
        return {
          readySessionCount: 0
        };
      }
    };
    const registry = {
      async heartbeat() {},
      async remove() {},
      async listActive() {
        return [
          {
            workerId: "worker_1",
            runtimeInstanceId: "pod-a",
            ownerBaseUrl: "http://worker-a.internal:8787",
            processKind: "standalone",
            state: "idle",
            lastSeenAt: "2026-04-14T00:00:00.000Z",
            leaseTtlMs: 5_000,
            expiresAt: "2026-04-14T00:00:05.000Z",
            lastSeenAgeMs: 0,
            health: "healthy"
          },
          {
            workerId: "worker_2",
            runtimeInstanceId: "pod-b",
            ownerBaseUrl: "http://worker-b.internal:8787",
            processKind: "standalone",
            state: "stopping",
            lastSeenAt: "2026-04-14T00:00:00.000Z",
            leaseTtlMs: 5_000,
            expiresAt: "2026-04-14T00:00:05.000Z",
            lastSeenAgeMs: 0,
            health: "healthy"
          }
        ] satisfies RedisWorkerRegistryEntry[];
      }
    };
    const placementRegistry = {
      async upsert() {},
      async assignUser() {},
      async setPreferredWorker() {},
      async releaseOwnership() {},
      async listAll() {
        return [
          {
            workspaceId: "ws_1",
            version: "live",
            userId: "user_1",
            ownerWorkerId: "worker_1",
            state: "active",
            refCount: 2,
            updatedAt: "2026-04-15T00:00:00.000Z"
          },
          {
            workspaceId: "ws_2",
            version: "live",
            userId: "user_1",
            ownerWorkerId: "worker_2",
            state: "draining",
            updatedAt: "2026-04-15T00:00:01.000Z"
          }
        ] satisfies RedisWorkspacePlacementEntry[];
      },
      async getByWorkspaceId() {
        return undefined;
      }
    };

    const controller = new RedisController({
      queue: queue as never,
      registry,
      placementRegistry,
      config: {
        minReplicas: 2,
        maxReplicas: 6,
        slotsPerPod: 1,
        readySessionsPerWorker: 1,
        reservedSubagentCapacity: 0,
        scaleIntervalMs: 5_000,
        scaleUpCooldownMs: 1,
        scaleDownCooldownMs: 60_000,
        scaleUpSampleSize: 1,
        scaleDownSampleSize: 1,
        scaleUpBusyRatioThreshold: 0.75,
        scaleUpMaxReadyAgeMs: 2_000
      },
      healthProbe: async () => ({
        draining: false,
        materializationBlockerCount: 0,
        materializationFailureCount: 0
      })
    });

    const snapshot = await controller.evaluateNow("interval");

    expect(snapshot.suggestedReplicas).toBe(2);
    expect(snapshot.desiredReplicas).toBe(2);
    expect(snapshot.lastRebalanceReason).toBe("placement_attention");
    expect(snapshot.placementPolicy).toEqual({
      attentionRequired: true,
      unassignedWorkspaces: 0,
      missingOwnerWorkspaces: 0,
      lateOwnerWorkspaces: 0,
      drainingOwnerWorkspaces: 1,
      usersSpanningWorkers: 1,
      maxWorkersPerUser: 2,
      workersAboveSoftCapacity: 1,
      maxRefCountPerWorker: 2
    });
    expect(snapshot.placementRecommendations).toEqual([
      {
        kind: "finish_draining_owner",
        priority: "medium",
        workspaceCount: 1,
        sampleWorkspaceIds: ["ws_2"],
        sampleWorkerIds: ["worker_2"],
        message: "finish draining or hand off 1 workspace(s) on workers that are stopping"
      },
      {
        kind: "consolidate_user_affinity",
        priority: "medium",
        workspaceCount: 0,
        userCount: 1,
        sampleUserIds: ["user_1"],
        message: "consider consolidating 1 user affinity group(s) that currently span multiple workers"
      },
      {
        kind: "rebalance_soft_capacity",
        priority: "medium",
        workspaceCount: 0,
        workerCount: 1,
        sampleWorkerIds: ["worker_1"],
        message: "rebalance placements away from 1 worker(s) above the soft slots-per-pod capacity"
      }
    ]);
    expect(snapshot.placementActionPlan).toEqual({
      totalItems: 3,
      highPriorityItems: 0,
      nextItem: {
        id: "finish_draining_owner:1",
        phase: "handoff",
        kind: "finish_draining_owner",
        priority: "medium",
        blockers: ["worker_draining"],
        workspaceIds: ["ws_2"],
        workerIds: ["worker_2"],
        summary: "finish draining or hand off 1 workspace(s) on workers that are stopping"
      },
      items: [
        {
          id: "finish_draining_owner:1",
          phase: "handoff",
          kind: "finish_draining_owner",
          priority: "medium",
          blockers: ["worker_draining"],
          workspaceIds: ["ws_2"],
          workerIds: ["worker_2"],
          summary: "finish draining or hand off 1 workspace(s) on workers that are stopping"
        },
        {
          id: "consolidate_user_affinity:2",
          phase: "optimize",
          kind: "consolidate_user_affinity",
          priority: "medium",
          blockers: ["user_affinity_split"],
          userIds: ["user_1"],
          summary: "consider consolidating 1 user affinity group(s) that currently span multiple workers"
        },
        {
          id: "rebalance_soft_capacity:3",
          phase: "optimize",
          kind: "rebalance_soft_capacity",
          priority: "medium",
          blockers: ["soft_capacity_exceeded"],
          workerIds: ["worker_1"],
          summary: "rebalance placements away from 1 worker(s) above the soft slots-per-pod capacity"
        }
      ]
    });

    await controller.close();
  });

  it("executes safe placement handoff actions and refreshes the controller snapshot", async () => {
    const queue = {
      async getSchedulingPressure() {
        return {
          readySessionCount: 0
        };
      }
    };
    const registry = {
      async heartbeat() {},
      async remove() {},
      async listActive() {
        return [
          {
            workerId: "worker_1",
            runtimeInstanceId: "pod-a",
            ownerBaseUrl: "http://worker-a.internal:8787",
            processKind: "standalone",
            state: "idle",
            lastSeenAt: "2026-04-14T00:00:00.000Z",
            leaseTtlMs: 5_000,
            expiresAt: "2026-04-14T00:00:05.000Z",
            lastSeenAgeMs: 0,
            health: "healthy"
          },
          {
            workerId: "worker_2",
            runtimeInstanceId: "pod-b",
            ownerBaseUrl: "http://worker-b.internal:8787",
            processKind: "standalone",
            state: "idle",
            lastSeenAt: "2026-04-14T00:00:00.000Z",
            leaseTtlMs: 5_000,
            expiresAt: "2026-04-14T00:00:05.000Z",
            lastSeenAgeMs: 0,
            health: "healthy"
          }
        ] satisfies RedisWorkerRegistryEntry[];
      }
    };
    const placements: RedisWorkspacePlacementEntry[] = [
      {
        workspaceId: "ws_1",
        version: "live",
        ownerWorkerId: "worker_missing",
        state: "active",
        updatedAt: "2026-04-15T00:00:00.000Z"
      }
    ];
    const placementRegistry = {
      async upsert() {},
      async assignUser() {},
      async setPreferredWorker(workspaceId: string, preferredWorkerId: string, options?: { updatedAt?: string }) {
        const placement = placements.find((item) => item.workspaceId === workspaceId);
        if (!placement) {
          return;
        }
        placement.preferredWorkerId = preferredWorkerId;
        placement.preferredWorkerReason = "controller_target";
        placement.updatedAt = options?.updatedAt ?? placement.updatedAt;
      },
      async releaseOwnership(workspaceId: string, options?: { state?: "unassigned" | "active" | "idle" | "draining" | "evicted"; updatedAt?: string }) {
        const placement = placements.find((item) => item.workspaceId === workspaceId);
        if (!placement) {
          return;
        }
        placement.state = options?.state ?? "unassigned";
        placement.updatedAt = options?.updatedAt ?? placement.updatedAt;
        delete placement.ownerWorkerId;
        delete placement.ownerBaseUrl;
        delete placement.localPath;
        delete placement.materializedAt;
        if ("preferredWorkerId" in placement) {
          delete placement.preferredWorkerId;
        }
        if ("preferredWorkerReason" in placement) {
          delete placement.preferredWorkerReason;
        }
        placement.refCount = 0;
        placement.dirty = false;
        if (options && "preferredWorkerId" in options && typeof (options as { preferredWorkerId?: string }).preferredWorkerId === "string") {
          placement.preferredWorkerId = (options as { preferredWorkerId?: string }).preferredWorkerId;
          placement.preferredWorkerReason = "controller_target";
        }
      },
      async listAll() {
        return placements.map((placement) => ({ ...placement }));
      },
      async getByWorkspaceId(workspaceId: string) {
        return placements.find((placement) => placement.workspaceId === workspaceId);
      }
    };

    const controller = new RedisController({
      queue: queue as never,
      registry,
      placementRegistry,
      placementExecutor: createPlacementRegistryActionExecutor({
        placementRegistry
      }),
      config: {
        minReplicas: 1,
        maxReplicas: 6,
        slotsPerPod: 1,
        readySessionsPerWorker: 1,
        reservedSubagentCapacity: 0,
        scaleIntervalMs: 5_000,
        scaleUpCooldownMs: 1,
        scaleDownCooldownMs: 60_000,
        scaleUpSampleSize: 1,
        scaleDownSampleSize: 1,
        scaleUpBusyRatioThreshold: 0.75,
        scaleUpMaxReadyAgeMs: 2_000
      },
      healthProbe: async () => ({
        draining: false,
        materializationBlockerCount: 0,
        materializationFailureCount: 0
      })
    });

    const snapshot = await controller.evaluateNow("interval");

    expect(snapshot.placement).toMatchObject({
      ownedByMissingWorkers: 0,
      unassigned: 1
    });
    expect(snapshot.placementExecution).toEqual({
      attempted: 1,
      applied: 1,
      skipped: 0,
      failed: 0,
      operations: [
        {
          id: "recover_missing_owner:ws_1",
          kind: "recover_missing_owner",
          workspaceId: "ws_1",
          ownerWorkerId: "worker_missing",
          state: "active",
          action: "release_ownership",
          reason: "owner_missing",
          status: "applied",
          targetWorkerId: "worker_1",
          targetWorkerReasons: ["healthy", "idle_slot_capacity"],
          message: "workspace ownership was released for controller-driven reassignment toward worker_1"
        }
      ]
    });
    expect(snapshot.scaleDownGate).toMatchObject({
      allowed: true
    });
    expect(snapshot.desiredReplicas).toBe(1);

    await controller.close();
  });

  it("resolves kubernetes scale target settings", () => {
    const target = resolveWorkerReplicaTargetConfig({
      server: { host: "127.0.0.1", port: 8787 },
      storage: { redis_url: "redis://local/0" },
      paths: {
        workspace_dir: "/tmp/workspaces",
        blueprint_dir: "/tmp/blueprints",
        model_dir: "/tmp/models",
        tool_dir: "/tmp/tools",
        skill_dir: "/tmp/skills"
      },
      workers: {
        controller: {
          scale_target: {
            type: "kubernetes",
            allow_scale_down: false,
            kubernetes: {
              namespace: "open-agent-harness",
              deployment: "oah-worker",
              api_url: "https://kubernetes.default.svc",
              token_file: "/var/run/secrets/kubernetes.io/serviceaccount/token",
              ca_file: "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
            }
          }
        }
      },
      llm: {
        default_model: "openai-default"
      }
    });

    expect(target).toEqual({
      type: "kubernetes",
      allowScaleDown: false,
      kubernetes: {
        namespace: "open-agent-harness",
        deployment: "oah-worker",
        apiUrl: "https://kubernetes.default.svc",
        tokenFile: "/var/run/secrets/kubernetes.io/serviceaccount/token",
        caFile: "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
        skipTlsVerify: false
      }
    });
  });

  it("resolves kubernetes scale target discovery settings from label selector", () => {
    const target = resolveWorkerReplicaTargetConfig({
      server: { host: "127.0.0.1", port: 8787 },
      storage: { redis_url: "redis://local/0" },
      paths: {
        workspace_dir: "/tmp/workspaces",
        blueprint_dir: "/tmp/blueprints",
        model_dir: "/tmp/models",
        tool_dir: "/tmp/tools",
        skill_dir: "/tmp/skills"
      },
      workers: {
        controller: {
          scale_target: {
            type: "kubernetes",
            kubernetes: {
              namespace: "open-agent-harness",
              label_selector: "app.kubernetes.io/component=worker",
              api_url: "https://kubernetes.default.svc",
              token_file: "/var/run/secrets/kubernetes.io/serviceaccount/token"
            }
          }
        }
      },
      llm: {
        default_model: "openai-default"
      }
    });

    expect(target).toEqual({
      type: "kubernetes",
      allowScaleDown: true,
      kubernetes: {
        namespace: "open-agent-harness",
        labelSelector: "app.kubernetes.io/component=worker",
        apiUrl: "https://kubernetes.default.svc",
        tokenFile: "/var/run/secrets/kubernetes.io/serviceaccount/token",
        caFile: "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
        skipTlsVerify: false
      }
    });
  });

  it("defaults kubernetes scale target to allow scale-down once controller gating is active", () => {
    const target = resolveWorkerReplicaTargetConfig({
      server: { host: "127.0.0.1", port: 8787 },
      storage: { redis_url: "redis://local/0" },
      paths: {
        workspace_dir: "/tmp/workspaces",
        blueprint_dir: "/tmp/blueprints",
        model_dir: "/tmp/models",
        tool_dir: "/tmp/tools",
        skill_dir: "/tmp/skills"
      },
      workers: {
        controller: {
          scale_target: {
            type: "kubernetes",
            kubernetes: {
              namespace: "open-agent-harness",
              deployment: "oah-worker",
              api_url: "https://kubernetes.default.svc",
              token_file: "/var/run/secrets/kubernetes.io/serviceaccount/token"
            }
          }
        }
      },
      llm: {
        default_model: "openai-default"
      }
    });

    expect(target).toMatchObject({
      type: "kubernetes",
      allowScaleDown: true
    });
  });

  it("resolves kubernetes leader election settings", () => {
    const leaderElection = resolveControllerLeaderElectionConfig({
      server: { host: "127.0.0.1", port: 8787 },
      storage: { redis_url: "redis://local/0" },
      paths: {
        workspace_dir: "/tmp/workspaces",
        blueprint_dir: "/tmp/blueprints",
        model_dir: "/tmp/models",
        tool_dir: "/tmp/tools",
        skill_dir: "/tmp/skills"
      },
      workers: {
        controller: {
          leader_election: {
            type: "kubernetes",
            kubernetes: {
              namespace: "open-agent-harness",
              lease_name: "oah-controller",
              api_url: "https://kubernetes.default.svc",
              token_file: "/var/run/secrets/kubernetes.io/serviceaccount/token",
              ca_file: "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
              lease_duration_ms: 15000,
              renew_interval_ms: 5000,
              retry_interval_ms: 2000,
              identity: "controller-a"
            }
          }
        }
      },
      llm: {
        default_model: "openai-default"
      }
    });

    expect(leaderElection).toEqual({
      type: "kubernetes",
      identity: "controller-a",
      namespace: "open-agent-harness",
      leaseName: "oah-controller",
      apiUrl: "https://kubernetes.default.svc",
      tokenFile: "/var/run/secrets/kubernetes.io/serviceaccount/token",
      caFile: "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
      skipTlsVerify: false,
      leaseDurationMs: 15000,
      renewIntervalMs: 5000,
      retryIntervalMs: 2000
    });
  });

  it("blocks controller scale-down when a worker replica is still draining", async () => {
    const queue = {
      async getSchedulingPressure() {
        return {
          readySessionCount: 0
        };
      }
    };
    const registry = {
      async heartbeat() {},
      async remove() {},
      async listActive() {
        return [
          {
            workerId: "worker_1",
            runtimeInstanceId: "pod-a",
            ownerBaseUrl: "http://worker-a.internal:8787",
            processKind: "standalone",
            state: "idle",
            lastSeenAt: "2026-04-14T00:00:00.000Z",
            leaseTtlMs: 5_000,
            expiresAt: "2026-04-14T00:00:05.000Z",
            lastSeenAgeMs: 0,
            health: "healthy"
          },
          {
            workerId: "worker_2",
            runtimeInstanceId: "pod-b",
            ownerBaseUrl: "http://worker-b.internal:8787",
            processKind: "standalone",
            state: "idle",
            lastSeenAt: "2026-04-14T00:00:00.000Z",
            leaseTtlMs: 5_000,
            expiresAt: "2026-04-14T00:00:05.000Z",
            lastSeenAgeMs: 0,
            health: "healthy"
          }
        ] satisfies RedisWorkerRegistryEntry[];
      }
    };
    const controller = new RedisController({
      queue: queue as never,
      registry,
      config: {
        minReplicas: 1,
        maxReplicas: 6,
        slotsPerPod: 1,
        readySessionsPerWorker: 1,
        reservedSubagentCapacity: 0,
        scaleIntervalMs: 5_000,
        scaleUpCooldownMs: 1,
        scaleDownCooldownMs: 1,
        scaleUpSampleSize: 1,
        scaleDownSampleSize: 1,
        scaleUpBusyRatioThreshold: 0.75,
        scaleUpMaxReadyAgeMs: 2_000
      },
      healthProbe: async ({ replicaId }) => ({
        draining: replicaId === "pod-a",
        materializationBlockerCount: 0,
        materializationFailureCount: 0
      })
    });

    const snapshot = await controller.evaluateNow("interval");

    expect(snapshot.suggestedReplicas).toBe(1);
    expect(snapshot.desiredReplicas).toBe(2);
    expect(snapshot.lastRebalanceReason).toBe("scale_down_blocked");
    expect(snapshot.scaleDownGate).toMatchObject({
      allowed: false,
      checkedReplicas: 2,
      blockedReplicas: 1,
      blockers: [
        expect.objectContaining({
          replicaId: "pod-a",
          reason: "worker_draining"
        })
      ]
    });
    await controller.close();
  });

  it("blocks controller scale-down when worker materialization still reports blockers", async () => {
    const queue = {
      async getSchedulingPressure() {
        return {
          readySessionCount: 0
        };
      }
    };
    const registry = {
      async heartbeat() {},
      async remove() {},
      async listActive() {
        return [
          {
            workerId: "worker_1",
            runtimeInstanceId: "pod-a",
            ownerBaseUrl: "http://worker-a.internal:8787",
            processKind: "standalone",
            state: "idle",
            lastSeenAt: "2026-04-14T00:00:00.000Z",
            leaseTtlMs: 5_000,
            expiresAt: "2026-04-14T00:00:05.000Z",
            lastSeenAgeMs: 0,
            health: "healthy"
          },
          {
            workerId: "worker_2",
            runtimeInstanceId: "pod-b",
            ownerBaseUrl: "http://worker-b.internal:8787",
            processKind: "standalone",
            state: "idle",
            lastSeenAt: "2026-04-14T00:00:00.000Z",
            leaseTtlMs: 5_000,
            expiresAt: "2026-04-14T00:00:05.000Z",
            lastSeenAgeMs: 0,
            health: "healthy"
          }
        ] satisfies RedisWorkerRegistryEntry[];
      }
    };
    const reconciles: number[] = [];
    const controller = new RedisController({
      queue: queue as never,
      registry,
      config: {
        minReplicas: 1,
        maxReplicas: 6,
        slotsPerPod: 1,
        readySessionsPerWorker: 1,
        reservedSubagentCapacity: 0,
        scaleIntervalMs: 5_000,
        scaleUpCooldownMs: 1,
        scaleDownCooldownMs: 1,
        scaleUpSampleSize: 1,
        scaleDownSampleSize: 1,
        scaleUpBusyRatioThreshold: 0.75,
        scaleUpMaxReadyAgeMs: 2_000
      },
      healthProbe: async ({ replicaId }) => ({
        draining: false,
        materializationBlockerCount: replicaId === "pod-b" ? 2 : 0,
        materializationFailureCount: replicaId === "pod-b" ? 1 : 0
      }),
      scaleTarget: {
        kind: "test-target",
        async reconcile(input) {
          reconciles.push(input.desiredReplicas);
          return {
            kind: "test-target",
            attempted: true,
            applied: false,
            desiredReplicas: input.desiredReplicas,
            observedReplicas: 2,
            appliedReplicas: 2,
            outcome: "steady",
            at: input.timestamp
          };
        }
      }
    });

    const snapshot = await controller.evaluateNow("interval");

    expect(snapshot.suggestedReplicas).toBe(1);
    expect(snapshot.desiredReplicas).toBe(2);
    expect(snapshot.lastRebalanceReason).toBe("scale_down_blocked");
    expect(snapshot.scaleDownGate).toMatchObject({
      allowed: false,
      blockedReplicas: 1,
      blockers: [
        expect.objectContaining({
          replicaId: "pod-b",
          reason: "materialization_blocked",
          materializationBlockerCount: 2,
          materializationFailureCount: 1
        })
      ]
    });
    expect(reconciles).toEqual([2]);
    await controller.close();
  });

  it("acquires and renews kubernetes leadership lease", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-controller-lease-"));
    tempDirs.push(tempDir);
    const tokenFile = path.join(tempDir, "token");
    await writeFile(tokenFile, "test-token", "utf8");

    let getCount = 0;
    let currentHolder = "other-controller";
    let currentResourceVersion = "12";
    const gained: string[] = [];
    const lost: string[] = [];
    const requests: Array<{ method: string; body?: string | undefined }> = [];

    const elector = createControllerLeaderElector(
      {
        type: "kubernetes",
        identity: "controller-a",
        namespace: "open-agent-harness",
        leaseName: "oah-controller",
        apiUrl: "https://kubernetes.default.svc",
        tokenFile,
        caFile: undefined,
        skipTlsVerify: true,
        leaseDurationMs: 1000,
        renewIntervalMs: 10,
        retryIntervalMs: 10
      },
      {
        onGainedLeadership() {
          gained.push("gained");
        },
        onLostLeadership() {
          lost.push("lost");
        },
        request: async (request) => {
          requests.push({
            method: request.method,
            body: request.body
          });
          if (request.method === "GET") {
            getCount += 1;
            if (getCount === 1) {
              return {
                status: 200,
                body: {
                  metadata: {
                    resourceVersion: currentResourceVersion
                  },
                  spec: {
                    holderIdentity: currentHolder,
                    renewTime: "2026-04-15T00:00:00.000Z",
                    leaseDurationSeconds: 1,
                    leaseTransitions: 2
                  }
                },
                text: "{}"
              };
            }

            return {
              status: 200,
              body: {
                metadata: {
                  resourceVersion: currentResourceVersion
                },
                spec: {
                  holderIdentity: currentHolder,
                  renewTime: new Date().toISOString(),
                  leaseDurationSeconds: 1,
                  leaseTransitions: 3
                }
              },
              text: "{}"
            };
          }

          currentHolder = "controller-a";
          currentResourceVersion = "13";
          return {
            status: 200,
            body: {
              metadata: {
                resourceVersion: currentResourceVersion
              },
              spec: {
                holderIdentity: currentHolder,
                renewTime: new Date().toISOString(),
                leaseDurationSeconds: 1,
                leaseTransitions: 3
              }
            },
            text: "{}"
          };
        }
      }
    );

    elector.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const snapshot = elector.snapshot();
    await elector.close();

    expect(snapshot.leader).toBe(true);
    expect(snapshot.observedHolderIdentity).toBe("controller-a");
    expect(gained.length).toBeGreaterThan(0);
    expect(lost).toHaveLength(1);
    expect(requests.some((request) => request.method === "PATCH")).toBe(true);
  });

  it("blocks kubernetes scale-down when policy disables it", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-controller-target-"));
    tempDirs.push(tempDir);
    const tokenFile = path.join(tempDir, "token");
    await writeFile(tokenFile, "test-token", "utf8");

    const requests: Array<{ method: string; url: string; body?: string | undefined }> = [];
    const target = createKubernetesWorkerReplicaTarget(
      {
        type: "kubernetes",
        allowScaleDown: false,
        kubernetes: {
          namespace: "open-agent-harness",
          deployment: "oah-worker",
          apiUrl: "https://kubernetes.default.svc",
          tokenFile,
          caFile: undefined,
          skipTlsVerify: true
        }
      },
      {
        request: async (request) => {
          requests.push({
            method: request.method,
            url: request.url,
            body: request.body
          });
          if (request.method === "GET") {
            return {
              status: 200,
              body: {
                spec: {
                  replicas: 3
                }
              },
              text: "{\"spec\":{\"replicas\":3}}"
            };
          }

          throw new Error("PATCH should not be called when scale-down is blocked.");
        }
      }
    );

    const result = await target.reconcile({
      timestamp: "2026-04-15T00:00:00.000Z",
      reason: "scale_down",
      desiredReplicas: 1,
      suggestedReplicas: 1,
      activeReplicas: 3,
      activeSlots: 3,
      busySlots: 0
    });

    expect(result).toEqual({
      kind: "kubernetes",
      attempted: true,
      applied: false,
      desiredReplicas: 1,
      observedReplicas: 3,
      appliedReplicas: 3,
      outcome: "blocked_scale_down",
      at: "2026-04-15T00:00:00.000Z",
      message: "scale down blocked by controller policy"
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url).toContain("/apis/apps/v1/namespaces/open-agent-harness/deployments/oah-worker/scale");
  });

  it("patches kubernetes deployment scale when desired replicas change", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-controller-target-"));
    tempDirs.push(tempDir);
    const tokenFile = path.join(tempDir, "token");
    await writeFile(tokenFile, "test-token", "utf8");

    const requests: Array<{ method: string; headers: Record<string, string>; body?: string | undefined }> = [];
    const target = createKubernetesWorkerReplicaTarget(
      {
        type: "kubernetes",
        allowScaleDown: true,
        kubernetes: {
          namespace: "open-agent-harness",
          deployment: "oah-worker",
          apiUrl: "https://kubernetes.default.svc",
          tokenFile,
          caFile: undefined,
          skipTlsVerify: true
        }
      },
      {
        request: async (request) => {
          requests.push({
            method: request.method,
            headers: request.headers,
            body: request.body
          });
          if (request.method === "GET") {
            return {
              status: 200,
              body: {
                spec: {
                  replicas: 2
                }
              },
              text: "{\"spec\":{\"replicas\":2}}"
            };
          }

          return {
            status: 200,
            body: {
              spec: {
                replicas: 4
              }
            },
            text: "{\"spec\":{\"replicas\":4}}"
          };
        }
      }
    );

    const result = await target.reconcile({
      timestamp: "2026-04-15T00:00:00.000Z",
      reason: "scale_up",
      desiredReplicas: 4,
      suggestedReplicas: 4,
      activeReplicas: 2,
      activeSlots: 2,
      busySlots: 2
    });

    expect(result).toEqual({
      kind: "kubernetes",
      attempted: true,
      applied: true,
      desiredReplicas: 4,
      observedReplicas: 2,
      appliedReplicas: 4,
      outcome: "scaled",
      at: "2026-04-15T00:00:00.000Z"
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[1]?.method).toBe("PATCH");
    expect(requests[1]?.headers.authorization).toBe("Bearer test-token");
    expect(requests[1]?.headers["content-type"]).toBe("application/merge-patch+json");
    expect(requests[1]?.body).toBe(JSON.stringify({ spec: { replicas: 4 } }));
  });

  it("discovers the target deployment by label selector before scaling", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-controller-target-discovery-"));
    tempDirs.push(tempDir);
    const tokenFile = path.join(tempDir, "token");
    await writeFile(tokenFile, "test-token", "utf8");

    const requests: Array<{ method: string; url: string; body?: string | undefined }> = [];
    const target = createKubernetesWorkerReplicaTarget(
      {
        type: "kubernetes",
        allowScaleDown: true,
        kubernetes: {
          namespace: "open-agent-harness",
          labelSelector: "app.kubernetes.io/component=worker",
          apiUrl: "https://kubernetes.default.svc",
          tokenFile,
          caFile: undefined,
          skipTlsVerify: true
        }
      },
      {
        request: async (request) => {
          requests.push({
            method: request.method,
            url: request.url,
            body: request.body
          });
          if (request.method === "GET" && request.url.includes("/deployments?")) {
            return {
              status: 200,
              body: {
                items: [
                  {
                    metadata: {
                      name: "oah-worker"
                    }
                  }
                ]
              },
              text: "{\"items\":[{\"metadata\":{\"name\":\"oah-worker\"}}]}"
            };
          }
          if (request.method === "GET") {
            return {
              status: 200,
              body: {
                spec: {
                  replicas: 2
                }
              },
              text: "{\"spec\":{\"replicas\":2}}"
            };
          }

          return {
            status: 200,
            body: {
              spec: {
                replicas: 3
              }
            },
            text: "{\"spec\":{\"replicas\":3}}"
          };
        }
      }
    );

    const result = await target.reconcile({
      timestamp: "2026-04-15T00:00:00.000Z",
      reason: "scale_up",
      desiredReplicas: 3,
      suggestedReplicas: 3,
      activeReplicas: 2,
      activeSlots: 2,
      busySlots: 2
    });

    expect(result).toMatchObject({
      kind: "kubernetes",
      desiredReplicas: 3,
      observedReplicas: 2,
      appliedReplicas: 3,
      outcome: "scaled"
    });
    expect(requests[0]?.url).toContain("/deployments?labelSelector=app.kubernetes.io%2Fcomponent%3Dworker");
    expect(requests[1]?.url).toContain("/deployments/oah-worker/scale");
    expect(requests[2]?.url).toContain("/deployments/oah-worker/scale");
  });

  it("renders controller metrics and serves observability endpoints", async () => {
    const metrics = renderControllerMetrics({
      leaderElection: {
        running: true,
        kind: "kubernetes",
        leader: true,
        identity: "controller-a"
      },
      controller: {
        running: true,
        minReplicas: 1,
        maxReplicas: 6,
        slotsPerPod: 2,
        suggestedReplicas: 3,
        desiredReplicas: 2,
        suggestedWorkers: 4,
        activeReplicas: 2,
        busyReplicas: 1,
        activeSlots: 4,
        busySlots: 1,
        idleSlots: 3,
        readySessionsPerWorker: 1,
        reservedSubagentCapacity: 1,
        readySessionCount: 2,
        subagentReadySessionCount: 1,
        scaleUpPressureStreak: 1,
        scaleDownPressureStreak: 0,
        scaleUpCooldownRemainingMs: 0,
        scaleDownCooldownRemainingMs: 2500,
        placement: {
          totalWorkspaces: 3,
          assignedUsers: 2,
          unassignedUsers: 1,
          ownedWorkspaces: 3,
          workersWithPlacements: 2,
          ownedByActiveWorkers: 2,
          ownedByLateWorkers: 1,
          ownedByMissingWorkers: 0,
          workersWithLatePlacements: 1,
          workersWithMissingPlacements: 0,
          active: 2,
          idle: 1,
          draining: 0,
          evicted: 0,
          unassigned: 0
        },
        placementPolicy: {
          attentionRequired: true,
          unassignedWorkspaces: 0,
          missingOwnerWorkspaces: 0,
          lateOwnerWorkspaces: 1,
          drainingOwnerWorkspaces: 0,
          usersSpanningWorkers: 1,
          maxWorkersPerUser: 2,
          workersAboveSoftCapacity: 1,
          maxRefCountPerWorker: 3
        },
        placementRecommendations: [
          {
            kind: "reassign_late_owner",
            priority: "high",
            workspaceCount: 1,
            workerCount: 1,
            sampleWorkspaceIds: ["ws_2"],
            sampleWorkerIds: ["worker_late"],
            message: "stabilize or reassign 1 workspace(s) currently attached to late owners"
          },
          {
            kind: "consolidate_user_affinity",
            priority: "medium",
            workspaceCount: 0,
            userCount: 1,
            sampleUserIds: ["user_1"],
            message: "consider consolidating 1 user affinity group(s) that currently span multiple workers"
          },
          {
            kind: "rebalance_soft_capacity",
            priority: "medium",
            workspaceCount: 0,
            workerCount: 1,
            sampleWorkerIds: ["worker_1"],
            message: "rebalance placements away from 1 worker(s) above the soft slots-per-pod capacity"
          }
        ],
        placementActionPlan: {
          totalItems: 3,
          highPriorityItems: 1,
          nextItem: {
            id: "reassign_late_owner:1",
            phase: "stabilize",
            kind: "reassign_late_owner",
            priority: "high",
            blockers: ["owner_late"],
            workspaceIds: ["ws_2"],
            workerIds: ["worker_late"],
            summary: "stabilize or reassign 1 workspace(s) currently attached to late owners"
          },
          items: [
            {
              id: "reassign_late_owner:1",
              phase: "stabilize",
              kind: "reassign_late_owner",
              priority: "high",
              blockers: ["owner_late"],
              workspaceIds: ["ws_2"],
              workerIds: ["worker_late"],
              summary: "stabilize or reassign 1 workspace(s) currently attached to late owners"
            },
            {
              id: "consolidate_user_affinity:2",
              phase: "optimize",
              kind: "consolidate_user_affinity",
              priority: "medium",
              blockers: ["user_affinity_split"],
              userIds: ["user_1"],
              summary: "consider consolidating 1 user affinity group(s) that currently span multiple workers"
            },
            {
              id: "rebalance_soft_capacity:3",
              phase: "optimize",
              kind: "rebalance_soft_capacity",
              priority: "medium",
              blockers: ["soft_capacity_exceeded"],
              workerIds: ["worker_1"],
              summary: "rebalance placements away from 1 worker(s) above the soft slots-per-pod capacity"
            }
          ]
        },
        placementExecution: {
          attempted: 2,
          applied: 1,
          skipped: 1,
          failed: 0,
          operations: [
            {
              id: "reassign_late_owner:ws_2",
              kind: "reassign_late_owner",
              workspaceId: "ws_2",
              ownerWorkerId: "worker_late",
              state: "active",
              action: "release_ownership",
              reason: "owner_late",
              status: "skipped",
              message: "workspace is still active on a late owner; defer handoff until it becomes idle or draining"
            },
            {
              id: "finish_draining_owner:ws_3",
              kind: "finish_draining_owner",
              workspaceId: "ws_3",
              ownerWorkerId: "worker_3",
              state: "draining",
              action: "release_ownership",
              reason: "worker_draining",
              status: "applied",
              message: "workspace ownership was released for controller-driven reassignment"
            }
          ]
        },
        scaleDownGate: {
          allowed: false,
          checkedReplicas: 2,
          blockedReplicas: 1,
          blockers: [],
          evaluatedAt: "2026-04-15T00:00:00.000Z"
        },
        recentDecisions: []
      }
    });

    expect(metrics).toContain("oah_controller_leader 1");
    expect(metrics).toContain("oah_controller_scale_down_allowed 0");
    expect(metrics).toContain("oah_controller_scale_down_blocked_replicas 1");
    expect(metrics).toContain("oah_controller_placement_owned_by_active_workers 2");
    expect(metrics).toContain("oah_controller_placement_owned_by_late_workers 1");
    expect(metrics).toContain("oah_controller_placement_policy_attention_required 1");
    expect(metrics).toContain("oah_controller_placement_policy_users_spanning_workers 1");
    expect(metrics).toContain("oah_controller_placement_recommendations_total 3");
    expect(metrics).toContain("oah_controller_placement_recommendations_high_priority 1");
    expect(metrics).toContain("oah_controller_placement_action_items_total 3");
    expect(metrics).toContain("oah_controller_placement_action_items_high_priority 1");
    expect(metrics).toContain("oah_controller_placement_execution_attempted 2");
    expect(metrics).toContain("oah_controller_placement_execution_applied 1");
    expect(metrics).toContain("oah_controller_placement_execution_skipped 1");
    expect(metrics).toContain("oah_controller_placement_execution_failed 0");

    const server = createControllerObservabilityServer({
      config: {
        host: "127.0.0.1",
        port: 0
      },
      getLeaderElection: () => ({
        running: true,
        kind: "kubernetes",
        leader: false,
        identity: "controller-b"
      }),
      getController: () => ({
        running: false,
        minReplicas: 1,
        maxReplicas: 6,
        slotsPerPod: 1,
        suggestedReplicas: 1,
        desiredReplicas: 1,
        suggestedWorkers: 1,
        activeReplicas: 1,
        busyReplicas: 0,
        activeSlots: 1,
        busySlots: 0,
        idleSlots: 1,
        readySessionsPerWorker: 1,
        reservedSubagentCapacity: 0,
        scaleUpPressureStreak: 0,
        scaleDownPressureStreak: 0,
        scaleUpCooldownRemainingMs: 0,
        scaleDownCooldownRemainingMs: 0,
        recentDecisions: []
      })
    });

    await server.start();
    const address = server.address();
    expect(address).not.toBeNull();
    const baseUrl = `http://127.0.0.1:${address!.port}`;

    const [healthResponse, readyResponse, snapshotResponse, metricsResponse] = await Promise.all([
      fetch(`${baseUrl}/healthz`),
      fetch(`${baseUrl}/readyz`),
      fetch(`${baseUrl}/snapshot`),
      fetch(`${baseUrl}/metrics`)
    ]);

    await expect(healthResponse.json()).resolves.toMatchObject({
      status: "ok",
      leaderElection: {
        leader: false
      },
      controller: {
        desiredReplicas: 1
      }
    });
    await expect(readyResponse.json()).resolves.toEqual({
      status: "ready",
      leader: false,
      running: false
    });
    await expect(snapshotResponse.json()).resolves.toMatchObject({
      leaderElection: {
        identity: "controller-b"
      },
      controller: {
        activeReplicas: 1
      }
    });
    await expect(metricsResponse.text()).resolves.toContain("oah_controller_running 0");

    await server.close();
  });
});
