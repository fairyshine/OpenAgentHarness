import { readFile } from "node:fs/promises";

import { kubernetesWorkloadResource } from "./config.js";
import { appendTrailingSlash, defaultJsonHttpRequest, extractStatusMessage } from "./http.js";
import type {
  KubernetesDeploymentObservation,
  KubernetesJsonRequest,
  KubernetesJsonRequestFn,
  KubernetesWorkloadResource,
  ResolvedWorkerReplicaTargetConfig,
  WorkerReplicaTarget,
  WorkerReplicaTargetInput,
  WorkerReplicaTargetOutcome,
  WorkerReplicaTargetPhase,
  WorkerReplicaTargetRef,
  WorkerReplicaTargetResult
} from "./types.js";

class KubernetesReplicaTargetError extends Error {
  readonly code: string;
  readonly stage: "discover_target" | "read_state" | "apply_scale" | "observe_rollout";
  readonly status?: number | undefined;

  constructor(input: {
    message: string;
    code: string;
    stage: "discover_target" | "read_state" | "apply_scale" | "observe_rollout";
    status?: number | undefined;
  }) {
    super(input.message);
    this.name = "KubernetesReplicaTargetError";
    this.code = input.code;
    this.stage = input.stage;
    this.status = input.status;
  }
}

export function createKubernetesWorkerReplicaTarget(
  config: Extract<ResolvedWorkerReplicaTargetConfig, { type: "kubernetes" }>,
  options?: {
    request?: KubernetesJsonRequestFn | undefined;
  }
): WorkerReplicaTarget {
  const request = options?.request ?? defaultKubernetesJsonRequest;

  return {
    kind: "kubernetes",
    async reconcile(input) {
      let targetRef: WorkerReplicaTargetRef | undefined;
      let observedState: KubernetesDeploymentObservation | undefined;
      let observedReplicas: number | undefined;
      const workloadResource = kubernetesWorkloadResource(config.kubernetes.workloadKind ?? "Deployment");

      try {
        const workloadName =
          config.kubernetes.workloadName ??
          config.kubernetes.deployment ??
          (await discoverKubernetesWorkloadName(
            {
              workload: workloadResource,
              namespace: config.kubernetes.namespace,
              labelSelector: config.kubernetes.labelSelector!,
              apiUrl: config.kubernetes.apiUrl,
              tokenFile: config.kubernetes.tokenFile,
              caFile: config.kubernetes.caFile,
              skipTlsVerify: config.kubernetes.skipTlsVerify
            },
            request
          ));
        targetRef = {
          platform: "kubernetes",
          kind: workloadResource.kind,
          namespace: config.kubernetes.namespace,
          name: workloadName,
          discovery: config.kubernetes.workloadName || config.kubernetes.deployment ? "explicit" : "label_selector",
          ...(config.kubernetes.labelSelector ? { selector: config.kubernetes.labelSelector } : {})
        };

        const authHeaders = await buildKubernetesAuthHeaders(config.kubernetes.tokenFile);
        observedState = await readKubernetesDeploymentState(
          {
            workload: workloadResource,
            apiUrl: config.kubernetes.apiUrl,
            namespace: config.kubernetes.namespace,
            name: workloadName,
            headers: authHeaders,
            caFile: config.kubernetes.caFile,
            skipTlsVerify: config.kubernetes.skipTlsVerify
          },
          request,
          "read_state"
        );
        observedReplicas = observedState.specReplicas ?? observedState.statusReplicas;

        if (typeof observedReplicas === "number" && !config.allowScaleDown && input.desiredReplicas < observedReplicas) {
          return buildKubernetesResult({
            input,
            targetRef,
            attempted: true,
            applied: false,
            observedReplicas,
            appliedReplicas: observedReplicas,
            outcome: "blocked_scale_down",
            phase: "blocked",
            reasonCode: "scale_down_disabled",
            message: "scale down blocked by controller policy",
            observedState
          });
        }

        if (typeof observedReplicas === "number" && input.desiredReplicas === observedReplicas) {
          const phase = isKubernetesDeploymentReady(observedState, input.desiredReplicas) ? "ready" : "progressing";
          return buildKubernetesResult({
            input,
            targetRef,
            attempted: true,
            applied: false,
            observedReplicas,
            appliedReplicas: observedReplicas,
            outcome: "steady",
            phase,
            ...(phase === "progressing"
              ? {
                  reasonCode: "rollout_in_progress",
                  stage: "observe_rollout" as const,
                  message: `${workloadResource.displayName} already targets desired replicas but rollout is still progressing`
                }
              : {}),
            observedState
          });
        }

        const scaleUrl = buildKubernetesDeploymentScaleUrl({
          workload: workloadResource,
          apiUrl: config.kubernetes.apiUrl,
          namespace: config.kubernetes.namespace,
          name: workloadName
        });
        const patchResponse = await request({
          url: scaleUrl,
          method: "PATCH",
          headers: {
            ...authHeaders,
            accept: "application/json",
            "content-type": "application/merge-patch+json"
          },
          body: JSON.stringify({
            spec: {
              replicas: input.desiredReplicas
            }
          }),
          caFile: config.kubernetes.caFile,
          skipTlsVerify: config.kubernetes.skipTlsVerify
        });
        assertKubernetesSuccess(`patch ${workloadResource.displayName} scale`, patchResponse, "apply_scale");
        const appliedReplicas = parseReplicas(patchResponse.body) ?? input.desiredReplicas;

        let postPatchState: KubernetesDeploymentObservation | undefined;
        try {
          postPatchState = await readKubernetesDeploymentState(
            {
              workload: workloadResource,
              apiUrl: config.kubernetes.apiUrl,
              namespace: config.kubernetes.namespace,
              name: workloadName,
              headers: authHeaders,
              caFile: config.kubernetes.caFile,
              skipTlsVerify: config.kubernetes.skipTlsVerify
            },
            request,
            "observe_rollout"
          );
        } catch (error) {
          if (error instanceof KubernetesReplicaTargetError) {
            return buildKubernetesResult({
              input,
              targetRef,
              attempted: true,
              applied: true,
              observedReplicas,
              appliedReplicas,
              outcome: "scaled",
              phase: "accepted",
              reasonCode: "post_patch_observation_unavailable",
              stage: "observe_rollout",
              message: `scale request accepted but rollout observation is unavailable: ${error.message}`,
              observedState
            });
          }

          throw error;
        }

        const postPatchReplicas = postPatchState.specReplicas ?? postPatchState.statusReplicas ?? appliedReplicas;
        const phase =
          postPatchReplicas !== input.desiredReplicas
            ? "accepted"
            : isKubernetesDeploymentReady(postPatchState, input.desiredReplicas)
              ? "ready"
              : "progressing";

        return buildKubernetesResult({
          input,
          targetRef,
          attempted: true,
          applied: true,
          observedReplicas,
          appliedReplicas: postPatchReplicas,
          outcome: "scaled",
          phase,
          ...(phase === "accepted"
            ? {
                reasonCode: "scale_request_accepted",
                stage: "apply_scale" as const,
                message: "scale request accepted and waiting for deployment spec to converge"
              }
            : phase === "progressing"
              ? {
                  reasonCode: "rollout_in_progress",
                  stage: "observe_rollout" as const,
                  message: `${workloadResource.displayName} accepted the new replica target and rollout is progressing`
                }
              : {
                  reasonCode: "rollout_ready",
                  stage: "observe_rollout" as const,
                  message: `${workloadResource.displayName} reached the desired replica target and is ready`
                }),
          observedState: postPatchState
        });
      } catch (error) {
        return buildKubernetesErrorResult({
          input,
          error,
          targetRef,
          observedReplicas,
          observedState
        });
      }
    }
  };
}

