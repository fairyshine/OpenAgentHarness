#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"

IMAGE_TAG="${OAH_DAEMON_DOCKER_IMAGE:-openagentharness-local-daemon:latest}"
OAH_HOME_DIR="${OAH_HOME:-$HOME/.openagentharness}"
PLATFORM="${OAH_DAEMON_DOCKER_PLATFORM:-}"
NO_CACHE="${OAH_DAEMON_DOCKER_NO_CACHE:-0}"
KEEP_CONTEXT="${OAH_DAEMON_DOCKER_KEEP_CONTEXT:-0}"
INCLUDE_LOCAL_RELEASES="${OAH_DAEMON_DOCKER_INCLUDE_RELEASES:-0}"
INCLUDE_LOGS="${OAH_DAEMON_DOCKER_INCLUDE_LOGS:-0}"
INCLUDE_STATE="${OAH_DAEMON_DOCKER_INCLUDE_STATE:-0}"
INCLUDE_WORKSPACES="${OAH_DAEMON_DOCKER_INCLUDE_WORKSPACES:-0}"

usage() {
  cat <<'EOF'
Build a self-contained Docker image for the local OAP daemon.

Usage:
  scripts/build-daemon-docker-image.sh [options]

Options:
  -t, --tag IMAGE          Docker image tag. Default: openagentharness-local-daemon:latest
      --home PATH          OAH home to snapshot. Default: $OAH_HOME or ~/.openagentharness
      --platform PLATFORM  Docker build platform, for example linux/amd64 or linux/arm64
      --no-cache           Pass --no-cache to docker build
      --include-releases   Include local OAH_HOME versions/current/bin in the snapshot
      --include-logs       Include OAH_HOME logs in the snapshot
      --include-state      Include OAH_HOME state in the snapshot
      --include-workspaces Include OAH_HOME workspaces in the snapshot
  -h, --help               Show this help

Environment:
  OAH_DAEMON_DOCKER_IMAGE
  OAH_DAEMON_DOCKER_PLATFORM
  OAH_DAEMON_DOCKER_NO_CACHE=1
  OAH_DAEMON_DOCKER_INCLUDE_RELEASES=1
  OAH_DAEMON_DOCKER_INCLUDE_LOGS=1
  OAH_DAEMON_DOCKER_INCLUDE_STATE=1
  OAH_DAEMON_DOCKER_INCLUDE_WORKSPACES=1
  OAH_DAEMON_DOCKER_KEEP_CONTEXT=1

Run the image:
  docker run --rm -p 8787:8787 openagentharness-local-daemon:latest

The image contains a Linux daemon build from this checkout plus a snapshot of OAH_HOME.
Local release installs, logs, state, and workspaces are skipped by default because they
are often large or host-specific; use the include flags if you intentionally want them.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -t | --tag)
      IMAGE_TAG="${2:-}"
      if [ -z "$IMAGE_TAG" ]; then
        echo "Missing value for $1." >&2
        exit 1
      fi
      shift 2
      ;;
    --home)
      OAH_HOME_DIR="${2:-}"
      if [ -z "$OAH_HOME_DIR" ]; then
        echo "Missing value for --home." >&2
        exit 1
      fi
      shift 2
      ;;
    --platform)
      PLATFORM="${2:-}"
      if [ -z "$PLATFORM" ]; then
        echo "Missing value for --platform." >&2
        exit 1
      fi
      shift 2
      ;;
    --no-cache)
      NO_CACHE=1
      shift
      ;;
    --include-releases)
      INCLUDE_LOCAL_RELEASES=1
      shift
      ;;
    --include-logs)
      INCLUDE_LOGS=1
      shift
      ;;
    --include-state)
      INCLUDE_STATE=1
      shift
      ;;
    --include-workspaces)
      INCLUDE_WORKSPACES=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

need_cmd docker
need_cmd tar
need_cmd mktemp

if [ ! -d "$OAH_HOME_DIR" ]; then
  echo "OAH home does not exist: $OAH_HOME_DIR" >&2
  echo "Initialize it first with: oah daemon init" >&2
  exit 1
fi

if [ ! -f "$OAH_HOME_DIR/config/daemon.yaml" ]; then
  echo "Daemon config not found: $OAH_HOME_DIR/config/daemon.yaml" >&2
  echo "Initialize it first with: oah daemon init" >&2
  exit 1
fi

