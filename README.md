# Open Agent Harness

[中文版本](./README.zh-CN.md) | English

Open Agent Harness is an enterprise-grade, headless agent runtime built for products and internal platforms that need to serve many users, sessions, and runs concurrently.

It is designed for teams that need a deployable runtime, not just an adapter layer or a single-user local agent loop: horizontally scalable API and worker processes, PostgreSQL as the source of truth, Redis-backed queues and coordination, structured audit trails, SSE streaming, and workspace-scoped capability loading.

## Why Open Agent Harness

- Enterprise-grade runtime architecture for multi-user, high-concurrency agent workloads
- Headless and embeddable: integrate it behind your own web app, desktop app, CLI, automation system, or API gateway
- Workspace-first loading of agents, models, actions, skills, external tool servers, and hooks
- Horizontal scaling with `API only + standalone worker` deployment
- Unified tool-calling projection for LLMs while keeping `action`, `skill`, `tool`, and native tools separate at the domain layer
- Structured lifecycle management for workspaces, sessions, messages, runs, audit logs, cancellation, timeouts, and recovery
- Supports both full execution workspaces and read-only chat workspaces

## What It Is

Open Agent Harness is a TypeScript + Node.js runtime kernel for running agent conversations and task execution inside a workspace.

It is responsible for:

- Managing the lifecycle of `workspace`, `session`, `message`, and `run`
- Discovering `.openharness/` configuration from workspaces
- Loading platform-level and workspace-level agents and models
- Executing shell, local scripts, `action`, `skill`, `tool`, and `hook`
- Exposing REST APIs and SSE event streams for clients and upstream services
- Coordinating queueing, reliability, and distributed workers
- Mirroring workspace history into a local `.openharness/data/history.db` database

The repository also includes:

- `apps/web`: a React 19 debugging console for `workspace / session / message / run / SSE` flows
- `apps/cli`: a reserved CLI / TUI entrypoint

These are debugging surfaces, not the product boundary. The core product remains a headless runtime.

## What It Is Not

Open Agent Harness does not try to be:

- A full SaaS product with user accounts, organizations, billing, and admin back office
- A code hosting platform, CI/CD system, or secret-management product
- A public zero-trust sandbox platform
- A UI-first chat application

Identity, authentication, organization membership, and access policy are expected to come from your upstream gateway or external services. Open Agent Harness consumes caller context and uses references such as `subject_ref` for audit, rate limiting, and access decisions.

## Architecture Highlights

- `PostgreSQL`: system of record for sessions, messages, runs, tool calls, and audit data
- `Redis`: queues, locks, rate-limit counters, and short-lived event coordination
- `.openharness/data/history.db`: asynchronous local history mirror for backup and offline inspection
- Default runtime mode: `API + embedded worker`
- Production runtime mode: `API only + standalone worker`
- Execution backend abstraction from day one, with room for future sandbox or remote executors

Design principles:

- `Workspace First`
- `Session Serial, System Parallel`
- `Domain Separate, Invocation Unified`
- `Local First, Sandbox Ready`
- `Identity Externalized`
- `Auditable by Default`

## Technical Architecture

```text
Clients / Upstream Systems
  Web App / Desktop App / CLI / Automation / Internal Services
                  |
                  v
        API Gateway + SSE Streaming
                  |
                  v
         Session Orchestrator / Run Engine
      (session lifecycle, queueing, cancellation,
       timeout, recovery, audit, event emission)
                  |
      +-----------+-----------+-----------+-----------+
      |                       |                       |
      v                       v                       v
 Context Engine        Invocation Dispatcher      Hook Runtime
 (workspace loading,   (maps LLM tool calls       (lifecycle and
 agent/model/action/    to native tools /          interceptor
 skill/tool assembly)   action / skill / tool)     extensions)
      |                       |                       |
      +-----------------------+-----------------------+
                              |
                              v
                    Execution Backend Abstraction
                 (local backend today, sandbox/remote
                    executors can be added later)
                              |
          +-------------------+-------------------+------------------+
          |                   |                   |                  |
          v                   v                   v                  v
     Native Tools          Actions              Skills      External Tool Servers

Data / Coordination Layer
  PostgreSQL  -> source of truth for sessions, messages, runs, audit
  Redis       -> queues, locks, fanout events, distributed coordination
  history.db  -> per-workspace local history mirror for backup/inspection

Deployment Modes
  1. API + embedded worker
  2. API only + standalone worker
```

