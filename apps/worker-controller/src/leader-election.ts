import { readFile } from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";

import type { ServerConfig } from "@oah/config";

export interface WorkerControllerLeaderElectionStatus {
  running: boolean;
  kind: "noop" | "kubernetes";
  leader: boolean;
  identity: string;
  namespace?: string | undefined;
  leaseName?: string | undefined;
  lastAttemptAt?: string | undefined;
  lastRenewAt?: string | undefined;
  observedHolderIdentity?: string | undefined;
  lastError?: string | undefined;
}

export interface WorkerControllerLeaderElectionLogger {
  info?(message: string): void;
  warn(message: string, error?: unknown): void;
}

export interface WorkerControllerLeaderElector {
  readonly kind: "noop" | "kubernetes";
  start(): void;
  snapshot(): WorkerControllerLeaderElectionStatus;
  close(): Promise<void>;
}

interface ControllerLeaderElectionConfigShape {
  type?: "noop" | "kubernetes" | undefined;
  kubernetes?:
    | {
        namespace?: string | undefined;
        lease_name?: string | undefined;
        api_url?: string | undefined;
        token_file?: string | undefined;
        ca_file?: string | undefined;
        skip_tls_verify?: boolean | undefined;
        lease_duration_ms?: number | undefined;
        renew_interval_ms?: number | undefined;
        retry_interval_ms?: number | undefined;
        identity?: string | undefined;
      }
    | undefined;
}

export type ResolvedWorkerControllerLeaderElectionConfig =
  | {
      type: "noop";
      identity: string;
    }
  | {
      type: "kubernetes";
      identity: string;
      namespace: string;
      leaseName: string;
      apiUrl: string;
      tokenFile: string;
      caFile?: string | undefined;
      skipTlsVerify: boolean;
      leaseDurationMs: number;
      renewIntervalMs: number;
      retryIntervalMs: number;
    };

export interface KubernetesLeaseRequest {
  url: string;
  method: "GET" | "POST" | "PATCH";
  headers: Record<string, string>;
  body?: string | undefined;
  caFile?: string | undefined;
  skipTlsVerify?: boolean | undefined;
}

export type KubernetesLeaseRequestFn = (
  input: KubernetesLeaseRequest
) => Promise<{
  status: number;
  body: unknown;
  text: string;
}>;

function readBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function readStringEnv(name: string, fallback?: string | undefined): string | undefined {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  return raw.trim();
}