function buildKubernetesDeploymentScaleUrl(input: {
  workload: KubernetesWorkloadResource;
  apiUrl: string;
  namespace: string;
  name: string;
}): string {
  return new URL(
    `/apis/apps/v1/namespaces/${encodeURIComponent(input.namespace)}/${input.workload.plural}/${encodeURIComponent(input.name)}/scale`,
    appendTrailingSlash(input.apiUrl)
  ).toString();
}

function buildKubernetesDeploymentUrl(input: {
  workload: KubernetesWorkloadResource;
  apiUrl: string;
  namespace: string;
  name: string;
}): string {
  return new URL(
    `/apis/apps/v1/namespaces/${encodeURIComponent(input.namespace)}/${input.workload.plural}/${encodeURIComponent(input.name)}`,
    appendTrailingSlash(input.apiUrl)
  ).toString();
}

async function readKubernetesDeploymentState(
  input: {
    workload: KubernetesWorkloadResource;
    apiUrl: string;
    namespace: string;
    name: string;
    headers: Record<string, string>;
    caFile?: string | undefined;
    skipTlsVerify: boolean;
  },
  request: KubernetesJsonRequestFn,
  stage: "read_state" | "observe_rollout"
): Promise<KubernetesDeploymentObservation> {
  const response = await request({
    url: buildKubernetesDeploymentUrl(input),
    method: "GET",
    headers: {
      ...input.headers,
      accept: "application/json"
    },
    caFile: input.caFile,
    skipTlsVerify: input.skipTlsVerify
  });
  assertKubernetesSuccess(`read ${input.workload.displayName} state`, response, stage);
  return parseKubernetesDeploymentObservation(response.body);
}

