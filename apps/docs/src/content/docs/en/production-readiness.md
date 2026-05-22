---
title: "Production Storage Readiness"
---

# Production Storage Readiness

This page is intentionally the same operational checklist as `production-readiness.md`; keep both in sync when changing production storage behavior.

The production baseline is:

- `oah-api` stays thin and stateless
- restartable `oah-sandbox` workers own workspace materialization, cache pressure, and object-store sync
- PostgreSQL, Redis, object storage, and worker cache sizing are explicit production dependencies

See [production-readiness.md](/Users/wumengsong/Code/OpenAgentHarness/docs/production-readiness/) for the canonical runbook, Helm values, alerts, and backup/restore sequence.

