---
title: "Open Agent Harness 文档总览"
template: splash
---

<div class="oah-home" markdown>

<section class="oah-hero" markdown>
<div class="oah-hero__copy" markdown>
<div class="oah-eyebrow"><img src="/assets/logo-mkdocs.png" alt="">长期维护的 Agent Engine 文档</div>

# Open Agent Harness 文档总览

用 Markdown 组织 Runtime，让多 Workspace 并行执行。OAH 负责 workspace 生命周期、agent 执行循环、工具调用、队列调度和状态持久化；WebUI、TUI、Desktop 都通过同一套 REST + SSE API 接入。

<div class="oah-hero__actions" markdown>
<a href="/getting-started/">快速开始</a>
<a href="/deploy/">部署指南</a>
<a href="/openapi/">API 参考</a>
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

## 推荐阅读路径

从运行、配置、架构到 API，对新加入的维护者也比较友好。

</div>

<nav class="oah-path" markdown>
<a href="/getting-started/"><strong>1. 跑起来</strong><span>安装、启动、验证本地环境</span></a>
<a href="/architecture-overview/"><strong>2. 看边界</strong><span>系统分层、核心模块和请求链路</span></a>
<a href="/workspace/"><strong>3. 配能力</strong><span>workspace 配置、agent、model、skill、hook</span></a>
<a href="/openapi/"><strong>4. 接 API</strong><span>REST、SSE、Schema 与调用约定</span></a>
</nav>
</section>

<section class="oah-section" markdown>
<div class="oah-section__head" markdown>

## 核心文档入口

围绕长期维护常见任务组织，而不是按文件堆目录。

</div>

<div class="oah-feature-grid" markdown>
<a class="oah-feature" href="/deploy/"><strong>部署与运行</strong><span>本地开发、embedded worker、split deployment、K8S 路径。</span></a>
<a class="oah-feature" href="/runtime/"><strong>Runtime 配置</strong><span>编写、发布和维护可复用 runtime 模板。</span></a>
<a class="oah-feature" href="/workspace/"><strong>Workspace Spec</strong><span>Settings、Agent、Model、Skill、Action、Hook、MCP。</span></a>
<a class="oah-feature" href="/engine/"><strong>Engine 内部设计</strong><span>生命周期、上下文、执行后端、队列可靠性和事件审计。</span></a>
<a class="oah-feature" href="/k8s-rollout-checklist/"><strong>Kubernetes 上线</strong><span>上线清单、production readiness、运维 runbook。</span></a>
<a class="oah-feature" href="/openapi/"><strong>API 与 Schema</strong><span>OpenAPI 3.1、服务端配置 Schema、workspace 配置 Schema。</span></a>
</div>
</section>

<section class="oah-section oah-section--split" markdown>
<div class="oah-section__head" markdown>

## 系统形态

OAH 的文档应该帮助维护者快速判断：改哪里、影响谁、怎么验证。

</div>

<div class="oah-lanes" markdown>
<div><strong>Client Surfaces</strong><span>WebUI、TUI、Desktop 只消费 OAH-compatible API，不拥有 engine 状态。</span></div>
<div><strong>Control Plane</strong><span>API、controller、queue、placement、rebalance 共同管理并发 workspace。</span></div>
<div><strong>Execution Plane</strong><span>embedded worker 或 sandbox worker 执行 run，并同步 workspace 状态。</span></div>
<div><strong>Storage Plane</strong><span>PostgreSQL 是中心事实源，Redis 负责队列与协调，对象存储承载 workspace backing store。</span></div>
</div>
</section>

</div>
