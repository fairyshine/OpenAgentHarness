import * as http from "node:http";

import {
  createDockerComposeWorkerReplicaTarget,
  type DockerComposeRemoteReconcileRequest
} from "@oah/scale-target-control";

interface ComposeScalerConfig {
  host: string;
  port: number;
  authToken?: string | undefined;
  dockerCompose: {
    composeFile?: string | undefined;
    projectName: string;
    service: string;
    command: string;
  };
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

function readStringEnv(names: string | string[], fallback?: string | undefined): string | undefined {
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

function loadConfig(): ComposeScalerConfig {
  const host = readStringEnv("OAH_COMPOSE_SCALER_HOST", "0.0.0.0") ?? "0.0.0.0";
  const port = readPositiveIntEnv("OAH_COMPOSE_SCALER_PORT", 8790);
  const composeFile = readStringEnv("OAH_COMPOSE_SCALER_COMPOSE_FILE");
  const projectName = readStringEnv(["OAH_COMPOSE_SCALER_PROJECT_NAME", "COMPOSE_PROJECT_NAME"]);
  const service = readStringEnv("OAH_COMPOSE_SCALER_SERVICE", "oah-sandbox");
  const command = readStringEnv("OAH_COMPOSE_SCALER_COMMAND", "docker") ?? "docker";
  const authToken = readStringEnv("OAH_COMPOSE_SCALER_AUTH_TOKEN");

  if (!projectName) {
    throw new Error("compose scaler requires OAH_COMPOSE_SCALER_PROJECT_NAME or COMPOSE_PROJECT_NAME.");
  }
  if (!service) {
    throw new Error("compose scaler requires OAH_COMPOSE_SCALER_SERVICE.");
  }

  return {
    host,
    port,
    ...(authToken ? { authToken } : {}),
    dockerCompose: {
      ...(composeFile ? { composeFile } : {}),
      projectName,
      service,
      command
    }
  };
}

function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body).toString()
  });
  response.end(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseReconcileRequest(value: unknown): DockerComposeRemoteReconcileRequest {
  if (!isRecord(value)) {
    throw new Error("reconcile request body must be an object.");
  }

  const input = value.input;
  if (!isRecord(input)) {
    throw new Error("reconcile request is missing input.");
  }

  const timestamp = input.timestamp;
  const reason = input.reason;
  const desiredReplicas = input.desiredReplicas;
  const suggestedReplicas = input.suggestedReplicas;
  const activeReplicas = input.activeReplicas;
  const activeSlots = input.activeSlots;
  const busySlots = input.busySlots;
  const allowScaleDown = value.allowScaleDown;

  if (typeof timestamp !== "string" || timestamp.trim().length === 0) {
    throw new Error("reconcile request input.timestamp must be a non-empty string.");
  }
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new Error("reconcile request input.reason must be a non-empty string.");
  }
  for (const [field, fieldValue] of [
    ["desiredReplicas", desiredReplicas],
    ["suggestedReplicas", suggestedReplicas],
    ["activeReplicas", activeReplicas],
    ["activeSlots", activeSlots],
    ["busySlots", busySlots]
  ] as const) {
    if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue)) {
      throw new Error(`reconcile request input.${field} must be a finite number.`);
    }
  }
  if (typeof allowScaleDown !== "boolean") {
    throw new Error("reconcile request allowScaleDown must be a boolean.");
  }

  const readySessionCount = input.readySessionCount;
  const oldestSchedulableReadyAgeMs = input.oldestSchedulableReadyAgeMs;
  const parsedDesiredReplicas = desiredReplicas as number;
  const parsedSuggestedReplicas = suggestedReplicas as number;
  const parsedActiveReplicas = activeReplicas as number;
  const parsedActiveSlots = activeSlots as number;
  const parsedBusySlots = busySlots as number;

  return {
    input: {
      timestamp,
      reason,
      desiredReplicas: parsedDesiredReplicas,
      suggestedReplicas: parsedSuggestedReplicas,
      activeReplicas: parsedActiveReplicas,
      activeSlots: parsedActiveSlots,
      busySlots: parsedBusySlots,
      ...(typeof readySessionCount === "number" && Number.isFinite(readySessionCount) ? { readySessionCount } : {}),
      ...(typeof oldestSchedulableReadyAgeMs === "number" && Number.isFinite(oldestSchedulableReadyAgeMs)
        ? { oldestSchedulableReadyAgeMs }
        : {})
    },
    allowScaleDown
  };
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > 1024 * 1024) {
      throw new Error("request body exceeds 1MB.");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function main() {
  const config = loadConfig();

  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method !== "POST" || request.url !== "/reconcile") {
        sendJson(response, 404, { error: "not_found" });
        return;
      }

      if (config.authToken) {
        const authorization = request.headers.authorization;
        if (authorization !== `Bearer ${config.authToken}`) {
          sendJson(response, 401, { error: "unauthorized" });
          return;
        }
      }

      const reconcileRequest = parseReconcileRequest(await readJsonBody(request));
      const target = createDockerComposeWorkerReplicaTarget({
        type: "docker_compose",
        allowScaleDown: reconcileRequest.allowScaleDown,
        dockerCompose: config.dockerCompose
      });
      const result = await target.reconcile(reconcileRequest.input);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  console.log(
    `Open Agent Harness compose scaler listening on http://${config.host}:${config.port} for ${config.dockerCompose.projectName}/${config.dockerCompose.service}`
  );

  let closing = false;
  const close = async () => {
    if (closing) {
      return;
    }
    closing = true;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  };

  const handleSignal = (signal: NodeJS.Signals) => {
    console.log(`Received ${signal}; shutting down compose scaler...`);
    void close().finally(() => {
      process.exit(0);
    });
  };

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  await new Promise<void>(() => undefined);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
