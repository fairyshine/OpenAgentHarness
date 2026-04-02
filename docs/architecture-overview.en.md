# Architecture Overview

This page gives a high-level English summary of the system architecture.

## Product Goal

Open Agent Harness is a headless agent runtime for products and internal platforms that need to serve many users, sessions, and runs concurrently.

It is not a UI-first chat product. It is the backend runtime behind one.

## Core Principles

- `Workspace First`
- `Session Serial, System Parallel`
- `Domain Separate, Invocation Unified`
- `Local First, Sandbox Ready`
- `Identity Externalized`
- `Auditable by Default`

## System Boundary

The system is responsible for:

- multi-workspace management
- session and run orchestration
- loading agents, models, actions, skills, external tools, and hooks
- exposing REST APIs and SSE streams
- queueing, cancellation, timeout, recovery, and audit
- syncing central history into per-workspace local mirrors

The system does not try to be:

- a SaaS control plane
- an identity provider
- a code hosting platform
- a public zero-trust sandbox

## Main Layers

- `API Gateway`: external API and SSE entrypoint
- `Session Orchestrator`: run lifecycle and per-session serialization
- `Context Engine`: workspace capability loading and prompt assembly
- `Invocation Dispatcher`: maps model tool calls to runtimes
- `Execution Backend`: local execution today, sandbox-ready abstraction
- `Hook Runtime`: lifecycle extension points
- `Storage Layer`: PostgreSQL as source of truth, Redis for coordination, history mirror sync

## Deployment Shapes

- local/default: `API + embedded worker`
- split/production: `API only + standalone worker`

## Note

The detailed architecture documents under this section remain the source of truth. Some sub-pages may still fall back to Chinese until they are translated.
