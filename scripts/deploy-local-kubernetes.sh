#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KUBECTL="${KUBECTL:-kubectl}"
OVERLAY="${OAH_K8S_OVERLAY:-$ROOT_DIR/deploy/local-kubernetes}"
NAMESPACE="${OAH_K8S_NAMESPACE:-open-agent-harness}"
ACTION="${1:-apply}"
MINIO_BUCKET="${OAH_K8S_MINIO_BUCKET:-oah-dev}"
PORT_FORWARD_PIDS=()

cleanup_port_forwards() {
  if ((${#PORT_FORWARD_PIDS[@]} == 0)); then
    return
  fi

  local pid
  for pid in "${PORT_FORWARD_PIDS[@]}"; do
    kill "$pid" >/dev/null 2>&1 || true
  done
}

trap cleanup_port_forwards EXIT

usage() {
  cat <<'USAGE'
Usage: scripts/deploy-local-kubernetes.sh [apply|delete|status|port-forward]

Environment:
  KUBECTL          kubectl binary to use
  OAH_K8S_OVERLAY  kustomize overlay path
  OAH_K8S_NAMESPACE namespace to inspect after deploy
  OAH_K8S_WAIT     set to 0 to skip rollout waits on apply
  OAH_DEPLOY_ROOT   deploy-root containing runtimes/models/tools/skills
  OAH_HOME          fallback deploy-root, defaults to ~/.openagentharness
  OAH_K8S_SKIP_ASSET_SYNC set to 1 to skip syncing readonly assets to MinIO
  OAH_K8S_API_FORWARD_PORT local API port for port-forward, defaults to 8787
  OAH_K8S_PORT_FORWARD_VERBOSE set to 1 to show kubectl per-connection logs
USAGE
}

render() {
  "$KUBECTL" kustomize --load-restrictor LoadRestrictionsNone "$OVERLAY"
}

port_is_free() {
  ! (echo >"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1
}

find_minio_forward_port() {
  if [[ -n "${OAH_K8S_MINIO_FORWARD_PORT:-}" ]]; then
    echo "$OAH_K8S_MINIO_FORWARD_PORT"
    return
  fi

  local port
  for port in $(seq 19000 19030); do
    if port_is_free "$port"; then
      echo "$port"
      return
    fi
  done

  echo "No free local port found for MinIO port-forward in range 19000-19030." >&2
  exit 1
}

wait_for_http() {
  local url="$1"
  local label="$2"
  local attempt
  for attempt in $(seq 1 60); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done

  echo "Timed out waiting for $label at $url." >&2
  exit 1
}

resolve_deploy_root() {
  printf '%s\n' "${OAH_DEPLOY_ROOT:-${OAH_HOME:-$HOME/.openagentharness}}"
}

read_default_model() {
  local deploy_root="$1"
  local config_path="${OAH_K8S_SERVER_CONFIG:-$deploy_root/config/kubernetes.server.yaml}"
  if [[ ! -f "$config_path" ]]; then
    return
  fi

  awk '
    /^[^[:space:]]/ { in_llm = 0 }
    /^llm:[[:space:]]*$/ { in_llm = 1; next }
    in_llm && /^[[:space:]]+default_model:[[:space:]]*/ {
      sub(/^[[:space:]]+default_model:[[:space:]]*/, "")
      gsub(/^["'\'']|["'\'']$/, "")
      print
      exit
    }
  ' "$config_path"
}

apply_local_config_overrides() {
  local deploy_root
  deploy_root="$(resolve_deploy_root)"
  local default_model
  default_model="$(read_default_model "$deploy_root")"
  if [[ -z "$default_model" ]]; then
    return
  fi

  local encoded_default_model
  encoded_default_model="$(printf '%s' "$default_model" | base64 | tr -d '\n')"
  "$KUBECTL" patch secret oah-storage -n "$NAMESPACE" --type merge \
    -p "{\"data\":{\"OAH_DEFAULT_MODEL\":\"$encoded_default_model\"}}" >/dev/null
  echo "Using K8S default model from deploy root config: $default_model"
}

sync_readonly_assets() {
  if [[ "${OAH_K8S_SKIP_ASSET_SYNC:-0}" == "1" ]]; then
    echo "Skipping K8S readonly asset sync because OAH_K8S_SKIP_ASSET_SYNC=1."
    return
  fi

  local deploy_root
  deploy_root="$(resolve_deploy_root)"
  if [[ ! -d "$deploy_root" ]]; then
    echo "Deploy root not found for K8S asset sync: $deploy_root" >&2
    echo "Set OAH_DEPLOY_ROOT or OAH_HOME to a directory containing runtimes/models/tools/skills." >&2
    exit 1
  fi

  local port
  port="$(find_minio_forward_port)"
  local log_file
  log_file="$(mktemp "${TMPDIR:-/tmp}/oah-k8s-minio-port-forward.XXXXXX")"

  "$KUBECTL" port-forward -n "$NAMESPACE" svc/minio "$port:9000" >"$log_file" 2>&1 &
  local port_forward_pid=$!
  PORT_FORWARD_PIDS+=("$port_forward_pid")

  wait_for_http "http://127.0.0.1:$port/minio/health/live" "MinIO port-forward"

  local endpoint="${OAH_K8S_STORAGE_SYNC_ENDPOINT:-}"
  local docker_network="${OAH_STORAGE_SYNC_DOCKER_NETWORK:-}"
  if [[ -z "$endpoint" ]]; then
    if [[ "$(uname -s)" == "Linux" ]]; then
      endpoint="http://127.0.0.1:$port"
      docker_network="${docker_network:-host}"
    else
      endpoint="http://host.docker.internal:$port"
    fi
  fi

  echo "Syncing K8S readonly assets from $deploy_root to s3://$MINIO_BUCKET/{runtime,model,tool,skill}/"
  OAH_STORAGE_SYNC_DOCKER_NETWORK="$docker_network" \
    node "$ROOT_DIR/scripts/storage-sync.mjs" \
      --root "$deploy_root" \
      --bucket "$MINIO_BUCKET" \
      --aws-endpoint-url "$endpoint" \
      --access-key "${MINIO_ROOT_USER:-oahadmin}" \
      --secret-key "${MINIO_ROOT_PASSWORD:-oahadmin123}" \
      --region "${AWS_REGION:-us-east-1}" \
      --delete
}

require_cluster() {
  if ! "$KUBECTL" get --raw=/readyz >/dev/null 2>&1; then
    local context
    context="$("$KUBECTL" config current-context 2>/dev/null || true)"
    echo "Kubernetes API is not reachable${context:+ for context '$context'}." >&2
    if [[ "$context" == "orbstack" ]] && command -v orbctl >/dev/null 2>&1; then
      echo "For OrbStack, run: orbctl start k8s" >&2
    fi
    echo "Start or select a Kubernetes cluster, then rerun this script." >&2
    exit 1
  fi
}

wait_for_rollout() {
  "$KUBECTL" rollout status deploy/postgres -n "$NAMESPACE" --timeout=120s
  "$KUBECTL" rollout status deploy/redis -n "$NAMESPACE" --timeout=120s
  "$KUBECTL" rollout status deploy/minio -n "$NAMESPACE" --timeout=120s
  "$KUBECTL" wait --for=condition=complete job/minio-create-oah-dev-bucket -n "$NAMESPACE" --timeout=180s

  sync_readonly_assets

  "$KUBECTL" rollout restart deploy/oah-api deploy/oah-sandbox deploy/oah-controller -n "$NAMESPACE"
  "$KUBECTL" rollout status deploy/oah-api -n "$NAMESPACE" --timeout=180s
  "$KUBECTL" rollout status deploy/oah-sandbox -n "$NAMESPACE" --timeout=180s
  "$KUBECTL" rollout status deploy/oah-controller -n "$NAMESPACE" --timeout=180s
}

port_forward_api() {
  local local_port="${OAH_K8S_API_FORWARD_PORT:-8787}"

  if [[ "${OAH_K8S_PORT_FORWARD_VERBOSE:-0}" == "1" ]]; then
    "$KUBECTL" port-forward -n "$NAMESPACE" svc/oah-api "$local_port:8787"
    return
  fi

  "$KUBECTL" port-forward -n "$NAMESPACE" svc/oah-api "$local_port:8787" 2>&1 | awk -v port="$local_port" '
    $0 != "Handling connection for " port {
      print
      fflush()
    }
  '
}

case "$ACTION" in
  apply | up)
    require_cluster
    render | "$KUBECTL" apply -f -
    apply_local_config_overrides
    if [[ "${OAH_K8S_WAIT:-1}" != "0" ]]; then
      wait_for_rollout
    fi
    "$KUBECTL" get pods,deploy,svc,job -n "$NAMESPACE"
    ;;
  delete | down)
    require_cluster
    render | "$KUBECTL" delete -f - --ignore-not-found
    ;;
  status)
    require_cluster
    "$KUBECTL" get pods,deploy,svc,job -n "$NAMESPACE"
    ;;
  port-forward)
    require_cluster
    port_forward_api
    ;;
  help | -h | --help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
