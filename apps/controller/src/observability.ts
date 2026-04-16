import * as http from "node:http";
import type { AddressInfo } from "node:net";

import type { ControllerLeaderElectionStatus } from "./leader-election.js";
import type { ControllerSnapshot } from "./controller.js";

export interface ControllerObservabilityConfig {
  host: string;
  port: number;
}

export interface ControllerObservabilityServer {
  start(): Promise<void>;
  close(): Promise<void>;
  address(): AddressInfo | null;
}

function readEnv(names: string | string[]): string | undefined {
  for (const name of Array.isArray(names) ? names : [names]) {
    const raw = process.env[name];
    if (raw && raw.trim().length > 0) {
      return raw.trim();
    }
  }

  return undefined;
}

function readStringEnv(names: string | string[], fallback: string): string {
  return readEnv(names) ?? fallback;
}

function readPositiveIntEnv(names: string | string[], fallback: number): number {
  const raw = readEnv(names);
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function renderMetricFamily(name: string, help: string, value: number): string[] {
  return [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${value}`];
}

export function resolveControllerObservabilityConfig(): ControllerObservabilityConfig {
  return {
    host: readStringEnv("OAH_CONTROLLER_HOST", "0.0.0.0"),
    port: readPositiveIntEnv("OAH_CONTROLLER_PORT", 8788)
  };
}

export function renderControllerMetrics(input: {
  leaderElection: ControllerLeaderElectionStatus;
  controller: ControllerSnapshot;
}): string {
  const metricFamilies: Array<{ name: string; help: string; value: number }> = [
    { name: "running", help: "Whether the controller reconcile loop is running.", value: input.controller.running ? 1 : 0 },
    { name: "leader", help: "Whether this controller instance currently holds leadership.", value: input.leaderElection.leader ? 1 : 0 },
    { name: "active_replicas", help: "Currently observed active standalone worker replicas.", value: input.controller.activeReplicas },
    { name: "desired_replicas", help: "Desired worker replicas after gating and cooldown.", value: input.controller.desiredReplicas },
    { name: "suggested_replicas", help: "Raw suggested worker replicas before gating and cooldown.", value: input.controller.suggestedReplicas },
    { name: "active_slots", help: "Currently observed active standalone worker slots.", value: input.controller.activeSlots },
    { name: "busy_slots", help: "Currently observed busy standalone worker slots.", value: input.controller.busySlots },
    { name: "scale_up_pressure_streak", help: "Current accumulated scale-up pressure streak.", value: input.controller.scaleUpPressureStreak },
    { name: "scale_down_pressure_streak", help: "Current accumulated scale-down pressure streak.", value: input.controller.scaleDownPressureStreak },
    { name: "scale_up_cooldown_remaining_ms", help: "Remaining scale-up cooldown in milliseconds.", value: input.controller.scaleUpCooldownRemainingMs },
    { name: "scale_down_cooldown_remaining_ms", help: "Remaining scale-down cooldown in milliseconds.", value: input.controller.scaleDownCooldownRemainingMs },
    { name: "scale_down_allowed", help: "Whether scale-down is currently allowed by worker health gating.", value: input.controller.scaleDownGate?.allowed === false ? 0 : 1 },
    { name: "scale_down_blocked_replicas", help: "Number of replicas currently blocking scale-down.", value: input.controller.scaleDownGate?.blockedReplicas ?? 0 },
    { name: "ready_session_count", help: "Number of ready sessions currently waiting in Redis.", value: input.controller.readySessionCount ?? 0 },
    {
      name: "subagent_ready_session_count",
      help: "Number of ready subagent sessions currently waiting in Redis.",
      value: input.controller.subagentReadySessionCount ?? 0
    },
    {
      name: "placement_total_workspaces",
      help: "Number of workspace placement records currently tracked by the controller.",
      value: input.controller.placement?.totalWorkspaces ?? 0
    },
    {
      name: "placement_assigned_users",
      help: "Number of workspace placement records with an assigned user affinity.",
      value: input.controller.placement?.assignedUsers ?? 0
    },
    {
      name: "placement_owned_workspaces",
      help: "Number of workspace placement records currently associated with an owner worker.",
      value: input.controller.placement?.ownedWorkspaces ?? 0
    },
    {
      name: "placement_owned_by_active_workers",
      help: "Number of owned workspace placements whose owner worker is currently healthy.",
      value: input.controller.placement?.ownedByActiveWorkers ?? 0
    },
    {
      name: "placement_owned_by_late_workers",
      help: "Number of owned workspace placements whose owner worker heartbeat is currently late.",
      value: input.controller.placement?.ownedByLateWorkers ?? 0
    },
    {
      name: "placement_owned_by_missing_workers",
      help: "Number of owned workspace placements whose owner worker is currently missing from the registry.",
      value: input.controller.placement?.ownedByMissingWorkers ?? 0
    },
    {
      name: "placement_policy_attention_required",
      help: "Whether placement policy signals currently require controller attention.",
      value: input.controller.placementPolicy?.attentionRequired ? 1 : 0
    },
    {
      name: "placement_policy_unassigned_workspaces",
      help: "Number of unassigned workspaces currently tracked in placement policy signals.",
      value: input.controller.placementPolicy?.unassignedWorkspaces ?? 0
    },
    {
      name: "placement_policy_users_spanning_workers",
      help: "Number of users whose workspaces currently span multiple workers.",
      value: input.controller.placementPolicy?.usersSpanningWorkers ?? 0
    },
    {
      name: "placement_policy_workers_above_soft_capacity",
      help: "Number of workers whose placement ref-load currently exceeds the soft slots-per-pod capacity.",
      value: input.controller.placementPolicy?.workersAboveSoftCapacity ?? 0
    },
    {
      name: "placement_recommendations_total",
      help: "Number of current placement recommendations emitted by the controller.",
      value: input.controller.placementRecommendations?.length ?? 0
    },
    {
      name: "placement_recommendations_high_priority",
      help: "Number of high-priority placement recommendations emitted by the controller.",
      value: input.controller.placementRecommendations?.filter((item) => item.priority === "high").length ?? 0
    },
    {
      name: "placement_action_items_total",
      help: "Number of placement action items currently emitted by the controller.",
      value: input.controller.placementActionPlan?.totalItems ?? 0
    },
    {
      name: "placement_action_items_high_priority",
      help: "Number of high-priority placement action items currently emitted by the controller.",
      value: input.controller.placementActionPlan?.highPriorityItems ?? 0
    },
    {
      name: "placement_execution_attempted",
      help: "Number of placement execution operations attempted by the controller in the latest reconcile.",
      value: input.controller.placementExecution?.attempted ?? 0
    },
    {
      name: "placement_execution_applied",
      help: "Number of placement execution operations applied by the controller in the latest reconcile.",
      value: input.controller.placementExecution?.applied ?? 0
    },
    {
      name: "placement_execution_skipped",
      help: "Number of placement execution operations skipped by the controller in the latest reconcile.",
      value: input.controller.placementExecution?.skipped ?? 0
    },
    {
      name: "placement_execution_failed",
      help: "Number of placement execution operations failed by the controller in the latest reconcile.",
      value: input.controller.placementExecution?.failed ?? 0
    },
    {
      name: "placement_active",
      help: "Number of workspace placement records currently in active state.",
      value: input.controller.placement?.active ?? 0
    },
    {
      name: "placement_idle",
      help: "Number of workspace placement records currently in idle state.",
      value: input.controller.placement?.idle ?? 0
    },
    {
      name: "placement_draining",
      help: "Number of workspace placement records currently in draining state.",
      value: input.controller.placement?.draining ?? 0
    },
    {
      name: "placement_evicted",
      help: "Number of workspace placement records currently in evicted state.",
      value: input.controller.placement?.evicted ?? 0
    }
  ];
  const lines = metricFamilies.flatMap(({ name, help, value }) => renderMetricFamily(`oah_controller_${name}`, help, value));

  return `${lines.join("\n")}\n`;
}

export function createControllerObservabilityServer(options: {
  config: ControllerObservabilityConfig;
  getLeaderElection: () => ControllerLeaderElectionStatus;
  getController: () => ControllerSnapshot;
  logger?: {
    info?(message: string): void;
    warn?(message: string, error?: unknown): void;
  } | undefined;
}): ControllerObservabilityServer {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const payload = {
      leaderElection: options.getLeaderElection(),
      controller: options.getController()
    };

    if (url.pathname === "/healthz") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(
        JSON.stringify({
          status: "ok",
          ...payload
        })
      );
      return;
    }

    if (url.pathname === "/readyz") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(
        JSON.stringify({
          status: "ready",
          leader: payload.leaderElection.leader,
          running: payload.controller.running
        })
      );
      return;
    }

    if (url.pathname === "/snapshot") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(payload));
      return;
    }

    if (url.pathname === "/metrics") {
      response.writeHead(200, {
        "content-type": "text/plain; version=0.0.4; charset=utf-8"
      });
      response.end(renderControllerMetrics(payload));
      return;
    }

    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({
        error: "not_found"
      })
    );
  });

  return {
    async start() {
      if (server.listening) {
        return;
      }

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.config.port, options.config.host, () => {
          server.off("error", reject);
          options.logger?.info?.(
            `[controller] observability server listening on http://${options.config.host}:${options.config.port}`
          );
          resolve();
        });
      });
    },
    async close() {
      if (!server.listening) {
        return;
      }

      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    address() {
      const address = server.address();
      return address && typeof address === "object" ? address : null;
    }
  };
}
