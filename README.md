<h1 align="center">Open Agent Harness</h1>

<p align="center">
  Headless, workspace-first agent runtime for teams building agent products, internal AI platforms, and embedded copilots.
</p>

<p align="center">
  <a href="./README.zh-CN.md">中文版本</a> · <a href="./docs/getting-started.en.md">Getting Started</a> · <a href="./docs/README.md">Documentation</a>
</p>

---

## What is Open Agent Harness?

Open Agent Harness is a **deployable backend runtime** that handles agent conversations and task execution. You bring your own frontend, auth, and product experience — the runtime handles everything underneath.

**Build your own agent product on top of a reusable runtime, instead of rebuilding the runtime itself.**

> Not a ready-made chat UI. Not an identity system. Not a SaaS control plane.
> It is the programmable kernel that sits behind all of those.

## Web Console

The project ships with a debug web console for development and inspection:

<p align="center">
  <img src="assets/web-console-screenshot.png" width="820" alt="Web Console Screenshot" />
</p>

The console provides:
- **Conversation view** with streaming, tool call chips, and run tracking
- **Inspector** showing model-facing messages, tools, run steps, and runtime traces
- **Storage workbench** for PostgreSQL and Redis, including structured `messages.content` inspection

## Architecture

The runtime is organized into clear layers:

| Layer | Responsibility |
| --- | --- |
| **API Gateway** | OpenAPI entry point, parameter validation, access control, SSE streaming |
| **Session Orchestrator** | Run creation, per-session serial scheduling, cancellation, timeout, failure recovery |
| **Context Engine** | Assembles prompts, history, agent config, and capability catalog at run start |
| **LLM Loop + Dispatcher** | Model inference, tool calling, routing, and result backfill |
| **Execution Backend** | Local directory-level execution (swappable to container/VM/remote sandbox) |
| **Storage** | PostgreSQL (source of truth) + Redis (queues, locks, SSE) + local history mirror |

## Workspace-First Design

The **workspace** is the core customization boundary. A single runtime can host many workspaces, each with its own:

- Agents and prompt strategies
- Skills, actions, and tools
- Hooks and lifecycle policies
- Model configurations
- Tool servers (local or remote)

Two workspaces on the same runtime can behave completely differently for different teams, repos, or product scenarios.

| Workspace Type | Description |
| --- | --- |
| **`project`** | Writable, executable — enables shell, actions, skills, tools, and hooks |
| **`chat`** | Read-only conversation mode — no file modifications, no execution tools |

## Capability Model

Each capability layer stays separate so you can compose them differently per workspace:

| Capability | Purpose |
| --- | --- |
| `agent` | Defines role, behavior, and permissions of a working persona |
| `primary agent` / `subagent` | User-facing specialists and delegated background specialists |
| `tool` | Built-in or external execution capabilities for agents |
| `skill` | Reusable know-how packaged for a class of tasks |
| `action` | Stable named tasks that users, APIs, or agents can trigger |
| `hook` | Lifecycle interception, policy, and extension logic around runtime events |
| `context` | Controls how prompts and workspace instructions are assembled for the model |

## Quick Start

```bash
# Install dependencies
pnpm install

# Start infrastructure (PostgreSQL + Redis)
pnpm infra:up

# Start the backend server
pnpm dev:server -- --config ./server.example.yaml

# Start the web console (in another terminal)
pnpm dev:web
```

**Local addresses:**

| Service | URL |
| --- | --- |
| Web Console | `http://localhost:5174` |
| Backend API | `http://127.0.0.1:8787` |

### Single Workspace Mode

Run a dedicated backend for one workspace:

```bash
pnpm dev:server -- \
  --workspace /absolute/path/to/workspace \
  --model-dir /absolute/path/to/models \
  --default-model openai-default
```

### Common Commands

```bash
pnpm build          # Build all packages
pnpm test           # Run tests
pnpm dev:worker -- --config ./server.example.yaml  # Start worker
```

## Who Is It For?

**Good fit:**
- Teams building internal AI platforms or agent products — developers define agent logic, users switch agents by scenario
- Projects that need one backend serving many workspaces in parallel
- Products that want to keep their own frontend, auth, and UX while reusing a shared runtime
- Scenarios requiring more control than a fixed agent UI or thin local agent loop

**Not the best fit:**
- You just want a ready-made chat UI
- You only need a tiny single-user local script
- You don't need workspace isolation or runtime lifecycle management

## Use Cases

| Scenario | Why it works |
| --- | --- |
| Internal engineering copilot | Different repos/teams share one runtime with different agent setups |
| Multi-agent product | Developers define agent logic, users switch agents by scenario — all on one runtime |
| Embedded copilot in an existing product | Runtime stays headless, fits behind your app |
| Single-repo dedicated backend | `single workspace` mode gives a focused deployment path |

## Documentation

| Document | Description |
| --- | --- |
| [Getting Started](./docs/getting-started.en.md) | Setup guide and first steps |
| [Architecture Overview](./docs/design-overview.md) | Design principles and system architecture |
| [Workspace Guide](./docs/workspace/README.en.md) | Workspace configuration and capabilities |
| [Runtime Internals](./docs/runtime/README.en.md) | Runtime lifecycle and context engine |
| [API Reference](./docs/openapi/README.en.md) | OpenAPI specification and endpoints |
| [Templates](./templates/README.md) | Workspace template usage |
