# Open Agent Harness

<div class="hero" markdown>
### A Headless Agent Runtime Kernel

Define agent logic in Markdown, switch agents by scenario, run many workspaces in parallel. You build the product UI. This is the backend runtime.

[Get Started](./getting-started.md){ .md-button .md-button--primary }
[Architecture](./architecture-overview.md){ .md-button }

</div>

## What It Is

Open Agent Harness is a deployable backend runtime for agent products. It manages workspace lifecycles, agent execution loops, tool invocations, and state persistence. It does not ship a product UI — you bring your own frontend, and it runs the agents.

## Core Capabilities

- **Parallel workspaces** — PostgreSQL for persistence, Redis for queues and coordination. Many workspaces run concurrently.
- **Declarative agent config** — Define agents in Markdown files with YAML frontmatter. Hot-reloaded.
- **Composable capabilities** — agent / skill / action / tool / hook / context are configured independently per workspace.
- **One workspace model** — the same directory structure supports conversation, tools, and execution.
- **REST + SSE API** — Everything exposed under `/api/v1`. Frontend-agnostic.
- **Flexible deployment** — Use `oah-api` with an embedded worker for the smallest deployment, or split into `oah-api + oah-controller + oah-sandbox`.

## Quick Start

```bash
pnpm install                                        # Install dependencies
export OAH_TEST_ROOT=/absolute/path/to/test_oah_server
pnpm local:up                                       # Start PostgreSQL + Redis + MinIO + oah-api + oah-controller + oah-sandbox, then auto-sync once
pnpm dev:web                                        # Start debug console
```

After startup:

- :material-monitor-dashboard: **Debug Console** — [http://localhost:5174](http://localhost:5174)
- :material-api: **oah-api** — [http://localhost:8787](http://localhost:8787)

[:octicons-arrow-right-24: Full guide](./getting-started.md){ .md-button .md-button--primary }

## Where to Go

<div class="grid cards" markdown>

-   :material-rocket-launch:{ .lg .middle } **Quick Start**

    ---

    Install, launch, verify — up and running in 5 minutes

    [:octicons-arrow-right-24: Start](./getting-started.md)

-   :material-layers-outline:{ .lg .middle } **Architecture**

    ---

    Layered design, core modules, request flow

    [:octicons-arrow-right-24: View](./architecture-overview.md)

-   :material-folder-cog-outline:{ .lg .middle } **Workspace Config**

    ---

    Agents, models, skills, actions, hooks

    [:octicons-arrow-right-24: Configure](./workspace/README.md)

-   :material-server-outline:{ .lg .middle } **Deploy and Run**

    ---

    Local dev, split deployment, single workspace mode

    [:octicons-arrow-right-24: Deploy](./deploy.md)

</div>
