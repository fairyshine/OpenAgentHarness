# Quick Start

This page is the shortest path to getting Open Agent Harness running locally.

## Choose a Path

| Goal | Recommended path |
| --- | --- |
| Run the project end-to-end | Follow this page from top to bottom |
| Understand deployment modes first | Read [Deploy and Run](./deploy.md) |
| Only preview the docs site | Jump to [Preview the Docs Site](#7-preview-the-docs-site) |

!!! tip

    If this is your first time, the easiest path is: `pnpm infra:up` -> `pnpm dev:server -- --config ./server.example.yaml` -> `pnpm dev:web`.

## 1. Prerequisites

Make sure you have:

- `Node.js 20+`
- `pnpm 10+`
- `Docker` and `docker compose`
- `Python 3.10+` if you want to preview the docs site locally

Install dependencies:

```bash
pnpm install
```

Run commands from the repository root:

```bash
cd <project-root>
```

## 2. Start Local Infrastructure

The project uses PostgreSQL and Redis in development:

```bash
pnpm infra:up
```

Stop local infrastructure:

```bash
pnpm infra:down
```

## 3. Start the Runtime

The simplest option is to start the server with the embedded worker:

```bash
pnpm dev:server -- --config ./server.example.yaml
```

If you want to simulate production-style split deployment:

```bash
pnpm dev:server -- --config ./server.example.yaml --api-only
pnpm dev:worker -- --config ./server.example.yaml
```

How to choose:

- For local development and integration work, use the default `server`
- For production-like testing, use `--api-only` plus a standalone `worker`

## 4. Start the Debug Web Console

```bash
pnpm dev:web
```

Default address:

- [http://localhost:5174](http://localhost:5174)

If your backend is not on the default address:

```bash
OAH_WEB_PROXY_TARGET=http://127.0.0.1:8787 pnpm dev:web
```

## 5. How To Confirm It Works

After startup, quickly check:

1. The backend logs show the current runtime mode
2. The frontend opens at [http://localhost:5174](http://localhost:5174)
3. A message can move a run from `queued` into execution
4. In split mode, the worker logs show queue consumption

## 6. Build and Test

```bash
pnpm build
pnpm test
pnpm test:dist
```

## 7. Preview the Docs Site

The docs site uses `mkdocs-material` plus i18n support:

```bash
python3 -m pip install -r docs/requirements.txt
mkdocs serve
```

Typical local docs address:

- [http://127.0.0.1:8000/OpenAgentHarness/](http://127.0.0.1:8000/OpenAgentHarness/)

Build the static site:

```bash
mkdocs build --strict
```

## 8. Recommended Reading Order

1. [Home](./index.md)
2. [Overview](./design-overview.md)
3. [Architecture Overview](./architecture-overview.md)
4. [Deploy and Run](./deploy.md)
5. [Workspace Overview](./workspace/README.md)
6. [Runtime Overview](./runtime/README.md)
7. [OpenAPI Overview](./openapi/README.md)