async function discoverKubernetesWorkloadName(
  input: {
    workload: KubernetesWorkloadResource;
    namespace: string;
    labelSelector: string;
    apiUrl: string;
    tokenFile: string;
    caFile?: string | undefined;
    skipTlsVerify: boolean;
  },
  request: KubernetesJsonRequestFn
): Promise<string> {
  const authHeaders = await buildKubernetesAuthHeaders(input.tokenFile);
  const workloadsUrl = new URL(
    `/apis/apps/v1/namespaces/${encodeURIComponent(input.namespace)}/${input.workload.plural}`,
    appendTrailingSlash(input.apiUrl)
  );
  workloadsUrl.searchParams.set("labelSelector", input.labelSelector);

  const response = await request({
    url: workloadsUrl.toString(),
    method: "GET",
    headers: {
      ...authHeaders,
      accept: "application/json"
    },
    caFile: input.caFile,
    skipTlsVerify: input.skipTlsVerify
  });
  assertKubernetesSuccess(`discover target ${input.workload.displayName}`, response, "discover_target");
  const workloadNames = extractWorkloadNames(response.body);
  if (workloadNames.length === 0) {
    throw new KubernetesReplicaTargetError({
      message: `no ${input.workload.displayName} matched label selector ${input.labelSelector}`,
      code: "selector_no_match",
      stage: "discover_target"
    });
  }
  if (workloadNames.length > 1) {
    throw new KubernetesReplicaTargetError({
      message: `label selector ${input.labelSelector} matched multiple ${input.workload.plural}: ${workloadNames.join(", ")}`,
      code: "selector_multiple_matches",
      stage: "discover_target"
    });
  }

  return workloadNames[0]!;
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

function parseReplicas(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const spec = Reflect.get(payload, "spec");
  if (!spec || typeof spec !== "object") {
    return undefined;
  }

  const replicas = Reflect.get(spec, "replicas");
  return typeof replicas === "number" && Number.isFinite(replicas) ? replicas : undefined;
}

function readNestedNumber(payload: unknown, pathSegments: string[]): number | undefined {
  let current: unknown = payload;
  for (const segment of pathSegments) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = Reflect.get(current, segment);
  }

  return typeof current === "number" && Number.isFinite(current) ? current : undefined;
}

