# Architecture Overview

## 1. What This Is

Open Agent Harness is a headless agent runtime. It has no UI -- it exposes capabilities through OpenAPI + SSE for web apps, desktop clients, CLIs, and automation systems.

Two types of users:

- **Platform developers** -- define agents, actions, skills, tools, hooks
- **Consumers** -- open a workspace and collaborate with agents to execute tasks

Two workspace kinds:

| Kind | Description |
|------|-------------|
| `project` | Full workspace with tools, execution, and local runtime state |
| `workspace` | Unified workspace; loads prompts, agents, models, actions, skills, tools, and hooks |

## 2. Design Principles

- **Workspace First** -- The platform provides the runtime; the workspace declares capabilities. All project-level capabilities live in the workspace, except model credentials.
- **Session Serial, System Parallel** -- Runs are serial within a session; sessions run concurrently; intra-run tool parallelism is agent-policy-controlled.
- **Domain Separate, Invocation Unified** -- action / skill / tool / native tool stay separate in domain, config, and governance; unified as tool calling for the LLM.
- **Local First, Sandbox Ready** -- Default local execution; execution layer is replaceable from day one; future support for containers / VMs / remote runners.
- **Identity Externalized** -- No built-in user system; consumes external identity and access context.
- **Auditable by Default** -- All runs, tool calls, action runs, and hook runs produce structured records.
- **Central Truth, Local Runtime State** -- PostgreSQL is the central source of truth; workspace `history.db` only stores local runtime data and is not a cross-process sync path.
- **Embedded by Default, Controlled in Production** -- The smallest deployment uses `oah-api` with an embedded worker; production uses a split `oah-api + oah-controller + oah-sandbox` topology.

## 3. Formal Terms

### Agent Engine / Agent Runtime / Agent Spec

- `Agent Engine`: the execution, scheduling, recovery, audit, and API exposure system
- `Agent Runtime`: the primary runnable unit, formerly called `blueprint`
- `Agent Spec`: the user-authored extension layer, mainly `AGENTS.md`, `MEMORY.md`, and extra loaded `model` / `tool` / `skill`
- mnemonic: `Engine` is how it runs, `Runtime` is what runs, `Spec` is what the user adds

### API Server

- The unified external entry point for OAH
- Owns OpenAPI, SSE, caller context, auth integration, metadata persistence, and owner routing
- Can run with an embedded worker or in `api-only` mode

### Worker

- The unified execution runtime role in OAH
- Owns run execution, session-serial boundaries, the tool loop, workspace file access, workspace materialization, and flush / evict
- `Worker` is a responsibility, not a deployment shape

### Controller

- The control-plane role in OAH
- Owns workspace placement, owner affinity, capacity, drain, recovery, rebalance, and scaling
- `Controller` does not execute business runs directly

### Sandbox

- The isolated host environment where a worker runs
- May be a local process, a dedicated Pod, a container, or a future VM / remote executor
- `Sandbox` describes the execution environment; it does not replace `Worker` as the primary term
- With the `embedded` provider there is no separate sandbox process; the worker runs directly inside `oah-api`
- With `self_hosted / e2b`, the standalone worker must run inside a real sandbox

### Sandbox Host API

- The stable adapter boundary between the worker and its host environment
- The first implementation should be OAH's own sandbox pod
- The exposed provider vocabulary is `embedded | self_hosted | e2b`, and backend switching should be a server-config change rather than an API change
- It carries host lifecycle, file access, and process execution capabilities only; it does not redefine OAH ownership or control-plane semantics
- The formal `e2b` semantics now match the self-hosted path: host the standalone worker inside the real sandbox rather than driving E2B indirectly from an external worker

### Workspace

- A workspace is the logical project, capability-discovery, and session-ownership boundary
- It answers “which project and capability set is this agent working in?”, not “which host is it running on?”
- A workspace may be materialized into a worker-owned `Active Workspace Copy` for execution
- One sandbox may carry multiple active workspaces up to capacity; one active workspace should have exactly one owner worker holding its writable truth

### Workspace Ownership