function readPositiveIntEnv(name: string, fallback: number, minimum: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function resolveKubernetesApiUrl(raw?: string | undefined): string | undefined {
  if (raw && raw.trim().length > 0) {
    return raw.trim();
  }

  const host = readStringEnv("KUBERNETES_SERVICE_HOST");
  const port = readStringEnv("KUBERNETES_SERVICE_PORT_HTTPS") ?? readStringEnv("KUBERNETES_SERVICE_PORT");
  if (!host || !port) {
    return undefined;
  }

  return `https://${host}:${port}`;
}

function resolveLeaderIdentity(fallbackPrefix = "worker-controller"): string {
  const explicit = readStringEnv("OAH_WORKER_CONTROLLER_IDENTITY");
  if (explicit) {
    return explicit;
  }

  const hostname = readStringEnv("HOSTNAME");
  if (hostname) {
    return hostname;
  }

  return `${fallbackPrefix}:${process.pid}`;
}

export function resolveWorkerControllerLeaderElectionConfig(
  config: ServerConfig
): ResolvedWorkerControllerLeaderElectionConfig {
  const controllerConfig = (config.workers?.controller ?? {}) as NonNullable<ServerConfig["workers"]>["controller"] & {
    leader_election?: ControllerLeaderElectionConfigShape | undefined;
  };
  const leaderElection = controllerConfig.leader_election;
  const typeRaw = readStringEnv("OAH_WORKER_CONTROLLER_LEADER_ELECTION_TYPE", leaderElection?.type ?? "noop");
  const type = typeRaw === "kubernetes" ? "kubernetes" : "noop";

  if (type === "noop") {
    return {
      type: "noop",
      identity: resolveLeaderIdentity()
    };
  }

  const kubernetes = leaderElection?.kubernetes;
  const namespace = readStringEnv("OAH_WORKER_CONTROLLER_LEASE_NAMESPACE", kubernetes?.namespace);
  const leaseName = readStringEnv("OAH_WORKER_CONTROLLER_LEASE_NAME", kubernetes?.lease_name ?? "oah-worker-controller");
  const apiUrl = resolveKubernetesApiUrl(readStringEnv("OAH_WORKER_CONTROLLER_LEASE_API_URL", kubernetes?.api_url));
  const tokenFile = readStringEnv(
    "OAH_WORKER_CONTROLLER_LEASE_TOKEN_FILE",
    kubernetes?.token_file ?? "/var/run/secrets/kubernetes.io/serviceaccount/token"
  );
  const caFile = readStringEnv(
    "OAH_WORKER_CONTROLLER_LEASE_CA_FILE",
    kubernetes?.ca_file ?? "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
  );
  const skipTlsVerify = readBoolEnv(
    "OAH_WORKER_CONTROLLER_LEASE_SKIP_TLS_VERIFY",
    kubernetes?.skip_tls_verify ?? false
  );
  const leaseDurationMs = readPositiveIntEnv(
    "OAH_WORKER_CONTROLLER_LEASE_DURATION_MS",
    kubernetes?.lease_duration_ms ?? 15_000,
    1_000
  );
  const renewIntervalMs = readPositiveIntEnv(
    "OAH_WORKER_CONTROLLER_LEASE_RENEW_INTERVAL_MS",
    kubernetes?.renew_interval_ms ?? 5_000,
    250
  );
  const retryIntervalMs = readPositiveIntEnv(
    "OAH_WORKER_CONTROLLER_LEASE_RETRY_INTERVAL_MS",
    kubernetes?.retry_interval_ms ?? 2_000,
    250
  );
  const identity = readStringEnv("OAH_WORKER_CONTROLLER_LEASE_IDENTITY", kubernetes?.identity) ?? resolveLeaderIdentity();

  if (!namespace) {
    throw new Error("worker-controller kubernetes leader election requires namespace.");
  }
  if (!leaseName) {
    throw new Error("worker-controller kubernetes leader election requires lease_name.");
  }
  if (!apiUrl) {
    throw new Error("worker-controller kubernetes leader election requires api_url or in-cluster service env.");
  }
  if (!tokenFile) {
    throw new Error("worker-controller kubernetes leader election requires token_file.");
  }

  return {
    type: "kubernetes",
    identity,
    namespace,
    leaseName,
    apiUrl,
    tokenFile,
    caFile,
    skipTlsVerify,
    leaseDurationMs,
    renewIntervalMs,
    retryIntervalMs
  };
}

export function createWorkerControllerLeaderElector(
  config: ResolvedWorkerControllerLeaderElectionConfig,
  options: {
    onGainedLeadership: () => Promise<void> | void;
    onLostLeadership: () => Promise<void> | void;
    logger?: WorkerControllerLeaderElectionLogger | undefined;
    request?: KubernetesLeaseRequestFn | undefined;
  }
): WorkerControllerLeaderElector {
  if (config.type === "kubernetes") {
    return new KubernetesWorkerControllerLeaderElector(config, options);
  }

  return new NoopWorkerControllerLeaderElector(config, options);
}

class NoopWorkerControllerLeaderElector implements WorkerControllerLeaderElector {
  readonly kind = "noop" as const;
  readonly #identity: string;
  readonly #onGainedLeadership: () => Promise<void> | void;
  #running = false;
  #leader = false;

  constructor(
    config: Extract<ResolvedWorkerControllerLeaderElectionConfig, { type: "noop" }>,
    options: {
      onGainedLeadership: () => Promise<void> | void;
    }
  ) {
    this.#identity = config.identity;
    this.#onGainedLeadership = options.onGainedLeadership;
  }

  start(): void {
    if (this.#running) {
      return;
    }

    this.#running = true;
    this.#leader = true;
    void Promise.resolve(this.#onGainedLeadership());
  }

  snapshot(): WorkerControllerLeaderElectionStatus {
    return {
      running: this.#running,
      kind: this.kind,
      leader: this.#leader,
      identity: this.#identity
    };
  }

  async close(): Promise<void> {
    this.#running = false;
    this.#leader = false;
  }
}

class KubernetesWorkerControllerLeaderElector implements WorkerControllerLeaderElector {
  readonly kind = "kubernetes" as const;
  readonly #config: Extract<ResolvedWorkerControllerLeaderElectionConfig, { type: "kubernetes" }>;
  readonly #request: KubernetesLeaseRequestFn;
  readonly #onGainedLeadership: () => Promise<void> | void;
  readonly #onLostLeadership: () => Promise<void> | void;
  readonly #logger?: WorkerControllerLeaderElectionLogger | undefined;
  readonly #leaseUrl: string;
  readonly #leaseCollectionUrl: string;
  #running = false;
  #closed = false;
  #leader = false;
  #timer: NodeJS.Timeout | undefined;
  #status: WorkerControllerLeaderElectionStatus;

  constructor(
    config: Extract<ResolvedWorkerControllerLeaderElectionConfig, { type: "kubernetes" }>,
    options: {
      onGainedLeadership: () => Promise<void> | void;
      onLostLeadership: () => Promise<void> | void;
      logger?: WorkerControllerLeaderElectionLogger | undefined;
      request?: KubernetesLeaseRequestFn | undefined;
    }
  ) {
    this.#config = config;
    this.#request = options.request ?? defaultKubernetesLeaseRequest;
    this.#onGainedLeadership = options.onGainedLeadership;
    this.#onLostLeadership = options.onLostLeadership;
    this.#logger = options.logger;
    this.#leaseCollectionUrl = new URL(
      `/apis/coordination.k8s.io/v1/namespaces/${encodeURIComponent(config.namespace)}/leases`,
      appendTrailingSlash(config.apiUrl)
    ).toString();
    this.#leaseUrl = `${this.#leaseCollectionUrl}/${encodeURIComponent(config.leaseName)}`;
    this.#status = {
      running: false,
      kind: this.kind,
      leader: false,
      identity: config.identity,
      namespace: config.namespace,
      leaseName: config.leaseName
    };
  }

  start(): void {
    if (this.#running || this.#closed) {
      return;
    }

    this.#running = true;
    this.#status = {
      ...this.#status,
      running: true
    };
    void this.#tick();
  }

  snapshot(): WorkerControllerLeaderElectionStatus {
    return {
      ...this.#status
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#running = false;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#leader) {
      this.#leader = false;
      await Promise.resolve(this.#onLostLeadership());
    }
    this.#status = {
      ...this.#status,
      running: false,
      leader: false
    };
  }

  async #tick(): Promise<void> {
    if (!this.#running || this.#closed) {
      return;
    }

    const attemptAt = new Date().toISOString();
    let leader = false;
    let lastError: string | undefined;

    try {
      leader = await this.#acquireOrRenewLeadership(attemptAt);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      this.#logger?.warn("[worker-controller] leader election attempt failed", error);
    }

    const wasLeader = this.#leader;
    this.#leader = leader;
    this.#status = {
      ...this.#status,
      running: this.#running,
      leader,
      lastAttemptAt: attemptAt,
      ...(lastError ? { lastError } : {})
    };

    if (!wasLeader && leader) {
      this.#logger?.info?.(
        `[worker-controller] leadership acquired lease=${this.#config.leaseName} identity=${this.#config.identity}`
      );
      await Promise.resolve(this.#onGainedLeadership());
    } else if (wasLeader && !leader) {
      this.#logger?.warn(
        `[worker-controller] leadership lost lease=${this.#config.leaseName} identity=${this.#config.identity}${
          lastError ? ` error=${lastError}` : ""
        }`
      );
      await Promise.resolve(this.#onLostLeadership());
    }

    if (!this.#running || this.#closed) {
      return;
    }

    const delay = leader ? this.#config.renewIntervalMs : this.#config.retryIntervalMs;
    this.#timer = setTimeout(() => {
      void this.#tick();
    }, delay);
    this.#timer.unref?.();
  }

  async #acquireOrRenewLeadership(nowIso: string): Promise<boolean> {
    const authHeaders = await buildKubernetesAuthHeaders(this.#config.tokenFile);
    const getResponse = await this.#request({
      url: this.#leaseUrl,
      method: "GET",
      headers: {
        ...authHeaders,
        accept: "application/json"
      },
      caFile: this.#config.caFile,
      skipTlsVerify: this.#config.skipTlsVerify
    });

    if (getResponse.status === 404) {
      const created = await this.#request({
        url: this.#leaseCollectionUrl,
        method: "POST",
        headers: {
          ...authHeaders,
          accept: "application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          apiVersion: "coordination.k8s.io/v1",
          kind: "Lease",
          metadata: {
            name: this.#config.leaseName
          },
          spec: {
            holderIdentity: this.#config.identity,
            leaseDurationSeconds: Math.ceil(this.#config.leaseDurationMs / 1_000),
            acquireTime: nowIso,
            renewTime: nowIso,
            leaseTransitions: 1
          }
        }),
        caFile: this.#config.caFile,
        skipTlsVerify: this.#config.skipTlsVerify
      });
      if (created.status === 409) {
        return false;
      }
      assertKubernetesSuccess("create lease", created);
      this.#status = {
        ...this.#status,
        lastRenewAt: nowIso,
        observedHolderIdentity: this.#config.identity
      };
      return true;
    }

    assertKubernetesSuccess("read lease", getResponse);
    const lease = parseLease(getResponse.body);
    this.#status = {
      ...this.#status,
      observedHolderIdentity: lease.holderIdentity
    };

    const sameHolder = lease.holderIdentity === this.#config.identity;
    const expired = isLeaseExpired(lease, Date.now());
    if (!sameHolder && !expired) {
      return false;
    }

    const patchResponse = await this.#request({
      url: this.#leaseUrl,
      method: "PATCH",
      headers: {
        ...authHeaders,
        accept: "application/json",
        "content-type": "application/merge-patch+json"
      },
      body: JSON.stringify({
        metadata: {
          resourceVersion: lease.resourceVersion
        },
        spec: {
          holderIdentity: this.#config.identity,
          leaseDurationSeconds: Math.ceil(this.#config.leaseDurationMs / 1_000),
          renewTime: nowIso,
          ...(sameHolder ? {} : { acquireTime: nowIso }),
          ...(sameHolder ? {} : { leaseTransitions: (lease.leaseTransitions ?? 0) + 1 })
        }
      }),
      caFile: this.#config.caFile,
      skipTlsVerify: this.#config.skipTlsVerify
    });
    if (patchResponse.status === 409) {
      return false;
    }
    assertKubernetesSuccess("patch lease", patchResponse);
    this.#status = {
      ...this.#status,
      lastRenewAt: nowIso,
      observedHolderIdentity: this.#config.identity
    };
    return true;
  }
}

