export type WorkerReplicaTargetOutcome = "disabled" | "steady" | "scaled" | "blocked_scale_down" | "error";

export type WorkerReplicaTargetPhase = "disabled" | "steady" | "accepted" | "progressing" | "ready" | "blocked" | "error";

export interface WorkerReplicaTargetRef {
  platform: "kubernetes" | "docker_compose" | "noop";
  kind?: string | undefined;
  namespace?: string | undefined;
  name?: string | undefined;
  discovery?: "explicit" | "label_selector" | undefined;
  selector?: string | undefined;
}

export interface WorkerReplicaTargetInput {
  timestamp: string;
  reason: string;
  desiredReplicas: number;
  suggestedReplicas: number;
  activeReplicas: number;
  activeSlots: number;
  busySlots: number;
  readySessionCount?: number | undefined;
  oldestSchedulableReadyAgeMs?: number | undefined;
}

export interface WorkerReplicaTargetResult {
  kind: string;
  attempted: boolean;
  applied: boolean;
  desiredReplicas: number;
  observedReplicas?: number | undefined;
  appliedReplicas?: number | undefined;
  outcome: WorkerReplicaTargetOutcome;
  at: string;
  phase?: WorkerReplicaTargetPhase | undefined;
  stage?: "discover_target" | "read_state" | "apply_scale" | "observe_rollout" | undefined;
  reasonCode?: string | undefined;
  targetRef?: WorkerReplicaTargetRef | undefined;
  generation?: number | undefined;
  observedGeneration?: number | undefined;
  readyReplicas?: number | undefined;
  updatedReplicas?: number | undefined;
  availableReplicas?: number | undefined;
  unavailableReplicas?: number | undefined;
  message?: string | undefined;
}

export interface WorkerReplicaTarget {
  readonly kind: string;
  reconcile(input: WorkerReplicaTargetInput): Promise<WorkerReplicaTargetResult>;
  close?(): Promise<void>;
}

export interface ControllerScaleTargetConfigShape {
  type?: "noop" | "kubernetes" | "docker_compose" | undefined;
  allow_scale_down?: boolean | undefined;
  kubernetes?:
    | {
        namespace?: string | undefined;
        workload_kind?: string | undefined;
        workload_name?: string | undefined;
        deployment?: string | undefined;
        statefulset?: string | undefined;
        label_selector?: string | undefined;
        api_url?: string | undefined;
        token_file?: string | undefined;
        ca_file?: string | undefined;
        skip_tls_verify?: boolean | undefined;
      }
    | undefined;
  docker_compose?:
    | {
        compose_file?: string | undefined;
        project_name?: string | undefined;
        service?: string | undefined;
        command?: string | undefined;
        endpoint?: string | undefined;
        auth_token?: string | undefined;
        timeout_ms?: number | undefined;
      }
    | undefined;
}

export type KubernetesWorkloadKind = "Deployment" | "StatefulSet";

export interface KubernetesWorkloadResource {
  readonly kind: KubernetesWorkloadKind;
  readonly plural: "deployments" | "statefulsets";
  readonly displayName: "deployment" | "statefulset";
}

export type ResolvedWorkerReplicaTargetConfig =
  | {
      type: "noop";
      allowScaleDown: boolean;
    }
  | {
      type: "kubernetes";
      allowScaleDown: boolean;
      kubernetes: {
        namespace: string;
        workloadKind?: KubernetesWorkloadKind | undefined;
        workloadName?: string | undefined;
        deployment?: string | undefined;
        labelSelector?: string | undefined;
        apiUrl: string;
        tokenFile: string;
        caFile?: string | undefined;
        skipTlsVerify: boolean;
      };
    }
  | {
      type: "docker_compose";
      allowScaleDown: boolean;
      dockerCompose: {
        composeFile?: string | undefined;
        projectName: string;
        service: string;
        command: string;
        remote?:
          | {
              endpoint: string;
              authToken?: string | undefined;
              timeoutMs: number;
            }
          | undefined;
      };
    };

export interface KubernetesJsonRequest {
  url: string;
  method: "GET" | "PATCH";
  headers: Record<string, string>;
  body?: string | undefined;
  caFile?: string | undefined;
  skipTlsVerify?: boolean | undefined;
}

export interface JsonHttpRequest {
  url: string;
  method: "GET" | "POST" | "PATCH";
  headers: Record<string, string>;
  body?: string | undefined;
  caFile?: string | undefined;
  skipTlsVerify?: boolean | undefined;
  timeoutMs?: number | undefined;
}

export interface KubernetesDeploymentObservation {
  specReplicas?: number | undefined;
  statusReplicas?: number | undefined;
  readyReplicas?: number | undefined;
  updatedReplicas?: number | undefined;
  availableReplicas?: number | undefined;
  unavailableReplicas?: number | undefined;
  generation?: number | undefined;
  observedGeneration?: number | undefined;
}

export interface DockerComposeCommandInput {
  args: string[];
  cwd?: string | undefined;
}

export interface DockerComposeCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface DockerComposeManagedContainer {
  id: string;
  name: string;
  running: boolean;
}

export interface DockerComposeRemoteReconcileRequest {
  input: WorkerReplicaTargetInput;
  allowScaleDown: boolean;
}

export type DockerComposeCommandFn = (input: DockerComposeCommandInput) => Promise<DockerComposeCommandResult>;

export type KubernetesJsonRequestFn = (
  input: KubernetesJsonRequest
) => Promise<{
  status: number;
  body: unknown;
  text: string;
}>;

export type JsonHttpRequestFn = (
  input: JsonHttpRequest
) => Promise<{
  status: number;
  body: unknown;
  text: string;
}>;
