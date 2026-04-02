# Open Agent Harness

<div class="hero" markdown>
### 一个给 Agent 产品用的后端

如果你在做企业级的 Agent 产品，这个项目就是帮你把后端那一层先搭起来。

它最适合两类需求：
- 大量 workspace 并行使用，而不是只服务一个本地 agent
- 高自由度定制，你可以自己决定 agent、model、action、skill、tool、hook 怎么组织

[5 分钟上手](./getting-started.md){ .md-button .md-button--primary }
[查看架构](./architecture-overview.md){ .md-button }

</div>

> 你可以把它理解成：一个可部署的 Agent 后端骨架。  
> 你做产品界面和业务编排，它负责把大量 workspace 并行运行这层撑起来，而且不限制你怎么定制 Harness。

## 这个项目到底是干嘛的

假设你要做一个企业内部平台，或者一个面向团队的大规模 Agent 产品。

通常你很快会遇到这些问题：

- 怎么让很多 workspace 同时运行，而不是一个一个手工开
- 怎么让不同 workspace 拥有不同 agent、model、skill、tool 组合
- 怎么在企业环境里保持统一运行，又允许每个团队高度定制
- 怎么避免被某个固定 UI 或固定工作流绑死
- 怎么在规模上去之后还保持可部署、可扩展、可治理

Open Agent Harness 就是专门解决这些问题的。

它本身不做你的产品界面，而是负责把 Agent 后端这层通用能力搭好。

## 两个最重要的特点

### 1. 企业级大量 workspace 并行

它不是围绕“单个本地 agent”来设计的，而是围绕大量 workspace 同时被使用来设计的。

更适合：

- 企业内部平台
- 多团队共享的 Agent 系统
- 需要同时服务很多 workspace、很多用户、很多运行任务的场景

### 2. 自由的 Harness 设计

它不是一个强约束的 Agent 软件，而是一个更自由的 Harness 框架。

你可以自己决定：

- 接什么前端
- 用什么 agent 组织方式
- 怎么组合 model、action、skill、tool、hook
- 怎么部署成一体模式或拆分模式

## 为什么叫 Harness

业内对 “Agent Harness” 的常见理解，不是一个聊天界面，也不是单纯的模型封装，而是包在模型外面的那层运行基础设施。

它通常负责这些事：

- 管理 agent 的执行循环
- 接工具、接状态、接记忆
- 处理错误恢复、权限和安全边界
- 让 agent 能长期、稳定地完成任务

Open Agent Harness 的定位就是这一层。

## 和很多 Agent 软件有什么不一样

很多 Agent 软件更偏向“现成产品”或“固定工作流”：

- 你先接受它的交互方式
- 接受它预设好的能力组织方式
- 再在它给定的边界里做定制

Open Agent Harness 反过来，它更像一个运行时框架：

- 不绑死 UI，你可以接自己的 Web、桌面端、CLI 或自动化系统
- 不绑死能力模型，agent、model、action、skill、tool、hook 都可以自己组织
- 不绑死部署方式，本地可以一体跑，生产可以拆成 API + Worker
- 不强迫你走单一路径，更适合企业内部集成和深度定制

换句话说，它更适合“我想自己做产品，但不想重复造 Agent 后端轮子”的团队。

## 什么时候适合用它

- 你在做企业内部平台，或者面向团队/组织的 Agent 产品
- 你需要支撑大量 workspace 并行，而不是单项目单实例
- 你已经有自己的前端，缺的是可扩展的 Agent Harness
- 你不想把能力全写死在一个本地脚本或固定产品里
- 你希望模型、工具、Action、Skill、Tool 的组合方式足够自由

## 什么时候不适合

- 你只是想要一个现成聊天 UI
- 你只做单机临时脚本，不关心部署和多人使用
- 你现在只需要一个最小 demo，不需要大规模 workspace 和高度定制能力

## 先看哪里

| 你现在想做什么 | 从这里开始 |
| --- | --- |
| 先把项目跑起来 | [快速开始](./getting-started.md) |
| 只想把一个 workspace 直接跑成后端 | [部署与运行](./deploy.md) 中的 single workspace |
| 看本地和生产怎么部署 | [部署与运行](./deploy.md) |
| 看这个系统怎么支撑大规模 workspace | [架构总览](./architecture-overview.md) |
| 配 workspace、agent、model、skill | [Workspace 导航](./workspace/README.md) |
| 看 Harness 能怎么自由定制 | [设计总览](./design-overview.md) |

## 最短上手命令

```bash
pnpm install
pnpm infra:up
pnpm dev:server -- --config ./server.example.yaml
pnpm dev:web
```

启动后常用地址：

- 调试 Web 控制台：[http://localhost:5174](http://localhost:5174)
- 后端默认地址：`http://127.0.0.1:8787`

如果你只是想看文档站本地效果：

```bash
python3 -m pip install -r docs/requirements.txt
mkdocs serve
```
