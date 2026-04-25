ARG BASE_BUILD_IMAGE=node:24-alpine
ARG BASE_RUNTIME_IMAGE=alpine:3.22
ARG BASE_DOCKER_CLI_IMAGE=docker:cli
ARG BASE_RUST_IMAGE=rust:1.95-alpine

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
  && pnpm fetch --frozen-lockfile \
  && pnpm install --frozen-lockfile --offline

FROM deps AS source

COPY apps/cli ./apps/cli
COPY apps/compose-scaler ./apps/compose-scaler
COPY apps/controller ./apps/controller
COPY apps/server ./apps/server
COPY apps/worker ./apps/worker
COPY packages ./packages
COPY scripts ./scripts

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

FROM ${BASE_RUST_IMAGE} AS native-build-base

WORKDIR /app/native

RUN --mount=type=cache,target=/var/cache/apk \
  apk add --update-cache build-base cmake perl pkgconf

COPY native/Cargo.toml native/Cargo.lock ./
COPY native/oah-workspace-sync/Cargo.toml ./oah-workspace-sync/Cargo.toml
COPY native/oah-archive-export/Cargo.toml ./oah-archive-export/Cargo.toml
COPY native/oah-compose-scaler/Cargo.toml ./oah-compose-scaler/Cargo.toml

RUN mkdir -p /app/native/oah-workspace-sync/src /app/native/oah-archive-export/src \
  && mkdir -p /app/native/oah-compose-scaler/src \
  && printf 'fn main() {}\n' > /app/native/oah-workspace-sync/src/main.rs \
  && printf 'fn main() {}\n' > /app/native/oah-archive-export/src/main.rs \
  && printf 'fn main() {}\n' > /app/native/oah-compose-scaler/src/main.rs

FROM native-build-base AS native-workspace-sync-build

RUN --mount=type=cache,id=oah-native-workspace-sync-cargo-registry,target=/usr/local/cargo/registry \
  --mount=type=cache,id=oah-native-workspace-sync-cargo-git,target=/usr/local/cargo/git \
  --mount=type=cache,id=oah-native-workspace-sync-target,target=/tmp/oah-native-workspace-sync-target \
  cargo build --locked --release -p oah-workspace-sync --target-dir /tmp/oah-native-workspace-sync-target

COPY native/oah-workspace-sync/src ./oah-workspace-sync/src

RUN --mount=type=cache,id=oah-native-workspace-sync-cargo-registry,target=/usr/local/cargo/registry \
  --mount=type=cache,id=oah-native-workspace-sync-cargo-git,target=/usr/local/cargo/git \
  --mount=type=cache,id=oah-native-workspace-sync-target,target=/tmp/oah-native-workspace-sync-target \
  find /app/native/oah-workspace-sync/src -type f -exec touch {} + \
  && cargo clean --target-dir /tmp/oah-native-workspace-sync-target -p oah-workspace-sync \
  && cargo build --locked --release -p oah-workspace-sync --target-dir /tmp/oah-native-workspace-sync-target \
  && strip /tmp/oah-native-workspace-sync-target/release/oah-workspace-sync \
  && cp /tmp/oah-native-workspace-sync-target/release/oah-workspace-sync /usr/local/bin/oah-workspace-sync

FROM native-build-base AS native-compose-scaler-build

RUN --mount=type=cache,id=oah-native-compose-scaler-cargo-registry,target=/usr/local/cargo/registry \
  --mount=type=cache,id=oah-native-compose-scaler-cargo-git,target=/usr/local/cargo/git \
  --mount=type=cache,id=oah-native-compose-scaler-target,target=/tmp/oah-native-compose-scaler-target \
  cargo build --locked --release -p oah-compose-scaler --target-dir /tmp/oah-native-compose-scaler-target

COPY native/oah-compose-scaler/src ./oah-compose-scaler/src

