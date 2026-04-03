# Open Agent Harness

[中文版本](./README.zh-CN.md) | English

Open Agent Harness is a headless, workspace-first agent runtime for teams building agent products, internal AI platforms, and embedded copilots.

It is designed for the part that gets difficult fast in real systems: serving many workspaces, sessions, and runs while keeping behavior flexible, governable, and easy to embed into your own product.

## In One Sentence

Build your own agent product on top of a reusable runtime, instead of rebuilding the runtime itself.

## At a Glance

| Question | Answer |
| --- | --- |
| What is it? | A deployable backend runtime for agent conversations and task execution. |
| Who is it for? | Teams building internal AI platforms, team-facing agent products, or embedded copilots. |
| What is the core idea? | Let each workspace define its own agents, prompts, skills, actions, hooks, and tools while sharing one runtime core. |
| What is it not? | Not a ready-made chat product, identity system, or SaaS control plane. |

## Why Open Agent Harness

- Headless and embeddable behind your own web app, desktop app, CLI, automation system, or API gateway
- Workspace-first customization instead of one fixed global agent setup
- Supports both executable `project` workspaces and read-only `chat` workspaces
- Flexible capability model with separate `agent`, `skill`, `action`, `tool`, `hook`, and context layers
- One runtime that works for single-workspace setups and multi-workspace platform deployments

## What Makes It Different

| Dimension | Open Agent Harness focuses on... |
| --- | --- |
| Product boundary | A backend runtime kernel you embed into your own product |
| Customization model | Workspace-level composition instead of one fixed workflow |
| Capability design | Separate layers for roles, methods, tasks, tools, hooks, and context |
| Platform fit | Integration into existing identity, policy, and product surfaces |
| Deployment path | Easy local startup and production-friendly split deployment |

## A Flexible Capability Model

The main strength of Open Agent Harness is not just that it supports many concepts, but that those concepts stay separate so you can combine them differently per workspace.

| Capability | What it is for |
| --- | --- |
| `agent` | Defines the role, behavior, and permissions of a working persona |
| `primary agent` / `subagent` | Supports both user-facing specialists and delegated background specialists |
| `tool` | Gives an agent access to built-in or external execution capabilities |
| `skill` | Packages reusable know-how for a class of tasks |
| `action` | Exposes a stable named task that users, APIs, or agents can trigger |
| `hook` | Adds lifecycle interception, policy, or extension logic around runtime events |
| `context` | Controls how prompts and workspace instructions are assembled for the model |

This gives you a lot of freedom in practice:

- Different workspaces can use different agent sets and prompt strategies.
- Different agents can see different tools, actions, skills, and subagents.
- Skills can capture reusable methods without turning into hard-coded product logic.
- Actions can represent stable product tasks without becoming a workflow DSL.
- Hooks can add governance and extension points without changing the core runtime behavior.

## Workspace-First Customization

The workspace is the main customization boundary. A single runtime can host many workspaces, and each workspace can bring its own combination of:

- agents
- prompts and shared instructions
- skills
- actions
- hooks
- models
- tool servers

That means two workspaces can share the same runtime but still behave very differently for different teams, repos, or product scenarios.

## Best Fit

Open Agent Harness is a strong fit when:

- you are building an internal AI platform or a team-facing agent product
- you need one backend to serve many workspaces in parallel
- you want to keep your own frontend, auth, and product experience
- you need more control than a fixed agent UI or a thin local agent loop can provide

It is less suitable when:

- you only want a ready-made chat UI
- you only need a tiny single-user local script
- you do not need workspace isolation or runtime lifecycle management

## Typical Use Cases

| Scenario | Why it fits |
| --- | --- |
| Internal engineering copilot | Different repos or teams can have different agent setups on one shared runtime |
| Team-facing agent product | You keep your own UX and policy layer while reusing the runtime |
| Embedded copilot inside an existing product | The runtime stays headless and fits behind your existing app |
| Dedicated backend for one repo or one chat preset | `single workspace` mode gives you a focused deployment path |

## Quick Start

```bash
pnpm install
pnpm infra:up
pnpm dev:server -- --config ./server.example.yaml
pnpm dev:web
```

Common local addresses:

- Debug web console: `http://localhost:5174`
- Default backend address: `http://127.0.0.1:8787`

Useful commands:

```bash
pnpm build
pnpm test
pnpm dev:worker -- --config ./server.example.yaml
```

Run a dedicated backend for one workspace:

```bash
pnpm dev:server -- \
  --workspace /absolute/path/to/workspace \
  --model-dir /absolute/path/to/models \
  --default-model openai-default
```

## Documentation

- [docs/README.md](./docs/README.md)
- [docs/getting-started.en.md](./docs/getting-started.en.md)
- [docs/deploy.en.md](./docs/deploy.en.md)
- [docs/architecture-overview.en.md](./docs/architecture-overview.en.md)
- [docs/workspace/README.en.md](./docs/workspace/README.en.md)
- [templates/README.md](./templates/README.md)
