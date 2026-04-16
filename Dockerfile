FROM node:24-bookworm AS build

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

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production

RUN corepack enable \
  && mkdir -p /etc/oah \
  && mkdir -p /var/lib/oah/workspaces \
  && mkdir -p /var/lib/oah/blueprints \
  && mkdir -p /var/lib/oah/models \
  && mkdir -p /var/lib/oah/tools \
  && mkdir -p /var/lib/oah/skills \
  && mkdir -p /var/lib/oah/archives

WORKDIR /app

COPY --from=build /app /app

EXPOSE 8787 8788

CMD ["node", "apps/server/dist/index.js", "--config", "/etc/oah/server.yaml"]