function isLeaseExpired(lease: ParsedLease, nowMs: number): boolean {
  if (!lease.holderIdentity) {
    return true;
  }

  const renewTime = lease.renewTime ?? lease.acquireTime;
  if (!renewTime || !lease.leaseDurationSeconds) {
    return true;
  }

  const renewMs = Date.parse(renewTime);
  if (!Number.isFinite(renewMs)) {
    return true;
  }

  return renewMs + lease.leaseDurationSeconds * 1_000 <= nowMs;
}

interface ParsedLease {
  resourceVersion?: string | undefined;
  holderIdentity?: string | undefined;
  renewTime?: string | undefined;
  acquireTime?: string | undefined;
  leaseDurationSeconds?: number | undefined;
  leaseTransitions?: number | undefined;
}

function parseLease(payload: unknown): ParsedLease {
  if (!payload || typeof payload !== "object") {
    return {};
  }

  const metadata = Reflect.get(payload, "metadata");
  const spec = Reflect.get(payload, "spec");
  return {
    resourceVersion:
      metadata && typeof metadata === "object" && typeof Reflect.get(metadata, "resourceVersion") === "string"
        ? (Reflect.get(metadata, "resourceVersion") as string)
        : undefined,
    holderIdentity:
      spec && typeof spec === "object" && typeof Reflect.get(spec, "holderIdentity") === "string"
        ? (Reflect.get(spec, "holderIdentity") as string)
        : undefined,
    renewTime:
      spec && typeof spec === "object" && typeof Reflect.get(spec, "renewTime") === "string"
        ? (Reflect.get(spec, "renewTime") as string)
        : undefined,
    acquireTime:
      spec && typeof spec === "object" && typeof Reflect.get(spec, "acquireTime") === "string"
        ? (Reflect.get(spec, "acquireTime") as string)
        : undefined,
    leaseDurationSeconds:
      spec && typeof spec === "object" && typeof Reflect.get(spec, "leaseDurationSeconds") === "number"
        ? (Reflect.get(spec, "leaseDurationSeconds") as number)
        : undefined,
    leaseTransitions:
      spec && typeof spec === "object" && typeof Reflect.get(spec, "leaseTransitions") === "number"
        ? (Reflect.get(spec, "leaseTransitions") as number)
        : undefined
  };
}

