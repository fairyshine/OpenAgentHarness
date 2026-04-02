# Open Agent Harness

<div class="hero" markdown>

### An Enterprise Agent Backend

If you're building an agent product for teams or organizations, this project gives you the backend layer first.

It is most useful for two things:
- large-scale parallel workspace usage instead of a single local agent loop
- a flexible harness design where you decide how agents, models, actions, skills, tools, and hooks are composed

[Get Started in 5 Minutes](./getting-started.md){ .md-button .md-button--primary }
[See the Architecture](./architecture-overview.md){ .md-button }

</div>

> In plain English: this is a deployable backend foundation for agent products.
> You build the product experience, and Open Agent Harness provides the scalable workspace runtime and the flexible harness underneath it.

## What This Project Is For

Imagine you're building an internal platform or a team-facing enterprise agent product.

You will quickly run into questions like:

- How do we support many workspaces in parallel?
- How do we let different workspaces use different agent, model, skill, and tool combinations?
- How do we keep one shared runtime while still allowing deep customization?
- How do we avoid being locked into one UI or one fixed workflow?
- How do we stay deployable and governable as scale grows?

Open Agent Harness is built to solve those problems.

It doesn't provide your product UI. It provides the reusable backend runtime underneath.

## The Two Most Important Characteristics

### 1. Enterprise-scale parallel workspace usage

This project is not centered on a single local agent. It is centered on many workspaces being used in parallel.

That makes it a better fit for:

- internal enterprise platforms
- shared agent systems used by multiple teams
- environments where many workspaces, users, and runs coexist

### 2. A flexible harness design

This is not a rigid agent product. It is a more flexible harness framework.

You decide:

- what frontend sits on top
- how agents are organized
- how models, actions, skills, tools, and hooks are combined
- whether deployment stays unified or splits into API and Worker processes

## Why We Call It a Harness

In common usage, an "agent harness" is not just a chat interface and not just a thin model wrapper. It is the runtime infrastructure around the model.

That layer usually handles:

- the execution loop
- tool access, state, and memory
- error recovery, permissions, and safety constraints
- the long-running operational behavior of the agent

That is exactly the layer Open Agent Harness focuses on.

## How This Differs From Many Agent Products

Many agent products are optimized around a ready-made UX or a more fixed workflow:

- you adopt their interaction model first
- you adapt to their built-in capability structure
- and customization happens inside those boundaries

Open Agent Harness is closer to a runtime framework:

- it does not lock you into one UI
- it does not force one capability model
- it does not force one deployment shape
- it is designed for teams that want deeper control and enterprise integration

In short: it is a better fit when you want to build your own product, but do not want to rebuild the agent runtime layer from scratch.

## When It Fits

- You are building an internal platform or a team-facing agent product
- You need to support many workspaces in parallel
- You already have a frontend and need a flexible agent harness underneath
- You want something beyond a single local script or fixed product workflow
- You want models, Actions, Skills, and tools to stay composable and customizable

## When It Does Not Fit

- You only want a ready-made chat UI
- You only need a one-off local script
- You only need a tiny demo and do not need scale or customization yet

## Where To Start

| What you want to do | Start here |
| --- | --- |
| Run the project locally | [Quick Start](./getting-started.md) |
| Understand local vs production deployment | [Deploy and Run](./deploy.md) |
| Understand the system at a high level | [Architecture Overview](./architecture-overview.md) |
| Configure workspace, agents, models, and skills | [Workspace Overview](./workspace/README.md) |
| Understand how the harness stays flexible | [Overview](./design-overview.md) |

## Fastest Way To Run It

```bash
pnpm install
pnpm infra:up
pnpm dev:server -- --config ./server.example.yaml
pnpm dev:web
```

Common local addresses:

- Debug web console: [http://localhost:5174](http://localhost:5174)
- Default backend address: `http://127.0.0.1:8787`

If you only want to preview the docs site locally:

```bash
python3 -m pip install -r docs/requirements.txt
mkdocs serve
```

## Translation Note

This site now supports both Chinese and English.

The main entry pages are available in English. Some deeper design documents still fall back to the Chinese version until they are translated.
