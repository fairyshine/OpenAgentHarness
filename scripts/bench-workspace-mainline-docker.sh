#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_TAG="${OAH_BENCH_DOCKER_IMAGE_TAG:-oah-workspace-mainline-bench:local}"
CONTAINER_CPUS="${OAH_BENCH_DOCKER_CPUS:-2}"
CONTAINER_MEMORY="${OAH_BENCH_DOCKER_MEMORY:-2g}"

export DOCKER_BUILDKIT="${DOCKER_BUILDKIT:-1}"

docker build \
  -f - \
  -t "${IMAGE_TAG}" \
  "${ROOT_DIR}" <<'EOF'
FROM rust:1.95-alpine AS native-build

RUN apk add --no-cache build-base cmake perl pkgconf

WORKDIR /app

COPY native ./native

RUN --mount=type=cache,target=/usr/local/cargo/registry \
  --mount=type=cache,target=/usr/local/cargo/git \
  --mount=type=cache,target=/app/.native-target \
  cargo build --manifest-path ./native/Cargo.toml --target-dir /app/.native-target --release -p oah-workspace-sync

FROM node:24-alpine

RUN apk add --no-cache ca-certificates

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY apps/cli/package.json ./apps/cli/package.json
COPY apps/compose-scaler/package.json ./apps/compose-scaler/package.json
COPY apps/controller/package.json ./apps/controller/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/api-contracts/package.json ./packages/api-contracts/package.json
COPY packages/config/package.json ./packages/config/package.json
COPY packages/config-server-control/package.json ./packages/config-server-control/package.json
COPY packages/engine-core/package.json ./packages/engine-core/package.json
COPY packages/model-gateway/package.json ./packages/model-gateway/package.json
COPY packages/native-bridge/package.json ./packages/native-bridge/package.json
COPY packages/scale-target-control/package.json ./packages/scale-target-control/package.json
COPY packages/storage-memory/package.json ./packages/storage-memory/package.json
COPY packages/storage-postgres/package.json ./packages/storage-postgres/package.json
COPY packages/storage-redis/package.json ./packages/storage-redis/package.json
COPY packages/storage-redis-control/package.json ./packages/storage-redis-control/package.json
COPY packages/storage-sqlite/package.json ./packages/storage-sqlite/package.json

RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
  pnpm config set store-dir /root/.local/share/pnpm/store \
  && pnpm fetch --frozen-lockfile

COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts

COPY --from=native-build /app/.native-target/release/oah-workspace-sync /app/.native-target/release/oah-workspace-sync

RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
  pnpm config set store-dir /root/.local/share/pnpm/store \
  && pnpm install --frozen-lockfile --offline

ENV OAH_NATIVE_WORKSPACE_SYNC_BINARY=/app/.native-target/release/oah-workspace-sync

ENTRYPOINT ["pnpm", "exec", "tsx", "scripts/bench-workspace-mainline.ts"]
EOF

docker run --rm \
  --cpus="${CONTAINER_CPUS}" \
  --memory="${CONTAINER_MEMORY}" \
  "${IMAGE_TAG}" \
  "$@"
