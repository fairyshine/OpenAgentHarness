ARG BASE_BUILD_IMAGE=node:24-bookworm
ARG BASE_RUNTIME_IMAGE=debian:bookworm-slim
ARG BASE_RUST_IMAGE=rust:1.95-bookworm
ARG DOCKER_COMPOSE_VERSION=2.40.3

FROM ${BASE_BUILD_IMAGE} AS deps

LABEL org.opencontainers.image.title="Open Agent Harness" \
      org.opencontainers.image.description="Production image for split-deployed Open Agent Harness." \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.source="https://github.com/fairyshine/OpenAgentHarness" \
      org.opencontainers.image.url="https://github.com/fairyshine/OpenAgentHarness" \
      org.opencontainers.image.documentation="https://github.com/fairyshine/OpenAgentHarness#readme" \
      org.opencontainers.image.licenses="UNLICENSED" \
      org.opencontainers.image.vendor="fairyshine"

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

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm config set store-dir /pnpm/store \
  && pnpm fetch --frozen-lockfile

FROM deps AS source

COPY apps/cli ./apps/cli
COPY apps/compose-scaler ./apps/compose-scaler
COPY apps/controller ./apps/controller
COPY apps/server ./apps/server
COPY apps/worker ./apps/worker
COPY packages ./packages
COPY scripts ./scripts

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm config set store-dir /pnpm/store \
  && pnpm install --frozen-lockfile --offline

FROM source AS controller-build

RUN pnpm exec tsc -b apps/controller/tsconfig.json

FROM source AS server-runtime-bundles

RUN node ./scripts/build-runtime-bundles.mjs /opt/oah/runtime-bundles

FROM controller-build AS controller-deploy

RUN pnpm --filter @oah/controller deploy --legacy --prod /opt/oah/controller \
  && find /opt/oah/controller/dist -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -delete \
  && find /opt/oah/controller/node_modules -type f \( \
    -name '*.map' -o \
    -name '*.d.ts' -o \
    -name '*.d.mts' -o \
    -name '*.d.cts' -o \
    -name '*.ts' -o \
    -name '*.tsx' -o \
    -name '*.mts' -o \
    -name '*.cts' -o \
    -iname 'README*' -o \
    -iname 'CHANGELOG*' \
  \) -delete \
  && find /opt/oah/controller/node_modules -type d \( \
    -name docs -o \
    -name test -o \
    -name tests -o \
    -name __tests__ -o \
    -name example -o \
    -name examples \
  \) -prune -exec rm -rf {} + \
  && find /opt/oah/controller/node_modules/.pnpm -path '*/node_modules/@oah/*/src' -prune -exec rm -rf {} + \
  && find /opt/oah/controller/node_modules/.pnpm \( \
    -name 'tsconfig.json' -o \
    -name 'tsconfig.*.json' -o \
    -name '*.tsbuildinfo' \
  \) -delete \
  && find /opt/oah/controller/node_modules -type d -empty -delete \
  && rm -rf /opt/oah/controller/src

FROM source AS compose-scaler-build

RUN pnpm exec tsc -b apps/compose-scaler/tsconfig.json

FROM compose-scaler-build AS compose-scaler-deploy

RUN pnpm --filter @oah/compose-scaler deploy --legacy --prod /opt/oah/compose-scaler \
  && find /opt/oah/compose-scaler/dist -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -delete \
  && find /opt/oah/compose-scaler/node_modules -type f \( \
    -name '*.map' -o \
    -name '*.d.ts' -o \
    -name '*.d.mts' -o \
    -name '*.d.cts' -o \
    -name '*.ts' -o \
    -name '*.tsx' -o \
    -name '*.mts' -o \
    -name '*.cts' -o \
    -iname 'README*' -o \
    -iname 'CHANGELOG*' \
  \) -delete \
  && find /opt/oah/compose-scaler/node_modules -type d \( \
    -name docs -o \
    -name test -o \
    -name tests -o \
    -name __tests__ -o \
    -name example -o \
    -name examples \
  \) -prune -exec rm -rf {} + \
  && find /opt/oah/compose-scaler/node_modules/.pnpm -path '*/node_modules/@oah/*/src' -prune -exec rm -rf {} + \
  && find /opt/oah/compose-scaler/node_modules/.pnpm \( \
    -name 'tsconfig.json' -o \
    -name 'tsconfig.*.json' -o \
    -name '*.tsbuildinfo' \
  \) -delete \
  && find /opt/oah/compose-scaler/node_modules -type d -empty -delete \
  && rm -rf /opt/oah/compose-scaler/src

