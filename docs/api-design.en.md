# API Design

This page explains the API boundary. The concrete interface definition is described by [openapi/openapi.yaml](./openapi/openapi.yaml) and the pages under `docs/openapi/`.

## API Shape

- HTTP REST API
- SSE streaming events

## Main Resource Groups

- workspaces
- models
- catalog
- sessions
- messages
- runs
- actions
- events

## Core Constraints

- external HTTP APIs live under `/api/v1`
- internal model runtime APIs live under `/internal/v1/models/*`
- production authentication and authorization are expected to happen upstream
- the runtime consumes caller context rather than owning identity itself
- message sending and action triggering use asynchronous semantics
- execution progress is retrieved through SSE and run status APIs

## API Responsibilities

- consume validated caller context from upstream systems
- validate request parameters
- create messages and runs
- expose run status and SSE connections

Execution, orchestration, context loading, and tool dispatch belong to the runtime layer.

