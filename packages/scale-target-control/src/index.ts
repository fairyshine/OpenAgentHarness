import {
  createDockerComposeWorkerReplicaTarget,
  createRemoteDockerComposeWorkerReplicaTarget
} from "./docker-compose-target.js";
import { createKubernetesWorkerReplicaTarget } from "./kubernetes-target.js";
import type {
  DockerComposeCommandFn,
  JsonHttpRequestFn,
  KubernetesJsonRequestFn,
  ResolvedWorkerReplicaTargetConfig,
  WorkerReplicaTarget
} from "./types.js";

export { resolveWorkerReplicaTargetConfig } from "./config.js";
export {
  createDockerComposeWorkerReplicaTarget,
  createRemoteDockerComposeWorkerReplicaTarget,
  defaultDockerComposeCommand
} from "./docker-compose-target.js";
export { defaultJsonHttpRequest } from "./http.js";
export { createKubernetesWorkerReplicaTarget, defaultKubernetesJsonRequest } from "./kubernetes-target.js";
export type {
  DockerComposeCommandFn,
  DockerComposeCommandInput,
  DockerComposeCommandResult,
  DockerComposeRemoteReconcileRequest,
  JsonHttpRequest,
  JsonHttpRequestFn,
  KubernetesJsonRequest,
  KubernetesJsonRequestFn,
  ResolvedWorkerReplicaTargetConfig,
  WorkerReplicaTarget,
  WorkerReplicaTargetInput,
  WorkerReplicaTargetOutcome,
  WorkerReplicaTargetPhase,
  WorkerReplicaTargetRef,
  WorkerReplicaTargetResult
} from "./types.js";

export function createWorkerReplicaTarget(
  config: ResolvedWorkerReplicaTargetConfig,
  options?: {
    request?: KubernetesJsonRequestFn | undefined;
    command?: DockerComposeCommandFn | undefined;
    httpRequest?: JsonHttpRequestFn | undefined;
  }
): WorkerReplicaTarget {
  if (config.type === "kubernetes") {
    return createKubernetesWorkerReplicaTarget(config, options);
  }

  if (config.type === "docker_compose") {
    if (config.dockerCompose.remote) {
      return createRemoteDockerComposeWorkerReplicaTarget(config, options);
    }

    return createDockerComposeWorkerReplicaTarget(config, options);
  }

  return createNoopWorkerReplicaTarget(config);
}

export function createNoopWorkerReplicaTarget(config: { allowScaleDown: boolean }): WorkerReplicaTarget {
  void config;
  return {
    kind: "noop",
    async reconcile(input) {
      return {
        kind: "noop",
        attempted: false,
        applied: false,
        desiredReplicas: input.desiredReplicas,
        outcome: "disabled",
        at: input.timestamp,
        phase: "disabled",
        targetRef: {
          platform: "noop"
        },
        message: "scale target disabled"
      };
    }
  };
}
