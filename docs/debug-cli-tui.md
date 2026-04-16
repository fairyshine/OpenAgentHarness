# Debug CLI And TUI

## 定位

OpenAgentHarness 本身仍然是 headless runtime，不提供正式产品 UI。

但为了调试、开发和排障，建议提供一个轻量的调试工具：

- `oah` CLI
- `oah tui`

它的定位是：

- 调试入口
- 本地开发工具
- 运维排障工具

而不是：

- 正式终端产品
- 面向最终用户的聊天客户端
- 配置后台或管理平台

## 为什么优先 TUI

相比 Web UI，TUI 更适合当前系统：

- 贴合 headless runtime 定位
- 更容易接入本地目录、shell、Unix Socket 和日志流
- 不需要先处理前端鉴权、静态资源和部署问题
- 对开发者来说，终端内调试 action、model gateway、hook、run 更顺手

## 工具形态

建议采用同一个二进制入口：

- `oah`

分成两层：

- CLI
  - 适合脚本化和单次调试
- TUI
  - 适合实时观察和交互式排障

## CLI 命令结构

建议命令树：

```text
oah
  tui
  workspace list
  workspace inspect
  catalog show
  session create
  session inspect
  action run
  model generate
  model stream
  run inspect
  run cancel
```

### 推荐首批命令

- `oah tui`
  - 启动调试 TUI
- `oah workspace list`
  - 列出已发现 workspace
- `oah catalog show --workspace <id>`
  - 查看当前 workspace 的 agents / models / actions / skills / tools / hooks
- `oah session inspect --workspace <id>`
  - 直接发起交互式对话
- `oah action run --workspace <id> --action <name>`
  - 手动触发 action
- `oah model generate --model <name>`
  - 调用内部模型网关
- `oah run inspect --run <id>`
  - 查看 run、step、tool call、hook 和错误信息

## TUI 页面建议

建议最少包含以下区域：

- Workspace 列表
- Catalog 面板
- Session / Chat 面板
- Run 时间线
- 日志 / 事件面板

### 1. Workspace 列表

展示：

- workspace 名称
- `kind`
- `rootPath`
- `defaultAgent`
- `readOnly`

用途：

- 快速切换当前调试对象

### 2. Catalog 面板

展示：

- agents
- models
- actions
- skills
- tools
- hooks

用途：

- 直接确认当前 workspace 实际加载到了什么
- 排查覆盖、冲突和缺失定义

### 3. Session / Chat 面板

能力：

- 创建 session
- 发送消息
- 实时查看 SSE 输出
- 切换 agent

说明：

- 对常规 workspace，这里是主要调试界面之一
- 对 `project` workspace，可同时观察普通对话和工具调用结果

### 4. Run 时间线

展示：

- run 状态变化
- model call
- tool call
- action run
- hook run
- agent switch
- subagent delegate / await

用途：

- 快速定位某一步卡住、失败或超时的位置

### 5. 日志 / 事件面板

展示：

- SSE 事件
- 结构化日志摘要
- 错误码
- 最近失败原因

## 特别有价值的调试能力

建议优先支持：

- 查看最终可见 model catalog
- 查看最终可见 agent catalog
- 查看 workspace 自动发现结果
- 查看配置解析错误
- 查看当前 run 选中了哪个模型
- 查看最终 prompt 拼装顺序和段来源
- 直接测试内部模型网关
- 查看 action 注入的环境变量摘要

## 与现有系统的关系

CLI/TUI 只消费已有能力，不新增一套并行运行时。

它主要依赖：

- 对外 OpenAPI
- SSE
- 内部模型网关
- 服务端 catalog 发现结果

建议原则：

- 能复用已有 HTTP / SSE 接口，就不要额外造私有协议
- CLI/TUI 仅在“本机调试能力”场景下使用内部模型网关

## 与模型网关的关系

`oah model generate` 与 `oah model stream` 直接调用：

- `/internal/v1/models/generate`
- `/internal/v1/models/stream`

因此 CLI/TUI 也是内部模型网关的第一个官方客户端。

## 边界

CLI/TUI 不负责：

- 用户体系
- 多租户后台
- 权限管理台
- 长期聊天产品体验

它只负责：

- 调试
- 验证
- 观察
- 排障

## 实现建议

技术上建议：

- CLI 参数层：`commander` 或 `cac`
- TUI：`ink` 或 `blessed`
- SSE：直接复用现有事件流协议
- 本地模型调用：复用内部模型网关

## 实施优先级

建议顺序：

1. 先做 CLI
2. 在 CLI 基础上补 `oah tui`
3. 先保证 catalog、session inspect、run inspect、model generate 可用
4. 再补 hooks、subagent、prompt compose 可视化
