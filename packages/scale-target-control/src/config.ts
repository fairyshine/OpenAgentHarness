import type { ServerConfig } from "@oah/config-server-control";

import type {
  ControllerScaleTargetConfigShape,
  KubernetesWorkloadKind,
  KubernetesWorkloadResource,
  ResolvedWorkerReplicaTargetConfig
} from "./types.js";

function readEnv(names: string | string[]): string | undefined {
  for (const name of Array.isArray(names) ? names : [names]) {
    const raw = process.env[name];
    if (raw && raw.trim().length > 0) {
      return raw.trim();
    }
  }

  return undefined;
}

function readBoolEnv(names: string | string[], fallback: boolean): boolean {
  const raw = readEnv(names);
  if (!raw) {
    return fallback;
  }

  const normalized = raw.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function readStringEnv(names: string | string[], fallback?: string | undefined): string | undefined {
  return readEnv(names) ?? fallback;
}

function readPositiveIntEnv(names: string | string[], fallback: number, minimum: number): number {
  const raw = readEnv(names);
  if (!raw) {
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
  const port = readStringEnv("KUBERNETES_SERVICE_PORT_HTTPS") ?? readStringEnv("KUBERNETES_SERVICE_PORT") ?? undefined;
  if (!host || !port) {
    return undefined;
  }

  return `https://${host}:${port}`;
}

function resolveKubernetesWorkloadKind(raw?: string | undefined): KubernetesWorkloadKind {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized || normalized === "deployment" || normalized === "deployments") {
    return "Deployment";
  }
  if (normalized === "statefulset" || normalized === "statefulsets") {
    return "StatefulSet";
  }

  throw new Error(`controller kubernetes scale target workload_kind must be Deployment or StatefulSet, got ${raw}.`);
}

export function kubernetesWorkloadResource(kind: KubernetesWorkloadKind): KubernetesWorkloadResource {
  if (kind === "StatefulSet") {
    return {
      kind,
      plural: "statefulsets",
      displayName: "statefulset"
    };
  }

  return {
    kind,
    plural: "deployments",
    displayName: "deployment"
  };
}

export function resolveWorkerReplicaTargetConfig(config: ServerConfig): ResolvedWorkerReplicaTargetConfig {
  const controllerConfig = (config.workers?.controller ?? {}) as NonNullable<ServerConfig["workers"]>["controller"] & {
    scale_target?: ControllerScaleTargetConfigShape | undefined;
  };
  const scaleTarget = controllerConfig.scale_target;
  const targetTypeRaw = readStringEnv("OAH_CONTROLLER_TARGET_TYPE", scaleTarget?.type ?? "noop");
  const targetType =
    targetTypeRaw === "kubernetes" ? "kubernetes" : targetTypeRaw === "docker_compose" ? "docker_compose" : "noop";
  const allowScaleDown = readBoolEnv("OAH_CONTROLLER_ALLOW_SCALE_DOWN", scaleTarget?.allow_scale_down ?? true);

  if (targetType === "noop") {
    return {
      type: "noop",
      allowScaleDown
    };
  }

  if (targetType === "docker_compose") {
    const dockerCompose = scaleTarget?.docker_compose;
    const composeFile = readStringEnv("OAH_CONTROLLER_TARGET_COMPOSE_FILE", dockerCompose?.compose_file);
    const projectName = readStringEnv("OAH_CONTROLLER_TARGET_PROJECT_NAME", dockerCompose?.project_name);
    const service = readStringEnv("OAH_CONTROLLER_TARGET_COMPOSE_SERVICE", dockerCompose?.service ?? "oah-sandbox");
    const command = readStringEnv("OAH_CONTROLLER_TARGET_COMPOSE_COMMAND", dockerCompose?.command ?? "docker") ?? "docker";
    const endpoint = readStringEnv("OAH_CONTROLLER_TARGET_COMPOSE_ENDPOINT", dockerCompose?.endpoint);
    const authToken = readStringEnv("OAH_CONTROLLER_TARGET_COMPOSE_AUTH_TOKEN", dockerCompose?.auth_token);
    const timeoutMs = readPositiveIntEnv("OAH_CONTROLLER_TARGET_COMPOSE_TIMEOUT_MS", dockerCompose?.timeout_ms ?? 5_000, 100);

    if (!service) {
      throw new Error("controller docker_compose scale target requires service.");
    }
    if (!projectName) {
      throw new Error("controller docker_compose scale target requires project_name.");
    }

    return {
      type: "docker_compose",
      allowScaleDown,
      dockerCompose: {
        ...(composeFile ? { composeFile } : {}),
        projectName,
        service,
        command,
        ...(endpoint
          ? {
              remote: {
                endpoint,
                ...(authToken ? { authToken } : {}),
                timeoutMs
              }
            }
          : {})
      }
    };
  }

  const kubernetes = scaleTarget?.kubernetes;
  const namespace = readStringEnv("OAH_CONTROLLER_TARGET_NAMESPACE", kubernetes?.namespace);
  const workloadKind = resolveKubernetesWorkloadKind(
    readStringEnv(
      "OAH_CONTROLLER_TARGET_WORKLOAD_KIND",
      kubernetes?.workload_kind ?? (kubernetes?.statefulset ? "StatefulSet" : undefined)
    )
  );
  const workloadName = readStringEnv("OAH_CONTROLLER_TARGET_WORKLOAD_NAME", kubernetes?.workload_name);
  const deployment = readStringEnv("OAH_CONTROLLER_TARGET_DEPLOYMENT", kubernetes?.deployment);
  const statefulset = readStringEnv("OAH_CONTROLLER_TARGET_STATEFULSET", kubernetes?.statefulset);
  const explicitWorkloadName =
    workloadName ?? (workloadKind === "StatefulSet" ? statefulset : deployment) ?? undefined;
  const labelSelector = readStringEnv("OAH_CONTROLLER_TARGET_LABEL_SELECTOR", kubernetes?.label_selector);
  const apiUrl = resolveKubernetesApiUrl(readStringEnv("OAH_CONTROLLER_KUBE_API_URL", kubernetes?.api_url));
  const tokenFile = readStringEnv(
    "OAH_CONTROLLER_KUBE_TOKEN_FILE",
    kubernetes?.token_file ?? "/var/run/secrets/kubernetes.io/serviceaccount/token"
  );
  const caFile = readStringEnv(
    "OAH_CONTROLLER_KUBE_CA_FILE",
    kubernetes?.ca_file ?? "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
  );
  const skipTlsVerify = readBoolEnv("OAH_CONTROLLER_KUBE_SKIP_TLS_VERIFY", kubernetes?.skip_tls_verify ?? false);

  if (!namespace) {
    throw new Error("controller kubernetes scale target requires namespace.");
  }
  if (!explicitWorkloadName && !labelSelector) {
    throw new Error("controller kubernetes scale target requires workload_name, deployment, statefulset, or label_selector.");
  }
  if (!apiUrl) {
    throw new Error("controller kubernetes scale target requires api_url or in-cluster service env.");
  }
  if (!tokenFile) {
    throw new Error("controller kubernetes scale target requires token_file.");
  }

  return {
    type: "kubernetes",
    allowScaleDown,
    kubernetes: {
      namespace,
      workloadKind,
      ...(explicitWorkloadName ? { workloadName: explicitWorkloadName } : {}),
      ...(workloadKind === "Deployment" && deployment ? { deployment } : {}),
      ...(labelSelector ? { labelSelector } : {}),
      apiUrl,
      tokenFile,
      ...(caFile ? { caFile } : {}),
      skipTlsVerify
    }
  };
}
