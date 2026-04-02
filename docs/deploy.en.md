# Deploy and Run

This page explains the recommended local and production deployment shapes for Open Agent Harness.

## Choose a Mode First

| Scenario | Recommended mode |
| --- | --- |
| First local run | `API + embedded worker` |
| Product integration | `API + embedded worker` |
| Production-like split testing | `API only + standalone worker` |
| Multi-instance production deployment | `API only + standalone worker` |

## Runtime Modes

### `API + embedded worker`

This is the default mode.

- one `server` process is enough
- the API process hosts an embedded worker
- if Redis is configured, the embedded worker consumes the Redis queue
- if Redis is not configured, runs execute in-process

Best for:

- local development
- product integration
- PoCs
- single-node self-hosting

### `API only`

Start it with:

```bash
pnpm dev:server -- --config ./server.example.yaml --api-only
```

- starts only the API
- does not host the embedded worker
- with Redis, you should pair it with a standalone worker

### `standalone worker`

Start it with:

```bash
pnpm dev:worker -- --config ./server.example.yaml
```

- consumes the Redis run queue
- executes queued runs
- performs history mirror sync

## Recommended Local Setup

Use 3 terminals:

### Terminal 1: infrastructure

```bash
cd <project-root>
pnpm infra:up
```

### Terminal 2: backend

```bash
cd <project-root>
pnpm dev:server -- --config ./server.example.yaml
```

### Terminal 3: frontend

```bash
cd <project-root>
pnpm dev:web
```

Frontend address:

- [http://localhost:5174](http://localhost:5174)

## Production-Like Split Setup

Use 4 terminals:

1. infrastructure: `pnpm infra:up`
2. API: `pnpm dev:server -- --config ./server.example.yaml --api-only`
3. worker: `pnpm dev:worker -- --config ./server.example.yaml`
4. frontend: `pnpm dev:web`

## What To Check After Startup

1. The server logs show the selected runtime mode
2. The frontend opens successfully
3. A run does not stay in `queued` forever
4. In split mode, the worker logs show queue consumption
