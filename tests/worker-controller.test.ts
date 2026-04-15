import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RedisWorkerRegistryEntry } from "@oah/storage-redis";

import {
  createWorkerControllerLeaderElector,
  resolveWorkerControllerLeaderElectionConfig
} from "../apps/worker-controller/src/leader-election.ts";
import {
  calculateStandaloneWorkerReplicas,
  RedisWorkerController,
  resolveStandaloneWorkerControllerConfig,
  summarizeStandaloneWorkerFleet
} from "../apps/worker-controller/src/controller.ts";
import {
  createKubernetesWorkerReplicaTarget,
  resolveWorkerReplicaTargetConfig
} from "../apps/worker-controller/src/scale-target.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("worker controller", () => {
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

  it("resolves controller config from standalone/controller settings", () => {
    const config = resolveStandaloneWorkerControllerConfig({
      server: { host: "127.0.0.1", port: 8787 },
      storage: { redis_url: "redis://local/0" },
      paths: {
        workspace_dir: "/tmp/workspaces",
        chat_dir: "/tmp/chat",
        template_dir: "/tmp/templates",
        model_dir: "/tmp/models",
        tool_dir: "/tmp/tools",
        skill_dir: "/tmp/skills",
        archive_dir: "/tmp/archives"
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

    const controller = new RedisWorkerController({
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
      }
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
    const controller = new RedisWorkerController({
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

  it("resolves kubernetes scale target settings", () => {
    const target = resolveWorkerReplicaTargetConfig({
      server: { host: "127.0.0.1", port: 8787 },
      storage: { redis_url: "redis://local/0" },
      paths: {
        workspace_dir: "/tmp/workspaces",
        chat_dir: "/tmp/chat",
        template_dir: "/tmp/templates",
        model_dir: "/tmp/models",
        tool_dir: "/tmp/tools",
        skill_dir: "/tmp/skills",
        archive_dir: "/tmp/archives"
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

  it("resolves kubernetes leader election settings", () => {
    const leaderElection = resolveWorkerControllerLeaderElectionConfig({
      server: { host: "127.0.0.1", port: 8787 },
      storage: { redis_url: "redis://local/0" },
      paths: {
        workspace_dir: "/tmp/workspaces",
        chat_dir: "/tmp/chat",
        template_dir: "/tmp/templates",
        model_dir: "/tmp/models",
        tool_dir: "/tmp/tools",
        skill_dir: "/tmp/skills",
        archive_dir: "/tmp/archives"
      },
      workers: {
        controller: {
          leader_election: {
            type: "kubernetes",
            kubernetes: {
              namespace: "open-agent-harness",
              lease_name: "oah-worker-controller",
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
      leaseName: "oah-worker-controller",
      apiUrl: "https://kubernetes.default.svc",
      tokenFile: "/var/run/secrets/kubernetes.io/serviceaccount/token",
      caFile: "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
      skipTlsVerify: false,
      leaseDurationMs: 15000,
      renewIntervalMs: 5000,
      retryIntervalMs: 2000
    });
  });

  it("acquires and renews kubernetes leadership lease", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-worker-controller-lease-"));
    tempDirs.push(tempDir);
    const tokenFile = path.join(tempDir, "token");
    await writeFile(tokenFile, "test-token", "utf8");

    let getCount = 0;
    let currentHolder = "other-controller";
    let currentResourceVersion = "12";
    const gained: string[] = [];
    const lost: string[] = [];
    const requests: Array<{ method: string; body?: string | undefined }> = [];

    const elector = createWorkerControllerLeaderElector(
      {
        type: "kubernetes",
        identity: "controller-a",
        namespace: "open-agent-harness",
        leaseName: "oah-worker-controller",
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
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-worker-controller-target-"));
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
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-worker-controller-target-"));
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
});