- `workspace -> owner worker` is the routing truth for execution and file access
- `ownerId` is the affinity scheduling key, not a separate ownership truth beyond `workspace -> owner worker`
- While active, a workspace's read/write truth lives in the owner worker's `Active Workspace Copy`; after idle flush, truth returns to OSS / external storage

### Layering Rule

Use these two chains together:

`Agent Engine -> Worker -> Sandbox -> Active Workspace Copy`

`Agent Engine -> Workspace -> Session -> Run`

In other words:

- `workspace` is the logical project and capability boundary
- `sandbox` is the execution-host and file/process isolation boundary
- `worker` is the execution role running inside that host
- active workspaces are materialized into sandbox-local copies
- `runtime` initializes a workspace but does not replace workspace / sandbox / worker as a concept

## 4. Layered Architecture

```mermaid
flowchart TD
    A[Clients\nWeb / Desktop / CLI / API Consumers] --> B[Identity / Access Service]
    B --> C[API Server]
    C --> D[Controller]
    C --> E[Worker Routing / Owner Proxy]
    C --> F[PostgreSQL]
    C --> G[Redis]
    E --> H[Worker]
    D --> G
    D --> I[Kubernetes / Runtime Control Plane]
    H --> J[Engine Core]
    J --> K[Context Engine]
    J --> L[Invocation Dispatcher]
    J --> M[Hook Runtime]
    L --> N[Native Tool / Action / Skill / External Tool Runtime]
    H --> O[Execution Backend]
    O --> P[Local Backend]
    O --> Q[Sandbox Host API]
    Q --> R[Self-Hosted Sandbox Pod]
    Q -. future / optional .-> S[E2B-Compatible Host Adapter]
    H --> T[(Workspace Local State)]
    H --> U[(OSS / Object Storage)]
    J --> F
    J --> G
```

## 5. Core Modules

### API Server

- Provides OpenAPI endpoints and SSE event streams
- Receives / validates caller context from upstream
- Handles access control, rate limiting, parameter validation, and metadata persistence
- Creates workspaces, sessions, messages, and runs
- Resolves workspace ownership and routes run / file requests to the owner worker
- Default mode includes an embedded worker; `api-only` mode handles ingress and routing only

### Worker

- Reuses `packages/engine-core` for business execution logic
- Consumes runs and drives the model <-> tool loop
- Enforces per-session serial execution
- Manages cancellation, timeout, and failure recovery
- Owns workspace materialization, local file access, and flush / evict
- Can run embedded inside the API Server or standalone in a dedicated Pod

### Controller

- Owns workspace placement and worker lifecycle governance
- Combines `owner affinity + workspace ownership + worker health + capacity` into placement decisions
- For `self_hosted / e2b` providers, also derives logical sandbox fleet demand: same `ownerId` reuses a sandbox, while ownerless workspaces fall into a shared pool by default
- Owns drain, rebalance, recovery, and scaling
- Does not execute business runs directly

### Sandbox Host API

- Unifies the host capabilities a worker depends on
- It should cover only:
  - sandbox / session creation and reuse
  - workspace materialization / mount
  - file read / write / download
  - command execution / process management
  - health, drain, and shutdown
- The current target is "compatible switching" with E2B, not reshaping OAH around E2B's full native resource model first

### Engine Core

- Loads workspace config: `AGENTS.md`, `settings.yaml`, agents, models
- Loads platform-level model / tool / skill directories
- Assembles system prompt, history messages, and capability catalog
- `project` workspace: loads all capability types
- workspace: loads agents / models / AGENTS.md together with declared actions / skills / tools / hooks
- Owns the run state machine, session-serial boundaries, tool loop, audit, and recovery closure

### Invocation Dispatcher

- Maps tool call names back to source (native / action / skill / external)
- Routes to the appropriate executor
- Wraps parameter parsing, audit, timeout, and result propagation

### Execution Backend

- Unified workspace execution environment (shell, file I/O, process management)
- Abstracts local execution, self-hosted sandbox pods, and future E2B-like host backends
- workspaces always create backend sessions and run through the same execution path

### Hook Runtime

- Executes lifecycle hooks (run events) and interceptor hooks (tool / model events)
- Allows controlled modification of requests and execution logic within safety bounds