RUN --mount=type=cache,id=oah-native-compose-scaler-cargo-registry,target=/usr/local/cargo/registry \
  --mount=type=cache,id=oah-native-compose-scaler-cargo-git,target=/usr/local/cargo/git \
  --mount=type=cache,id=oah-native-compose-scaler-target,target=/tmp/oah-native-compose-scaler-target \
  find /app/native/oah-compose-scaler/src -type f -exec touch {} + \
  && cargo clean --target-dir /tmp/oah-native-compose-scaler-target -p oah-compose-scaler \
  && cargo build --locked --release -p oah-compose-scaler --target-dir /tmp/oah-native-compose-scaler-target \
  && strip /tmp/oah-native-compose-scaler-target/release/oah-compose-scaler \
  && cp /tmp/oah-native-compose-scaler-target/release/oah-compose-scaler /usr/local/bin/oah-compose-scaler

FROM ${BASE_BUILD_IMAGE} AS node-runtime-binary

RUN apk add --no-cache binutils \
  && cp /usr/local/bin/node /tmp/node \
  && strip /tmp/node \
  && mv /tmp/node /usr/local/bin/node

FROM ${BASE_DOCKER_CLI_IMAGE} AS docker-cli-build

RUN apk add --no-cache binutils \
  && cp /usr/local/bin/docker /tmp/docker \
  && cp /usr/local/libexec/docker/cli-plugins/docker-compose /tmp/docker-compose \
  && strip /tmp/docker /tmp/docker-compose \
  && mv /tmp/docker /usr/local/bin/docker \
  && mv /tmp/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose

FROM ${BASE_RUNTIME_IMAGE} AS runtime-common

ENV NODE_ENV=production

RUN apk add --no-cache ca-certificates libgcc libstdc++ \
  && mkdir -p /etc/oah \
  && mkdir -p /usr/libexec/docker/cli-plugins

WORKDIR /app

COPY --from=node-runtime-binary /usr/local/bin/node /usr/local/bin/node

FROM runtime-common AS runtime-execution-base

ENV OAH_DOCS_ROOT=/app
ENV OAH_NATIVE_WORKSPACE_SYNC=1
ENV OAH_NATIVE_WORKSPACE_SYNC_PERSISTENT=1
ENV OAH_OBJECT_STORAGE_SYNC_BUNDLE_LAYOUT=primary
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
COPY --from=native-workspace-sync-build /usr/local/bin/oah-workspace-sync /app/native/oah-workspace-sync

EXPOSE 8787

CMD ["node", "dist/index.js", "--config", "/etc/oah/server.yaml"]

FROM runtime-execution-base AS worker-runtime

COPY --from=server-runtime-bundles /opt/oah/runtime-bundles/worker /app/dist
COPY docs/schemas /app/docs/schemas
COPY --from=native-workspace-sync-build /usr/local/bin/oah-workspace-sync /app/native/oah-workspace-sync

EXPOSE 8787

CMD ["node", "dist/worker.js", "--config", "/etc/oah/server.yaml"]

FROM runtime-common AS controller-runtime

ENV OAH_DOCS_ROOT=/app

COPY --from=controller-deploy /opt/oah/controller /app
COPY docs/schemas/server-config.schema.json /app/docs/schemas/server-config.schema.json

EXPOSE 8788

CMD ["node", "dist/index.js", "--config", "/etc/oah/server.yaml"]

FROM ${BASE_RUNTIME_IMAGE} AS compose-scaler-runtime

RUN apk add --no-cache ca-certificates \
  && mkdir -p /usr/libexec/docker/cli-plugins /app

COPY --from=docker-cli-build /usr/local/bin/docker /usr/bin/docker
COPY --from=docker-cli-build /usr/local/libexec/docker/cli-plugins/docker-compose /usr/libexec/docker/cli-plugins/docker-compose
COPY --from=native-compose-scaler-build /usr/local/bin/oah-compose-scaler /app/oah-compose-scaler

RUN chmod +x /usr/bin/docker /usr/libexec/docker/cli-plugins/docker-compose \
  && chmod +x /app/oah-compose-scaler \
  && docker compose version

EXPOSE 8790

CMD ["/app/oah-compose-scaler"]

FROM api-runtime AS runtime
