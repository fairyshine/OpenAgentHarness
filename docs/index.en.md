# Open Agent Harness

<div class="hero" markdown>
### A Headless Agent Engine

Define agent runtimes in Markdown, switch by scenario, run many workspaces in parallel. You build the product UI. This is the backend engine.

[Get Started](./getting-started.md){ .md-button .md-button--primary }
[Architecture](./architecture-overview.md){ .md-button }

</div>

## What It Is

Open Agent Harness is a deployable Agent Engine. It runs Agent Runtime units and extends them with Agent Spec. It manages workspace lifecycles, agent execution loops, tool invocations, and state persistence without shipping a product UI.

Client surfaces are converging on WebUI, TUI, and Desktop. This repository currently ships WebUI and TUI: use WebUI for browser-based sessions, runtime state, trace, and storage inspection, or the TUI when you are already working in a shell and want to select a workspace, enter a session, and watch streaming output. Desktop should connect to the same OAH-compatible API.

## Core Capabilities

- **Parallel workspaces** — PostgreSQL for persistence, Redis for queues and coordination. Many workspaces run concurrently.
- **Declarative runtime structure** — Define agent/runtime behavior in Markdown and YAML. Hot-reloaded.
- **Composable capabilities** — agent / skill / action / tool / hook / context are configured independently per workspace.
- **One workspace model** — the same directory structure supports conversation, tools, and execution.
- **REST + SSE API** — Everything exposed under `/api/v1`. Frontend-agnostic.
- **TUI** — Workspace and session operation in the terminal over the same API / SSE surfaces.
- **Flexible deployment** — Use `oah-api` with an embedded worker for the smallest deployment, or split into `oah-api + oah-controller + oah-sandbox`.

## Quick Start

```bash
pnpm install                                        # Install dependencies
mkdir -p /absolute/path/to/oah-deploy-root
cp -R ./template/deploy-root/. /absolute/path/to/oah-deploy-root
export OAH_DEPLOY_ROOT=/absolute/path/to/oah-deploy-root
pnpm local:up                                       # Start PostgreSQL + Redis + MinIO + oah-api + oah-controller + oah-sandbox, then auto-sync once
pnpm dev:web                                        # Start WebUI
pnpm dev:cli -- --base-url http://127.0.0.1:8787 tui # Start terminal TUI
```

After startup:

- :material-monitor-dashboard: **WebUI** — [http://localhost:5174](http://localhost:5174)
- :material-console: **Terminal TUI** — `pnpm dev:cli -- --base-url http://127.0.0.1:8787 tui`
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

-   :material-tag-outline:{ .lg .middle } **Terminology**

    ---

    Shared boundaries for Engine, Runtime, and Spec

    [:octicons-arrow-right-24: View](./terminology.en.md)

-   :material-folder-cog-outline:{ .lg .middle } **Workspace Config**

    ---

    Agents, models, skills, actions, hooks

    [:octicons-arrow-right-24: Configure](./workspace/README.md)

-   :material-server-outline:{ .lg .middle } **Deploy and Run**

    ---

    Local dev, split deployment, single workspace mode

    [:octicons-arrow-right-24: Deploy](./deploy.md)

-   :material-console:{ .lg .middle } **TUI**

    ---

    Operate workspaces, sessions, catalogs, and streaming output from the terminal

    [:octicons-arrow-right-24: View](./tui.md)

</div>