function parseKubernetesDeploymentObservation(payload: unknown): KubernetesDeploymentObservation {
  return {
    specReplicas: readNestedNumber(payload, ["spec", "replicas"]),
    statusReplicas: readNestedNumber(payload, ["status", "replicas"]),
    readyReplicas: readNestedNumber(payload, ["status", "readyReplicas"]),
    updatedReplicas: readNestedNumber(payload, ["status", "updatedReplicas"]),
    availableReplicas: readNestedNumber(payload, ["status", "availableReplicas"]),
    unavailableReplicas: readNestedNumber(payload, ["status", "unavailableReplicas"]),
    generation: readNestedNumber(payload, ["metadata", "generation"]),
    observedGeneration: readNestedNumber(payload, ["status", "observedGeneration"])
  };
}

function isKubernetesDeploymentReady(
  observation: KubernetesDeploymentObservation | undefined,
  desiredReplicas: number
): boolean {
  if (!observation) {
    return false;
  }

  const desired = Math.max(0, desiredReplicas);
  const specReplicas = observation.specReplicas;
  if (typeof specReplicas === "number" && specReplicas !== desired) {
    return false;
  }

  const generationConverged =
    typeof observation.generation !== "number" ||
    typeof observation.observedGeneration !== "number" ||
    observation.observedGeneration >= observation.generation;
  if (!generationConverged) {
    return false;
  }

  const readyReplicas = observation.readyReplicas ?? 0;
  const updatedReplicas = observation.updatedReplicas ?? desired;
  const availableReplicas = observation.availableReplicas ?? readyReplicas;
  const unavailableReplicas = observation.unavailableReplicas ?? Math.max(0, desired - availableReplicas);

  if (desired === 0) {
    return readyReplicas === 0 && availableReplicas === 0 && unavailableReplicas === 0;
  }

  return readyReplicas >= desired && updatedReplicas >= desired && availableReplicas >= desired && unavailableReplicas === 0;
}

function buildKubernetesResult(input: {
  input: WorkerReplicaTargetInput;
  targetRef: WorkerReplicaTargetRef;
  attempted: boolean;
  applied: boolean;
  observedReplicas?: number | undefined;
  appliedReplicas?: number | undefined;
  outcome: WorkerReplicaTargetOutcome;
  phase: WorkerReplicaTargetPhase;
  stage?: "discover_target" | "read_state" | "apply_scale" | "observe_rollout" | undefined;
  reasonCode?: string | undefined;
  message?: string | undefined;
  observedState?: KubernetesDeploymentObservation | undefined;
}): WorkerReplicaTargetResult {
  return {
    kind: "kubernetes",
    attempted: input.attempted,
    applied: input.applied,
    desiredReplicas: input.input.desiredReplicas,
    ...(typeof input.observedReplicas === "number" ? { observedReplicas: input.observedReplicas } : {}),
    ...(typeof input.appliedReplicas === "number" ? { appliedReplicas: input.appliedReplicas } : {}),
    outcome: input.outcome,
    at: input.input.timestamp,
    phase: input.phase,
    ...(input.stage ? { stage: input.stage } : {}),
    ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
    targetRef: input.targetRef,
    ...(typeof input.observedState?.generation === "number" ? { generation: input.observedState.generation } : {}),
    ...(typeof input.observedState?.observedGeneration === "number"
      ? { observedGeneration: input.observedState.observedGeneration }
      : {}),
    ...(typeof input.observedState?.readyReplicas === "number" ? { readyReplicas: input.observedState.readyReplicas } : {}),
    ...(typeof input.observedState?.updatedReplicas === "number"
      ? { updatedReplicas: input.observedState.updatedReplicas }
      : {}),
    ...(typeof input.observedState?.availableReplicas === "number"
      ? { availableReplicas: input.observedState.availableReplicas }
      : {}),
    ...(typeof input.observedState?.unavailableReplicas === "number"
      ? { unavailableReplicas: input.observedState.unavailableReplicas }
      : {}),
    ...(input.message ? { message: input.message } : {})
  };
}

