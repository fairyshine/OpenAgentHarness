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
COPY docs/schemas ./docs/schemas

RUN pnpm install --frozen-lockfile

RUN pnpm build

ARG BASE_RUNTIME_IMAGE
FROM ${BASE_RUNTIME_IMAGE} AS runtime

ENV NODE_ENV=production

ARG TARGETOS=linux
ARG TARGETARCH
ARG DOCKER_COMPOSE_VERSION=2.40.3

RUN corepack enable \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl docker.io \
  && mkdir -p /usr/libexec/docker/cli-plugins \
  && case "${TARGETARCH}" in \
    "amd64") compose_arch="x86_64" ;; \
    "arm64") compose_arch="aarch64" ;; \
    *) compose_arch="${TARGETARCH}" ;; \
  esac \
  && curl -fsSL "https://github.com/docker/compose/releases/download/v${DOCKER_COMPOSE_VERSION}/docker-compose-${TARGETOS}-${compose_arch}" -o /usr/libexec/docker/cli-plugins/docker-compose \
  && chmod +x /usr/libexec/docker/cli-plugins/docker-compose \
  && docker compose version \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /etc/oah \
  && mkdir -p /var/lib/oah/workspaces \
  && mkdir -p /var/lib/oah/runtimes \
  && mkdir -p /var/lib/oah/models \
  && mkdir -p /var/lib/oah/tools \
  && mkdir -p /var/lib/oah/skills \
  && mkdir -p /var/lib/oah/archives

WORKDIR /app

COPY --from=build /app /app

EXPOSE 8787 8788

CMD ["node", "apps/server/dist/index.js", "--config", "/etc/oah/server.yaml"]
