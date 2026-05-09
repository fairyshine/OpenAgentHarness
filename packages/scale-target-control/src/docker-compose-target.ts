import { spawn } from "node:child_process";
import path from "node:path";

import { appendTrailingSlash, assertHttpSuccess, defaultJsonHttpRequest } from "./http.js";
import type {
  DockerComposeCommandFn,
  DockerComposeCommandInput,
  DockerComposeCommandResult,
  DockerComposeManagedContainer,
  DockerComposeRemoteReconcileRequest,
  JsonHttpRequestFn,
  ResolvedWorkerReplicaTargetConfig,
  WorkerReplicaTarget,
  WorkerReplicaTargetResult
} from "./types.js";

export async function defaultDockerComposeCommand(input: DockerComposeCommandInput): Promise<DockerComposeCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.args[0]!, input.args.slice(1), {
      cwd: input.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      reject(error);
    });
    child.once("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}

function composeTargetCwd(config: Extract<ResolvedWorkerReplicaTargetConfig, { type: "docker_compose" }>): string | undefined {
  return config.dockerCompose.composeFile ? path.dirname(config.dockerCompose.composeFile) : undefined;
}

function composeArgs(
  config: Extract<ResolvedWorkerReplicaTargetConfig, { type: "docker_compose" }>,
  args: string[]
): string[] {
  return [
    config.dockerCompose.command,
    "compose",
    ...(config.dockerCompose.composeFile ? ["-f", config.dockerCompose.composeFile] : []),
    "-p",
    config.dockerCompose.projectName,
    ...args
  ];
}

async function listManagedDockerComposeContainers(
  config: Extract<ResolvedWorkerReplicaTargetConfig, { type: "docker_compose" }>,
  commandRunner: DockerComposeCommandFn
): Promise<DockerComposeManagedContainer[]> {
  const cwd = composeTargetCwd(config);
  const listResult = await commandRunner({
    args: composeArgs(config, ["ps", "-a", "-q", config.dockerCompose.service]),
    ...(cwd ? { cwd } : {})
  });
  if (listResult.code !== 0) {
    throw new Error(listResult.stderr.trim() || listResult.stdout.trim() || "failed to list docker compose containers");
  }

  const ids = listResult.stdout
    .split(/\s+/u)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (ids.length === 0) {
    return [];
  }

  const inspectResult = await commandRunner({
    args: [config.dockerCompose.command, "inspect", ...ids],
    ...(cwd ? { cwd } : {})
  });
  if (inspectResult.code !== 0) {
    throw new Error(inspectResult.stderr.trim() || inspectResult.stdout.trim() || "failed to inspect docker compose containers");
  }

  const inspected = JSON.parse(inspectResult.stdout) as Array<{
    Id: string;
    Name?: string | undefined;
    State?: {
      Running?: boolean | undefined;
    } | undefined;
  }>;

  return inspected
    .map((entry) => ({
      id: entry.Id,
      name: entry.Name?.replace(/^\/+/u, "") ?? entry.Id,
      running: entry.State?.Running === true
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function createDockerComposeWorkerReplicaTarget(
  config: Extract<ResolvedWorkerReplicaTargetConfig, { type: "docker_compose" }>,
  options?: {
    command?: DockerComposeCommandFn | undefined;
  }
): WorkerReplicaTarget {
  const commandRunner = options?.command ?? defaultDockerComposeCommand;

  return {
    kind: "docker_compose",
    async reconcile(input) {
      const containers = await listManagedDockerComposeContainers(config, commandRunner);
      const runningContainers = containers.filter((container) => container.running);

      if (!config.allowScaleDown && input.desiredReplicas < runningContainers.length) {
        return {
          kind: "docker_compose",
          attempted: true,
          applied: false,
          desiredReplicas: input.desiredReplicas,
          observedReplicas: runningContainers.length,
          appliedReplicas: runningContainers.length,
          outcome: "blocked_scale_down",
          at: input.timestamp,
          phase: "blocked",
          reasonCode: "scale_down_disabled",
          targetRef: {
            platform: "docker_compose",
            kind: "service",
            name: config.dockerCompose.service
          },
          message: "scale down blocked by controller policy"
        };
      }

      if (input.desiredReplicas === runningContainers.length) {
        return {
          kind: "docker_compose",
          attempted: true,
          applied: false,
          desiredReplicas: input.desiredReplicas,
          observedReplicas: runningContainers.length,
          appliedReplicas: runningContainers.length,
          outcome: "steady",
          at: input.timestamp,
          phase: "steady",
          targetRef: {
            platform: "docker_compose",
            kind: "service",
            name: config.dockerCompose.service
          }
        };
      }

      const cwd = composeTargetCwd(config);
      const result = await commandRunner({
        args: composeArgs(config, [
          "up",
          "-d",
          "--no-deps",
          "--scale",
          `${config.dockerCompose.service}=${input.desiredReplicas}`,
          config.dockerCompose.service
        ]),
        ...(cwd ? { cwd } : {})
      });

      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || result.stdout.trim() || "docker compose reconcile failed");
      }

      return {
        kind: "docker_compose",
        attempted: true,
        applied: true,
        desiredReplicas: input.desiredReplicas,
        observedReplicas: runningContainers.length,
        appliedReplicas: input.desiredReplicas,
        outcome: "scaled",
        at: input.timestamp,
        phase: "accepted",
        reasonCode: "scale_request_accepted",
        targetRef: {
          platform: "docker_compose",
          kind: "service",
          name: config.dockerCompose.service
        },
        ...(result.stdout.trim() ? { message: result.stdout.trim() } : {})
      };
    }
  };
}

export function createRemoteDockerComposeWorkerReplicaTarget(
  config: Extract<ResolvedWorkerReplicaTargetConfig, { type: "docker_compose" }>,
  options?: {
    httpRequest?: JsonHttpRequestFn | undefined;
  }
): WorkerReplicaTarget {
  const remote = config.dockerCompose.remote;
  if (!remote) {
    throw new Error("remote docker compose scale target requires endpoint.");
  }

  const httpRequest = options?.httpRequest ?? defaultJsonHttpRequest;

  return {
    kind: "docker_compose",
    async reconcile(input) {
      const url = new URL("/reconcile", appendTrailingSlash(remote.endpoint)).toString();
      const response = await httpRequest({
        url,
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(remote.authToken ? { authorization: `Bearer ${remote.authToken}` } : {})
        },
        body: JSON.stringify({
          input,
          allowScaleDown: config.allowScaleDown
        } satisfies DockerComposeRemoteReconcileRequest),
        timeoutMs: remote.timeoutMs
      });
      assertHttpSuccess("docker compose remote reconcile", response);

      if (!response.body || typeof response.body !== "object") {
        throw new Error("docker compose remote reconcile returned an invalid JSON body.");
      }

      return response.body as WorkerReplicaTargetResult;
    }
  };
}