function buildKubernetesErrorResult(input: {
  input: WorkerReplicaTargetInput;
  error: unknown;
  targetRef?: WorkerReplicaTargetRef | undefined;
  observedReplicas?: number | undefined;
  observedState?: KubernetesDeploymentObservation | undefined;
}): WorkerReplicaTargetResult {
  const classified = input.error instanceof KubernetesReplicaTargetError ? input.error : classifyKubernetesError(input.error);

  return {
    kind: "kubernetes",
    attempted: true,
    applied: false,
    desiredReplicas: input.input.desiredReplicas,
    ...(typeof input.observedReplicas === "number" ? { observedReplicas: input.observedReplicas } : {}),
    outcome: "error",
    at: input.input.timestamp,
    phase: "error",
    stage: classified.stage,
    reasonCode: classified.code,
    ...(input.targetRef ? { targetRef: input.targetRef } : {}),
    ...(typeof input.observedState?.generation === "number" ? { generation: input.observedState.generation } : {}),
    ...(typeof input.observedState?.observedGeneration === "number"
      ? { observedGeneration: input.observedState.observedGeneration }
      : {}),
    ...(typeof input.observedState?.readyReplicas === "number" ? { readyReplicas: input.observedState.readyReplicas } : {}),
    ...(typeof input.observedState?.updatedReplicas === "number"
      ? { updatedReplicas: input.observedState.updatedReplicas }
      : {}),
    ...(typeof input.observedState?.availableReplicas === "number"
      ? { availableReplicas: input.observedState.availableReplicas }
      : {}),
    ...(typeof input.observedState?.unavailableReplicas === "number"
      ? { unavailableReplicas: input.observedState.unavailableReplicas }
      : {}),
    message: classified.message
  };
}

function extractWorkloadNames(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const items = Reflect.get(payload, "items");
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item) => {
      if (!item || typeof item !== "object") {
        return undefined;
      }
      const metadata = Reflect.get(item, "metadata");
      if (!metadata || typeof metadata !== "object") {
        return undefined;
      }
      const name = Reflect.get(metadata, "name");
      return typeof name === "string" && name.trim().length > 0 ? name : undefined;
    })
    .filter((name): name is string => name !== undefined);
}

function assertKubernetesSuccess(
  operation: string,
  response: {
    status: number;
    body: unknown;
    text: string;
  },
  stage: "discover_target" | "read_state" | "apply_scale" | "observe_rollout"
): void {
  if (response.status >= 200 && response.status < 300) {
    return;
  }

  const message =
    extractStatusMessage(response.body) ?? (response.text.trim() || `${operation} failed with status ${response.status}`);
  throw new KubernetesReplicaTargetError({
    message: `${operation} failed with status ${response.status}: ${message}`,
    code: classifyKubernetesStatusCode(response.status),
    stage,
    status: response.status
  });
}

function classifyKubernetesStatusCode(status: number): string {
  if (status === 401) {
    return "unauthorized";
  }
  if (status === 403) {
    return "forbidden";
  }
  if (status === 404) {
    return "not_found";
  }
  if (status === 409) {
    return "conflict";
  }
  if (status === 429) {
    return "rate_limited";
  }
  if (status >= 500) {
    return "api_unavailable";
  }
  if (status >= 400) {
    return "invalid_request";
  }
  return "unexpected_status";
}

function classifyKubernetesError(error: unknown): KubernetesReplicaTargetError {
  if (error instanceof KubernetesReplicaTargetError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/timed out/iu.test(message) || /timeout/iu.test(message) || /abort/iu.test(message)) {
    return new KubernetesReplicaTargetError({
      message,
      code: "timeout",
      stage: "read_state"
    });
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|socket hang up/iu.test(message)) {
    return new KubernetesReplicaTargetError({
      message,
      code: "network_error",
      stage: "read_state"
    });
  }

  return new KubernetesReplicaTargetError({
    message,
    code: "unexpected_error",
    stage: "read_state"
  });
}

export async function defaultKubernetesJsonRequest(
  input: KubernetesJsonRequest
): Promise<{
  status: number;
  body: unknown;
  text: string;
}> {
  return defaultJsonHttpRequest(input);
}
