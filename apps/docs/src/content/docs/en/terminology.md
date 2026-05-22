---
title: "Terminology"
---

# Terminology

This page defines the shared naming model used across the repository so `runtime` does not mean both “the execution system” and “the thing being executed.”

Short version:

`Agent Engine runs an Agent Runtime and extends it with Agent Spec.`

If you want the system map that shows how these concepts fit together, continue with:

- [concept-relationships.en.md](./concept-relationships/)

## Core Terms

| Term | Role | Meaning |
| --- | --- | --- |
| `Agent Engine` | Execution system | Loads, schedules, executes, recovers, audits, and exposes API / SSE. |
| `Agent Runtime` | Primary runnable unit | A runnable unit that carries agent / action / hook definitions. Formerly called `blueprint`. |
| `Agent Spec` | User extension layer | Extra user-authored inputs layered onto a runtime, mainly `AGENTS.md`, `.openharness/memory/MEMORY.md`, and extra loaded `model` / `tool` / `skill`. |

## Boundary Rule

- `Engine`: how it runs
- `Runtime`: what runs
- `Spec`: what the user adds

## What Belongs To Runtime

These concepts belong to `Runtime` and should not be renamed as another kind of `spec`:

- agent definitions
- action definitions
- hook definitions
- runtime-owned default behavior and capability composition
- runnable units under `runtimes/`

Avoid:

- `agent spec`
- `hook spec`
- `runtime spec`

## What Belongs To Spec

`Spec` is not the whole runtime structure. It is the user-authored extension layer added on top of a runtime. It mainly includes:

- project-root `AGENTS.md`
- `.openharness/memory/MEMORY.md` and `.openharness/memory/*.md` topic files
- extra loaded `model`
- extra loaded `tool`
- extra loaded `skill`

## Naming Rules To Avoid Ambiguity

When the meaning is about execution flow rather than the primary runnable unit, prefer:

- `engine`
- `run`
- `session`
- `execution`
- `engine state`

So use names like:

- `EngineLogger`
- `engine.log`
- `engine state paths`