FROM ${BASE_RUST_IMAGE} AS native-build

WORKDIR /app/native

COPY native ./ 

RUN --mount=type=cache,target=/usr/local/cargo/registry \
  --mount=type=cache,target=/tmp/oah-native-target \
  cargo build --locked --release -p oah-workspace-sync --target-dir /tmp/oah-native-target \
  && strip --strip-unneeded /tmp/oah-native-target/release/oah-workspace-sync \
  && cp /tmp/oah-native-target/release/oah-workspace-sync /usr/local/bin/oah-workspace-sync

FROM deps AS node-runtime-binary

RUN strip --strip-unneeded /usr/local/bin/node

FROM debian:bookworm-slim AS docker-cli-build

RUN apt-get update \
  && apt-get install -y --no-install-recommends docker.io \
  && rm -rf /var/lib/apt/lists/*

FROM docker/compose-bin:v${DOCKER_COMPOSE_VERSION} AS docker-compose-bin

FROM ${BASE_RUNTIME_IMAGE} AS runtime-common

ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates libstdc++6 \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /etc/oah \
  && mkdir -p /usr/libexec/docker/cli-plugins

WORKDIR /app

COPY --from=node-runtime-binary /usr/local/bin/node /usr/local/bin/node

FROM runtime-common AS runtime-execution-base

ENV OAH_DOCS_ROOT=/app
ENV OAH_NATIVE_WORKSPACE_SYNC_BINARY=/app/native/oah-workspace-sync

RUN mkdir -p /var/lib/oah/workspaces \
  && mkdir -p /var/lib/oah/runtimes \
  && mkdir -p /var/lib/oah/models \
  && mkdir -p /var/lib/oah/tools \
  && mkdir -p /var/lib/oah/skills \
  && mkdir -p /var/lib/oah/archives \
  && mkdir -p /app/native \
  && printf '%s\n' '{"type":"module"}' > /app/package.json

FROM runtime-execution-base AS api-runtime

COPY --from=server-runtime-bundles /opt/oah/runtime-bundles/api /app/dist
COPY docs/schemas /app/docs/schemas
COPY docs/openapi /app/docs/openapi
COPY assets/logo-readme.png /app/assets/logo-readme.png
COPY --from=native-build /usr/local/bin/oah-workspace-sync /app/native/oah-workspace-sync

EXPOSE 8787

CMD ["node", "dist/index.js", "--config", "/etc/oah/server.yaml"]

FROM runtime-execution-base AS worker-runtime

COPY --from=server-runtime-bundles /opt/oah/runtime-bundles/worker /app/dist
COPY docs/schemas /app/docs/schemas
COPY --from=native-build /usr/local/bin/oah-workspace-sync /app/native/oah-workspace-sync

EXPOSE 8787

CMD ["node", "dist/worker.js", "--config", "/etc/oah/server.yaml"]

FROM runtime-common AS controller-runtime

ENV OAH_DOCS_ROOT=/app

COPY --from=controller-deploy /opt/oah/controller /app
COPY docs/schemas/server-config.schema.json /app/docs/schemas/server-config.schema.json

EXPOSE 8788

CMD ["node", "dist/index.js", "--config", "/etc/oah/server.yaml"]

FROM runtime-common AS compose-scaler-runtime

COPY --from=docker-cli-build /usr/bin/docker /usr/bin/docker
COPY --from=docker-compose-bin /docker-compose /usr/libexec/docker/cli-plugins/docker-compose

RUN chmod +x /usr/bin/docker /usr/libexec/docker/cli-plugins/docker-compose \
  && docker compose version

COPY --from=compose-scaler-deploy /opt/oah/compose-scaler /app

EXPOSE 8790

CMD ["node", "dist/index.js"]

FROM api-runtime AS runtime