## 6. Recommended Deployment Modes

| Mode | Description |
|------|-------------|
| `oah-api` + embedded worker | Smallest deployment. One API process directly hosts the embedded worker. |
| `oah-api` + `oah-controller` + `oah-sandbox` | Preferred main mode. `oah-api` handles ingress, `oah-controller` handles the control plane, and `oah-sandbox` hosts the standalone worker. |
| Standalone worker in sandbox | The typical standalone-worker deployment shape. The worker runs inside a self-hosted sandbox or an E2B sandbox. |
| `oah-api` + `oah-controller` + E2B sandbox | Remote sandbox form. The standalone worker runs inside a real E2B sandbox while API and control-plane semantics stay the same. |

## 7. Request Flow

```mermaid
sequenceDiagram
    participant Client
    participant API as API Server
    participant Controller
    participant Worker
    participant Model as LLM Provider
    participant Dispatcher as Invocation Dispatcher
    participant Runtime as Action/Skill/Tool/Native Runtime
    participant DB as PostgreSQL
    participant Redis
    participant OSS as Object Storage

    Client->>API: POST /sessions/:id/messages
    API->>DB: persist message
    API->>DB: create run
    API->>Redis: enqueue run by session / workspace
    API->>Controller: resolve or assign owner worker
    API-->>Client: 202 Accepted

    API->>Worker: route request to owner worker
    Worker->>OSS: materialize workspace if needed
    Worker->>Redis: publish ownership / heartbeat
    Worker->>DB: load session and history
    Worker->>Model: start agent loop
    Model-->>Worker: tool call
    Worker->>Dispatcher: dispatch tool call
    Dispatcher->>Runtime: execute
    Runtime-->>Dispatcher: result
    Dispatcher-->>Worker: invocation result
    Worker->>Model: continue loop
    Model-->>Worker: final output
    Worker->>DB: persist result and run status
    Worker->>Redis: publish events
    Worker-->>Client: SSE events via API Server
    Worker->>OSS: flush on idle / drain when needed
```

## 8. Key Architecture Decisions

- No built-in user system -- consumes external identity and access context
- Workspace is the configuration and capability discovery boundary; `.openharness/settings.yaml` is the entry point
- Platform built-in agents merge with workspace agents; workspace agents override on name collision
- Runtimes are for initialization only -- runtime reads current workspace files
- workspaces are managed under `workspace_dir`; runtimes are only initialization sources
- `AGENTS.md` is injected verbatim (no summarization)
- Agents defined via `agents/*.md` -- frontmatter for config, body for system prompt
- Model / Hook / Tool Server configs use declarative YAML
- Actions use `actions/*/ACTION.yaml`; Skills use `skills/*/SKILL.md`
- All capabilities are unified as tool calling for the LLM, but stay separate in domain and governance
- `Worker` is the unified execution role; `sandbox` is only the worker host environment, not the primary runtime term
- `Sandbox Host API` is the host compatibility boundary; the first implementation should be the self-hosted sandbox pod, with E2B as a later pluggable backend rather than the primary architecture vocabulary
- `Controller` is the unified control-plane role; it owns placement, lifecycle, and capacity rather than direct business execution
- For remote sandbox providers, the controller now also owns logical sandbox-fleet sizing signals so we can later attach real sandbox autoscaling targets without changing API semantics
- `workspace -> owner worker` is the routing truth for execution and file access; `ownerId` is used for affinity scheduling and must not be treated as a second ownership source of truth
- While active, a workspace's read/write truth lives in the owner worker's `Active Workspace Copy`; after flush / evict, truth returns to OSS / external storage
- Default trusted intranet environment -- no strong container isolation by default; if the platform is exposed more broadly, sandbox backend hardening should be prioritized
- PostgreSQL is the central source of truth; local workspace state files do not serve as a cross-process sync mechanism

## 9. Technology

| Layer | Choice |
|-------|--------|
| Language | TypeScript / Node.js |
| API | OpenAPI 3.1 + HTTP + SSE |
| Database | PostgreSQL |
| Queue & coordination | Redis |
| Local runtime data | SQLite |
| Model layer | Vercel AI SDK + dual-layer model registry |