async function buildKubernetesAuthHeaders(tokenFile: string): Promise<Record<string, string>> {
  const token = (await readFile(tokenFile, "utf8")).trim();
  if (!token) {
    throw new Error(`Kubernetes service account token file is empty: ${tokenFile}`);
  }

  return {
    authorization: `Bearer ${token}`
  };
}

function appendTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function assertKubernetesSuccess(
  operation: string,
  response: {
    status: number;
    body: unknown;
    text: string;
  }
): void {
  if (response.status >= 200 && response.status < 300) {
    return;
  }

  const message =
    extractKubernetesStatusMessage(response.body) ??
    response.text.trim() ??
    `${operation} failed with status ${response.status}`;
  throw new Error(`${operation} failed with status ${response.status}: ${message}`);
}

function extractKubernetesStatusMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }

  const message = Reflect.get(body, "message");
  return typeof message === "string" && message.trim().length > 0 ? message.trim() : undefined;
}

export async function defaultKubernetesLeaseRequest(
  input: KubernetesLeaseRequest
): Promise<{
  status: number;
  body: unknown;
  text: string;
}> {
  const url = new URL(input.url);
  const transport = url.protocol === "https:" ? https : http;
  const ca = input.caFile ? await readFile(input.caFile, "utf8") : undefined;

  const { status, text } = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: input.method,
        headers: input.headers,
        ...(url.protocol === "https:"
          ? {
              ca,
              rejectUnauthorized: input.skipTlsVerify ? false : true
            }
          : {})
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );
    request.on("error", reject);
    if (input.body) {
      request.write(input.body);
    }
    request.end();
  });

  return {
    status,
    body: text.trim().length > 0 ? tryParseJson(text) : undefined,
    text
  };
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