## Workspace Model

Open Agent Harness supports two workspace kinds:

- `project`: a normal workspace with tools, execution, and local history mirror
- `chat`: a read-only conversation workspace with static prompts, agents, and models only; directories under `paths.chat_dir` are directly usable workspaces and can also be managed as reusable presets

Example structure:

```text
workspace/
  AGENTS.md
  .openharness/
    settings.yaml
    data/
      history.db
    agents/
      builder.md
    models/
      openai.yaml
    actions/
      test-run/
        ACTION.yaml
    skills/
      repo-explorer/
        SKILL.md
    tools/
      settings.yaml
      servers/
        docs-server/
    hooks/
      redact-secrets.yaml
```

Copyable examples live in [templates/README.md](./templates/README.md):

- `templates/workspace`
- `templates/chat-workspace`

## Quick Start

Install dependencies:

```bash
pnpm install
```

Start local PostgreSQL and Redis:

```bash
pnpm infra:up
```

Build and test:

```bash
pnpm build
pnpm test
pnpm test:dist
```

Run the default local backend:

```bash
pnpm dev:server -- --config ./server.example.yaml
```

Run a single workspace directly:

```bash
pnpm dev:server -- \
  --workspace /absolute/path/to/workspace \
  --model-dir /absolute/path/to/models \
  --default-model openai-default
```

Run the standalone worker:

```bash
pnpm dev:worker -- --config ./server.example.yaml
```

Run the debugging web console:

```bash
pnpm dev:web
```

Default example config:

```yaml
server:
  host: 127.0.0.1
  port: 8787

storage:
  # postgres_url: ${env.DATABASE_URL}
  # redis_url: ${env.REDIS_URL}

paths:
  workspace_dir: ./tmp/workspaces
  chat_dir: ./tmp/chat-workspaces
  template_dir: ./tmp/templates
  model_dir: ./tests/fixtures/models
  tool_dir: ./tmp/tools
  skill_dir: ./tmp/skills

llm:
  default_model: openai-default
```

## Runtime Modes

### `API + embedded worker`

- Default mode
- Best for local development, PoC, and single-node self-hosting
- If Redis is configured, the embedded worker consumes the Redis queue
- If Redis is not configured, runs execute in-process

### `API only`

- Explicitly enabled with `--api-only` or `--no-worker`
- Best for production split deployment
- When Redis is configured, use it together with standalone workers

### `standalone worker`

- Separate worker process
- Consumes the Redis run queue
- Executes queued runs and history mirror sync
- Best for horizontal scaling and resource isolation

### `single workspace`

- Enabled by passing `--workspace`
- Boots exactly one workspace and serves it as a dedicated backend
- Useful for an `opencode`-style deployment around one repo or one read-only chat workspace
- Reuses the same HTTP API and runtime core
- Disables workspace template listing, workspace creation/import, and workspace deletion routes

## Documentation

Detailed design docs are currently primarily in Chinese.

- [docs/README.md](./docs/README.md)
- [docs/deploy.md](./docs/deploy.md)
- [docs/architecture-overview.md](./docs/architecture-overview.md)
- [docs/workspace/README.md](./docs/workspace/README.md)
- [docs/runtime/README.md](./docs/runtime/README.md)
- [docs/openapi/README.md](./docs/openapi/README.md)

## Development Commands

```bash
pnpm install
pnpm infra:up
pnpm build
pnpm test
pnpm test:dist
pnpm dev:server
pnpm dev:worker
pnpm dev:web
```
