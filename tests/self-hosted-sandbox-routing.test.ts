import { describe, expect, it } from "vitest";

import { resolveSelfHostedSandboxCreateBaseUrl } from "../apps/server/src/bootstrap/self-hosted-sandbox-routing.ts";

describe("self-hosted sandbox routing", () => {
  it("reuses the existing sandbox endpoint for the same owner", async () => {
    const baseUrl = "http://oah-sandbox:8787/internal/v1";
    const resolved = await resolveSelfHostedSandboxCreateBaseUrl({
      baseUrl,
      workspace: {
        ownerId: "owner-a"
      },
      workspacePlacementRegistry: {
        async assignOwnerAffinity() {
          return undefined;
        },
        async listAll() {
          return [
            {
              workspaceId: "ws-existing",
              version: "live",
              ownerId: "owner-a",
              ownerBaseUrl: "http://sandbox-b:8787",
              state: "idle",
              updatedAt: "2026-04-19T15:10:00.000Z"
            }
          ];
        }
      },
      resolveHostAddresses: async (hostname) => {
        switch (hostname) {
          case "oah-sandbox":
            return ["10.0.0.1", "10.0.0.2"];
          case "sandbox-b":
            return ["10.0.0.2"];
          default:
            return [hostname];
        }
      }
    });

    expect(resolved).toBe("http://sandbox-b:8787/internal/v1");
  });

  it("prefers an unused replica for a new owner when multiple endpoints are available", async () => {
    const baseUrl = "http://oah-sandbox:8787/internal/v1";
    const resolved = await resolveSelfHostedSandboxCreateBaseUrl({
      baseUrl,
      workspace: {
        ownerId: "owner-new"
      },
      workspacePlacementRegistry: {
        async listAll() {
          return [
            {
              workspaceId: "ws-owner-a",
              version: "live",
              ownerId: "owner-a",
              ownerBaseUrl: "http://sandbox-a:8787",
              state: "idle",
              updatedAt: "2026-04-19T15:10:00.000Z"
            }
          ];
        }
      },
      resolveHostAddresses: async (hostname) => {
        switch (hostname) {
          case "oah-sandbox":
            return ["10.0.0.1", "10.0.0.2", "10.0.0.3"];
          case "sandbox-a":
            return ["10.0.0.1"];
          default:
            return [hostname];
        }
      }
    });

    expect(["http://10.0.0.2:8787/internal/v1", "http://10.0.0.3:8787/internal/v1"]).toContain(resolved);
  });

  it("falls back to the shared base url when only one endpoint is available", async () => {
    const resolved = await resolveSelfHostedSandboxCreateBaseUrl({
      baseUrl: "http://oah-sandbox:8787/internal/v1",
      workspace: {
        ownerId: "owner-only"
      },
      workspacePlacementRegistry: {
        async listAll() {
          return [];
        }
      },
      resolveHostAddresses: async () => ["10.0.0.1"]
    });

    expect(resolved).toBeUndefined();
  });

  it("waits for a new active worker replica so a new owner can get a dedicated sandbox", async () => {
    let pollCount = 0;
    const assignedOwners: Array<{ workspaceId: string; ownerId: string }> = [];

    const resolved = await resolveSelfHostedSandboxCreateBaseUrl({
      baseUrl: "http://oah-sandbox:8787/internal/v1",
      workspace: {
        id: "ws-owner-b-pending",
        ownerId: "owner-b"
      },
      workspacePlacementRegistry: {
        async assignOwnerAffinity(workspaceId, ownerId) {
          assignedOwners.push({ workspaceId, ownerId });
        },
        async listAll() {
          return [
            {
              workspaceId: "ws-owner-a",
              version: "live",
              ownerId: "owner-a",
              ownerBaseUrl: "http://sandbox-a:8787",
              state: "idle",
              updatedAt: "2026-04-19T15:10:00.000Z"
            },
            {
              workspaceId: "ws-owner-b-pending",
              version: "live",
              ownerId: "owner-b",
              state: "unassigned",
              updatedAt: "2026-04-19T15:11:00.000Z"
            }
          ];
        }
      },
      workerRegistry: {
        async listActive() {
          pollCount += 1;
          if (pollCount === 1) {
            return [
              {
                workerId: "worker-a-1",
                runtimeInstanceId: "worker:sandbox-a",
                ownerBaseUrl: "http://sandbox-a:8787",
                processKind: "standalone",
                state: "idle",
                lastSeenAt: "2026-04-19T15:11:00.000Z",
                leaseTtlMs: 60_000,
                expiresAt: "2026-04-19T15:12:00.000Z",
                lastSeenAgeMs: 0,
                health: "healthy"
              }
            ];
          }

          return [
            {
              workerId: "worker-a-1",
              runtimeInstanceId: "worker:sandbox-a",
              ownerBaseUrl: "http://sandbox-a:8787",
              processKind: "standalone",
              state: "idle",
              lastSeenAt: "2026-04-19T15:11:00.000Z",
              leaseTtlMs: 60_000,
              expiresAt: "2026-04-19T15:12:00.000Z",
              lastSeenAgeMs: 0,
              health: "healthy"
            },
            {
              workerId: "worker-b-1",
              runtimeInstanceId: "worker:sandbox-b",
              ownerBaseUrl: "http://sandbox-b:8787",
              processKind: "standalone",
              state: "idle",
              lastSeenAt: "2026-04-19T15:11:01.000Z",
              leaseTtlMs: 60_000,
              expiresAt: "2026-04-19T15:12:01.000Z",
              lastSeenAgeMs: 0,
              health: "healthy"
            }
          ];
        }
      },
      resolveHostAddresses: async (hostname) => {
        switch (hostname) {
          case "sandbox-a":
            return ["10.0.0.1"];
          case "sandbox-b":
            return ["10.0.0.2"];
          default:
            return [hostname];
        }
      },
      waitForAvailableReplicaMs: 50,
      pollIntervalMs: 1,
      sleepFn: async () => undefined
    });

    expect(pollCount).toBeGreaterThan(1);
    expect(assignedOwners).toEqual([{ workspaceId: "ws-owner-b-pending", ownerId: "owner-b" }]);
    expect(resolved).toBe("http://sandbox-b:8787/internal/v1");
  });

  it("assigns different pending owners to different replicas before ownership is materialized", async () => {
    let pollCount = 0;

    const resolved = await resolveSelfHostedSandboxCreateBaseUrl({
      baseUrl: "http://oah-sandbox:8787/internal/v1",
      workspace: {
        id: "ws-owner-b-pending",
        ownerId: "owner-b"
      },
      workspacePlacementRegistry: {
        async assignOwnerAffinity() {
          return undefined;
        },
        async listAll() {
          return [
            {
              workspaceId: "ws-owner-a-pending",
              version: "live",
              ownerId: "owner-a",
              state: "unassigned",
              updatedAt: "2026-04-19T15:10:00.000Z"
            },
            {
              workspaceId: "ws-owner-b-pending",
              version: "live",
              ownerId: "owner-b",
              state: "unassigned",
              updatedAt: "2026-04-19T15:11:00.000Z"
            }
          ];
        }
      },
      workerRegistry: {
        async listActive() {
          pollCount += 1;
          if (pollCount === 1) {
            return [
              {
                workerId: "worker-a-1",
                runtimeInstanceId: "worker:sandbox-a",
                ownerBaseUrl: "http://sandbox-a:8787",
                processKind: "standalone",
                state: "idle",
                lastSeenAt: "2026-04-19T15:11:00.000Z",
                leaseTtlMs: 60_000,
                expiresAt: "2026-04-19T15:12:00.000Z",
                lastSeenAgeMs: 0,
                health: "healthy"
              }
            ];
          }

          return [
            {
              workerId: "worker-a-1",
              runtimeInstanceId: "worker:sandbox-a",
              ownerBaseUrl: "http://sandbox-a:8787",
              processKind: "standalone",
              state: "idle",
              lastSeenAt: "2026-04-19T15:11:00.000Z",
              leaseTtlMs: 60_000,
              expiresAt: "2026-04-19T15:12:00.000Z",
              lastSeenAgeMs: 0,
              health: "healthy"
            },
            {
              workerId: "worker-b-1",
              runtimeInstanceId: "worker:sandbox-b",
              ownerBaseUrl: "http://sandbox-b:8787",
              processKind: "standalone",
              state: "idle",
              lastSeenAt: "2026-04-19T15:11:01.000Z",
              leaseTtlMs: 60_000,
              expiresAt: "2026-04-19T15:12:01.000Z",
              lastSeenAgeMs: 0,
              health: "healthy"
            }
          ];
        }
      },
      resolveHostAddresses: async (hostname) => {
        switch (hostname) {
          case "sandbox-a":
            return ["10.0.0.1"];
          case "sandbox-b":
            return ["10.0.0.2"];
          default:
            return [hostname];
        }
      },
      waitForAvailableReplicaMs: 50,
      pollIntervalMs: 1,
      sleepFn: async () => undefined
    });

    expect(pollCount).toBeGreaterThan(1);
    expect(resolved).toBe("http://sandbox-b:8787/internal/v1");
  });
});