BUILD_CONTEXT="$(mktemp -d "${TMPDIR:-/tmp}/oah-daemon-docker.XXXXXX")"
cleanup() {
  if [ "$KEEP_CONTEXT" = "1" ] || [ "$KEEP_CONTEXT" = "true" ]; then
    echo "Kept build context: $BUILD_CONTEXT"
  else
    rm -rf "$BUILD_CONTEXT"
  fi
}
trap cleanup EXIT INT HUP TERM

echo "Creating source archive from $REPO_ROOT..."
COPYFILE_DISABLE=1 tar -C "$REPO_ROOT" \
  --exclude './.git' \
  --exclude './.github' \
  --exclude './.DS_Store' \
  --exclude './*/.DS_Store' \
  --exclude '*/.DS_Store' \
  --exclude './._*' \
  --exclude './*/._*' \
  --exclude '*/._*' \
  --exclude './node_modules' \
  --exclude './.native-target' \
  --exclude './native/target' \
  --exclude './.oah-runtime-bundles' \
  --exclude './release/*.sha256' \
  --exclude './release/*.tar.gz' \
  --exclude './references' \
  --exclude './site' \
  --exclude './tmp' \
  -czf "$BUILD_CONTEXT/repo.tar.gz" .

echo "Creating OAH_HOME snapshot from $OAH_HOME_DIR..."
set -- \
  --exclude './run/daemon.pid' \
  --exclude './README.md' \
  --exclude './config/README.md' \
  --exclude './models/README.md' \
  --exclude './runtimes/README.md' \
  --exclude './skills/README.md' \
  --exclude './tools/README.md' \
  --exclude './workspaces/README.md' \
  --exclude './.DS_Store' \
  --exclude './*/.DS_Store' \
  --exclude '*/.DS_Store' \
  --exclude './._*' \
  --exclude './*/._*' \
  --exclude '*/._*'
if [ "$INCLUDE_LOCAL_RELEASES" != "1" ] && [ "$INCLUDE_LOCAL_RELEASES" != "true" ]; then
  set -- "$@" --exclude './versions' --exclude './current' --exclude './bin/oah' --exclude './bin/oah.cmd'
fi
if [ "$INCLUDE_LOGS" != "1" ] && [ "$INCLUDE_LOGS" != "true" ]; then
  set -- "$@" --exclude './logs'
fi
if [ "$INCLUDE_STATE" != "1" ] && [ "$INCLUDE_STATE" != "true" ]; then
  set -- "$@" --exclude './state'
fi
if [ "$INCLUDE_WORKSPACES" != "1" ] && [ "$INCLUDE_WORKSPACES" != "true" ]; then
  set -- "$@" --exclude './workspaces'
fi

COPYFILE_DISABLE=1 tar -C "$OAH_HOME_DIR" "$@" -czf "$BUILD_CONTEXT/oah-home.tar.gz" .

cat > "$BUILD_CONTEXT/entrypoint.sh" <<'EOF'
#!/usr/bin/env sh
set -eu

export OAH_HOME="${OAH_HOME:-/root/.openagentharness}"
export OAH_DEPLOY_ROOT="${OAH_DEPLOY_ROOT:-$OAH_HOME}"
export NODE_ENV="${NODE_ENV:-production}"

OAH_CLI_ENTRY="/opt/oah/cli/dist/index.js"
OAH_SERVER_ENTRY="/opt/oah/cli/node_modules/@oah/server/dist/index.js"
OAH_CONFIG="${OAH_CONFIG:-$OAH_HOME/config/daemon.yaml}"

