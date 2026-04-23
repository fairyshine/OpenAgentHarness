ARG BASE_BUILD_IMAGE=node:24-bookworm
ARG BASE_RUNTIME_IMAGE=node:24-bookworm-slim

FROM ${BASE_BUILD_IMAGE} AS build

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
COPY apps ./apps
COPY packages ./packages
COPY assets/logo-readme.png ./assets/logo-readme.png
COPY docs/openapi ./docs/openapi
COPY docs/schemas ./docs/schemas

RUN pnpm install --frozen-lockfile

RUN pnpm build

RUN pnpm --filter @oah/server deploy --legacy --prod /opt/oah/server \
  && pnpm --filter @oah/controller deploy --legacy --prod /opt/oah/controller \
  && find /opt/oah/server/dist /opt/oah/controller/dist -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -delete \
  && rm -rf /opt/oah/server/src /opt/oah/controller/src

FROM ${BASE_RUNTIME_IMAGE} AS runtime-base

ENV NODE_ENV=production
ENV OAH_DOCS_ROOT=/app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /etc/oah \
  && mkdir -p /var/lib/oah/workspaces \
  && mkdir -p /var/lib/oah/runtimes \
  && mkdir -p /var/lib/oah/models \
  && mkdir -p /var/lib/oah/tools \
  && mkdir -p /var/lib/oah/skills \
  && mkdir -p /var/lib/oah/archives

WORKDIR /app

FROM runtime-base AS api-runtime

COPY --from=build /opt/oah/server /app
COPY --from=build /app/docs/openapi /app/docs/openapi
COPY --from=build /app/assets/logo-readme.png /app/assets/logo-readme.png

EXPOSE 8787

CMD ["node", "dist/index.js", "--config", "/etc/oah/server.yaml"]

FROM runtime-base AS worker-runtime

COPY --from=build /opt/oah/server /app
COPY --from=build /app/docs/openapi /app/docs/openapi
COPY --from=build /app/assets/logo-readme.png /app/assets/logo-readme.png

EXPOSE 8787

CMD ["node", "dist/worker.js", "--config", "/etc/oah/server.yaml"]

FROM runtime-base AS controller-runtime

ARG TARGETOS=linux
ARG TARGETARCH
ARG DOCKER_COMPOSE_VERSION=2.40.3

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl docker.io \
  && mkdir -p /usr/libexec/docker/cli-plugins \
  && case "${TARGETARCH}" in \
    "amd64") compose_arch="x86_64" ;; \
    "arm64") compose_arch="aarch64" ;; \
    *) compose_arch="${TARGETARCH}" ;; \
  esac \
  && curl -fsSL "https://github.com/docker/compose/releases/download/v${DOCKER_COMPOSE_VERSION}/docker-compose-${TARGETOS}-${compose_arch}" -o /usr/libexec/docker/cli-plugins/docker-compose \
  && chmod +x /usr/libexec/docker/cli-plugins/docker-compose \
  && docker compose version \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /opt/oah/controller /app

EXPOSE 8788

CMD ["node", "dist/index.js", "--config", "/etc/oah/server.yaml"]

FROM api-runtime AS runtime
