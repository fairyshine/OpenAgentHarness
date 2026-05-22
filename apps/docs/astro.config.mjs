import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import lucode from "lucode-starlight";

const docsBase = process.env.DOCS_BASE ?? "/";

const sidebar = [
  {
    label: "使用指南",
    items: [
      { label: "文档总览", slug: "docs/overview" },
      { label: "快速开始", slug: "getting-started" },
      { label: "部署与运行", slug: "deploy" },
      { label: "目录与部署根", slug: "home-and-deploy-root" },
      { label: "TUI", slug: "tui" },
      {
        label: "Kubernetes",
        items: [
          { label: "Compose / K8S 复用矩阵", slug: "k8s-compose-reuse-matrix" },
          { label: "K8S 上线清单", slug: "k8s-rollout-checklist" },
          { label: "K8S 运维 Runbook", slug: "k8s-operations-runbook" },
        ],
      },
      {
        label: "路线图",
        items: [
          { label: "当前进度", slug: "project-roadmap" },
          { label: "生产就绪", slug: "production-readiness" },
          { label: "实现路线图", slug: "implementation-roadmap" },
        ],
      },
    ],
  },
  {
    label: "配置与 Runtime",
    items: [
      { label: "服务端配置", slug: "server-config" },
      { label: "Runtime 配置", slug: "runtime" },
      { label: "Runtime 设计", slug: "runtime-design" },
      { label: "配置文件详解", slug: "runtime/config-files" },
      { label: "配置文件总览", slug: "workspace" },
      { label: "Settings", slug: "workspace/settings" },
      { label: "Prompts", slug: "workspace/prompts" },
      { label: "Agents", slug: "workspace/agents" },
      { label: "Models", slug: "workspace/models" },
      { label: "Providers", slug: "workspace/model-providers" },
      { label: "Actions", slug: "workspace/actions" },
      { label: "Skills", slug: "workspace/skills" },
      { label: "Hooks", slug: "workspace/hooks" },
      { label: "MCP", slug: "workspace/mcp" },
      { label: "加载与校验", slug: "workspace/loading-and-validation" },
      { label: "Agent Spec", slug: "agent-spec" },
    ],
  },
  {
    label: "架构与设计",
    items: [
      { label: "设计总览", slug: "design-overview" },
      { label: "术语约定", slug: "terminology" },
      { label: "概念关系", slug: "concept-relationships" },
      { label: "架构总览", slug: "architecture-overview" },
      { label: "领域模型", slug: "domain-model" },
      { label: "存储设计", slug: "storage-design" },
      { label: "API 设计", slug: "api-design" },
      {
        label: "Engine",
        items: [
          { label: "导航", slug: "engine" },
          { label: "生命周期", slug: "engine/lifecycle" },
          { label: "上下文引擎", slug: "engine/context-engine" },
          { label: "消息投影", slug: "engine/message-projections" },
          { label: "Message 与 EngineMessage", slug: "engine/message-projections/message-and-engine-message" },
          { label: "Projection 实现细节", slug: "engine/message-projections/projection-implementations" },
          { label: "模型输入与 UI 展示", slug: "engine/message-projections/model-and-ui-mapping" },
          { label: "模型运行时", slug: "engine/model-runtime" },
          { label: "Projection 与 Executors", slug: "engine/projection-and-executors" },
          { label: "执行后端", slug: "engine/execution-backend" },
          { label: "Hook Runtime", slug: "engine/hook-runtime" },
          { label: "Queue 与可靠性", slug: "engine/queue-and-reliability" },
          { label: "事件与审计", slug: "engine/events-and-audit" },
          { label: "Worker 控制面", slug: "engine/worker-control-plane" },
          { label: "拆分部署", slug: "engine/split-deployment" },
          { label: "Subagent 编排", slug: "engine/subagent-orchestration" },
          { label: "Rust 热路径", slug: "engine/rust-hot-paths" },
          { label: "Worker 成熟化路线图", slug: "engine/worker-scaling-roadmap" },
        ],
      },
    ],
  },
  {
    label: "API 与 Schema",
    items: [
      { label: "API 参考", slug: "openapi" },
      { label: "Workspaces", slug: "openapi/workspaces" },
      { label: "Sessions", slug: "openapi/sessions" },
      { label: "Runs", slug: "openapi/runs" },
      { label: "Actions", slug: "openapi/actions" },
      { label: "Files", slug: "openapi/files" },
      { label: "Storage", slug: "openapi/storage" },
      { label: "Models", slug: "openapi/models" },
      { label: "Streaming", slug: "openapi/streaming" },
      { label: "Components", slug: "openapi/components" },
      { label: "Schemas", slug: "schemas" },
    ],
  },
];

export default defineConfig({
  site: process.env.DOCS_SITE_URL ?? "http://127.0.0.1:4321",
  base: docsBase,
  integrations: [
    starlight({
      title: "Open Agent Harness",
      description: "面向企业级大规模 workspace 并行场景的自由 Agent Harness 文档站",
      logo: {
        src: "./src/assets/logo.png",
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/fairyshine/OpenAgentHarness",
        },
      ],
      customCss: ["./src/styles/oah.css"],
      plugins: [lucode()],
      defaultLocale: "root",
      locales: {
        root: {
          label: "简体中文",
          lang: "zh-CN",
        },
        en: {
          label: "English",
          lang: "en",
        },
      },
      sidebar,
      editLink: {
        baseUrl: "https://github.com/fairyshine/OpenAgentHarness/edit/master/apps/docs/src/content/docs/",
      },
    }),
  ],
});