patch_config() {
  if [ "${OAH_DAEMON_DOCKER_PATCH_CONFIG:-1}" = "0" ] || [ "${OAH_DAEMON_DOCKER_PATCH_CONFIG:-1}" = "false" ]; then
    return
  fi

  if [ ! -f "$OAH_CONFIG" ]; then
    return
  fi

  OAH_PATCH_HOST="${OAH_BIND_HOST:-0.0.0.0}"
  OAH_PATCH_PORT="${OAH_PORT:-${PORT:-}}"
  export OAH_CONFIG OAH_PATCH_HOST OAH_PATCH_PORT

  node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from "node:fs";

const configPath = process.env.OAH_CONFIG;
let text = readFileSync(configPath, "utf8");
const eol = text.includes("\r\n") ? "\r\n" : "\n";

function patchServerScalar(key, value) {
  if (!value) {
    return;
  }

  const lines = text.split(/\r?\n/u);
  let serverIndex = lines.findIndex((line) => /^server:\s*(?:#.*)?$/u.test(line));
  if (serverIndex < 0) {
    lines.unshift(`  ${key}: ${value}`);
    lines.unshift("server:");
    text = lines.join(eol);
    return;
  }

  let insertAt = serverIndex + 1;
  for (let index = serverIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() && !/^\s/u.test(line)) {
      break;
    }
    insertAt = index + 1;
    if (new RegExp(`^\\s+${key}:\\s*`).test(line)) {
      const indent = line.match(/^\s*/u)?.[0] ?? "  ";
      lines[index] = `${indent}${key}: ${value}`;
      text = lines.join(eol);
      return;
    }
  }

  lines.splice(insertAt, 0, `  ${key}: ${value}`);
  text = lines.join(eol);
}

patchServerScalar("host", process.env.OAH_PATCH_HOST);
patchServerScalar("port", process.env.OAH_PATCH_PORT);
writeFileSync(configPath, text, "utf8");
JS
}

case "${1:-serve}" in
  serve)
    patch_config
    exec node "$OAH_SERVER_ENTRY" --config "$OAH_CONFIG"
    ;;
  oah)
    shift
    exec node "$OAH_CLI_ENTRY" "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
EOF

cat > "$BUILD_CONTEXT/oah-cli.sh" <<'EOF'
#!/usr/bin/env sh
set -eu
export OAH_HOME="${OAH_HOME:-/root/.openagentharness}"
export OAH_DEPLOY_ROOT="${OAH_DEPLOY_ROOT:-$OAH_HOME}"
exec node /opt/oah/cli/dist/index.js "$@"
EOF

cat > "$BUILD_CONTEXT/Dockerfile" <<'EOF'
FROM node:24-alpine AS build

ENV CI=1

RUN corepack enable

WORKDIR /src
COPY repo.tar.gz /tmp/repo.tar.gz
RUN tar -xzf /tmp/repo.tar.gz -C /src && rm /tmp/repo.tar.gz

RUN pnpm install --frozen-lockfile \
  && pnpm build \
  && pnpm --filter @oah/cli deploy --prod --legacy /opt/oah/cli \
  && find /opt/oah/cli -type f \( \
    -name '*.map' -o \
    -name '*.d.ts' -o \
    -name '*.d.ts.map' -o \
    -name '*.tsbuildinfo' \
  \) -delete

FROM node:24-alpine AS runtime

ENV NODE_ENV=production
ENV OAH_HOME=/root/.openagentharness
ENV OAH_DEPLOY_ROOT=/root/.openagentharness

RUN apk add --no-cache ca-certificates tini \
  && mkdir -p /opt/oah /root/.openagentharness

COPY --from=build /opt/oah/cli /opt/oah/cli
COPY oah-home.tar.gz /tmp/oah-home.tar.gz
COPY entrypoint.sh /usr/local/bin/oah-container-entrypoint
COPY oah-cli.sh /usr/local/bin/oah

RUN tar -xzf /tmp/oah-home.tar.gz -C /root/.openagentharness \
  && rm -f /tmp/oah-home.tar.gz \
  && rm -f /root/.openagentharness/run/daemon.pid \
  && find /root/.openagentharness \( -name '.DS_Store' -o -name '._*' \) -delete \
  && chmod +x /usr/local/bin/oah-container-entrypoint \
  && chmod +x /usr/local/bin/oah

WORKDIR /root
EXPOSE 8787

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/oah-container-entrypoint"]
CMD ["serve"]
EOF

build_args=""
if [ -n "$PLATFORM" ]; then
  build_args="$build_args --platform $PLATFORM"
fi
if [ "$NO_CACHE" = "1" ] || [ "$NO_CACHE" = "true" ]; then
  build_args="$build_args --no-cache"
fi

echo "Building Docker image $IMAGE_TAG..."
# shellcheck disable=SC2086
docker build $build_args -t "$IMAGE_TAG" "$BUILD_CONTEXT"

cat <<EOF

Built Docker image: $IMAGE_TAG

Run it with:
  docker run --rm -p 8787:8787 $IMAGE_TAG

Useful variants:
  docker run --rm -p 8787:8787 -e OAH_PORT=8787 $IMAGE_TAG
  docker run --rm $IMAGE_TAG oah daemon status
EOF
