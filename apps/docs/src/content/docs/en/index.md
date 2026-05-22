---
title: "Open Agent Harness Docs"
---

<div class="oah-home" markdown>

<section class="oah-hero" markdown>
<div class="oah-hero__copy" markdown>
<div class="oah-eyebrow"><img src="/assets/logo-mkdocs.png" alt="">Long-lived agent engine documentation</div>

# Open Agent Harness Docs

Organize runtimes with Markdown and run many workspaces in parallel. OAH owns workspace lifecycle, agent execution loops, tool calls, queue coordination, and durable state; WebUI, TUI, and Desktop all connect through the same REST + SSE API.

<div class="oah-hero__actions" markdown>
<a href="/en/getting-started/">Get Started</a>
<a href="/en/deploy/">Deploy</a>
<a href="/en/openapi/">API Reference</a>
</div>

<div class="oah-hero__chips" markdown>
<span>TypeScript Engine</span>
<span>PostgreSQL + Redis</span>
<span>REST + SSE</span>
<span>Runtime Spec</span>
</div>
</div>

<div class="oah-stage" markdown>
<div class="oah-terminal" markdown>
<div class="oah-terminal__bar"><span class="oah-dot oah-dot--red"></span><span class="oah-dot oah-dot--amber"></span><span class="oah-dot oah-dot--green"></span><span>oah local stack</span></div>
<pre><code>pnpm install
export OPENAI_API_KEY=sk-...
pnpm dev:cli -- daemon start
pnpm dev:web
pnpm dev:cli -- tui</code></pre>
</div>

<div class="oah-architecture" markdown>
<span>WebUI</span>
<span>TUI</span>
<span>Desktop</span>
<strong>OAH API</strong>
<span>Controller</span>
<span>Workers</span>
<span>Storage</span>
</div>
</div>
</section>

<section class="oah-section" markdown>
<div class="oah-section__head" markdown>

## Recommended Path

Start with runtime confidence, then move through configuration, architecture, and API integration.

</div>

<nav class="oah-path" markdown>
<a href="./getting-started.md"><strong>1. Run it</strong><span>Install, launch, and verify locally</span></a>
<a href="./architecture-overview.md"><strong>2. Learn the boundaries</strong><span>Layers, core modules, and request flow</span></a>
<a href="./workspace/README.md"><strong>3. Configure capabilities</strong><span>Workspace config, agents, models, skills, hooks</span></a>
<a href="./openapi/README.md"><strong>4. Integrate the API</strong><span>REST, SSE, schemas, and calling conventions</span></a>
</nav>
</section>

<section class="oah-section" markdown>
<div class="oah-section__head" markdown>

## Core Documentation Entrypoints

Organized around long-term maintenance tasks, not just a list of files.

</div>

<div class="oah-feature-grid" markdown>
<a class="oah-feature" href="./deploy.md"><strong>Deploy and Run</strong><span>Local development, embedded worker, split deployment, and Kubernetes paths.</span></a>
<a class="oah-feature" href="./runtime/README.md"><strong>Runtime Config</strong><span>Build, publish, and maintain reusable runtime templates.</span></a>
<a class="oah-feature" href="./workspace/README.md"><strong>Workspace Spec</strong><span>Settings, agents, models, skills, actions, hooks, and MCP.</span></a>
<a class="oah-feature" href="./engine/README.md"><strong>Engine Internals</strong><span>Lifecycle, context, execution backends, queue reliability, and audit events.</span></a>
<a class="oah-feature" href="./k8s-rollout-checklist.md"><strong>Kubernetes Rollout</strong><span>Rollout checklist, production readiness, and operations runbook.</span></a>
<a class="oah-feature" href="./openapi/README.md"><strong>API and Schemas</strong><span>OpenAPI 3.1, server config schemas, and workspace config schemas.</span></a>
</div>
</section>

<section class="oah-section oah-section--split" markdown>
<div class="oah-section__head" markdown>

## System Shape

The docs should help maintainers answer: where should I change this, who does it affect, and how do I verify it?

</div>

<div class="oah-lanes" markdown>
<div><strong>Client Surfaces</strong><span>WebUI, TUI, and Desktop consume OAH-compatible APIs without owning engine state.</span></div>
<div><strong>Control Plane</strong><span>API, controller, queues, placement, and rebalance coordinate concurrent workspaces.</span></div>
<div><strong>Execution Plane</strong><span>Embedded or sandbox workers execute runs and synchronize workspace state.</span></div>
<div><strong>Storage Plane</strong><span>PostgreSQL is the source of truth, Redis coordinates queues, and object storage backs workspace state.</span></div>
</div>
</section>

</div>
