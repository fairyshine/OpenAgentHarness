# CLI Architecture

这份文档约定 `@oah/cli` 的长期代码边界。目标是让命令行能力、API 通信、TUI 状态机和 Ink 展示组件可以持续演进，同时继续向 Claude Code 的极简 TUI 体验靠近。

## 当前目录

```text
src/
  index.ts                 # bin 入口，只负责启动和顶层错误处理
  cli/
    program.ts             # commander 命令注册、全局参数、命令级 lazy import
  api/
    oah-api.ts             # OAH HTTP/SSE facade，隐藏 fetch、分页和事件流细节
  tui/
    launcher.tsx           # Ink render 配置
    OahTui.tsx             # TUI 应用容器：状态、effects、输入调度、页面组装
    components/
      dialogs.tsx          # workspace/session/help 弹层
      messages.tsx         # transcript、状态行、运行中提示
      prompt.tsx           # 底部输入框和 slash suggestions
    domain/
      types.ts             # TUI 本地模型
      utils.ts             # 纯函数：输入处理、窗口裁剪、消息/事件映射
```

## 依赖方向

依赖只能从外层流向内层，避免循环和“展示组件偷偷发请求”：

```text
index.ts -> cli/program.ts -> api/oah-api.ts
                         \-> tui/launcher.tsx -> tui/OahTui.tsx

tui/OahTui.tsx -> tui/components/*
tui/OahTui.tsx -> tui/domain/*
tui/components/* -> tui/domain/*
```

约束：

- `src/index.ts` 保持极薄，不注册命令、不 import Ink、不 import API 客户端。
- `src/cli/*` 只处理命令参数、输出格式和命令分发；非 TUI 命令不要 import Ink/React。
- `src/api/*` 不依赖 React/Ink/commander，只暴露稳定的 TypeScript API。
- `src/tui/components/*` 是展示组件，不直接调用 `OahApiClient`，不持有跨组件业务状态。
- `src/tui/domain/*` 只放纯类型和纯函数，优先保证可单测。
- `src/tui/OahTui.tsx` 目前是控制器；继续变大时优先拆输入处理和数据状态，不把逻辑塞回组件。

## 新增 CLI 命令

1. 在 `src/cli/program.ts` 注册命令。
2. 简单命令可以直接 lazy import `src/api/oah-api.ts`。
3. 命令逻辑超过约 80 行时，拆到 `src/cli/commands/<name>.ts`，`program.ts` 只负责注册。
4. 输出纯文本的命令保持稳定、可脚本化；需要交互时进入 TUI，不在普通命令里混入 Ink。

## 新增 TUI 功能

TUI 的默认屏幕保持 Claude Code 风格：上方 transcript，中间只在需要时展开底部 pane，底部 prompt 常驻。新增能力优先按下面顺序落位：

1. 纯数据转换、输入字符串处理、列表裁剪：放 `tui/domain/utils.ts`，或拆成更小的 `tui/domain/*.ts`。
2. 单纯展示：放 `tui/components/*`。
3. 需要 API、stream、当前 workspace/session 的状态：先放 `OahTui.tsx`。
4. 当 `OahTui.tsx` 超过约 500 行或出现第二组复杂状态机时，拆到 hooks：
   - `tui/state/use-workspaces.ts`
   - `tui/state/use-sessions.ts`
   - `tui/state/use-session-stream.ts`
   - `tui/input/use-tui-input.ts`

## API 层演进

`OahApiClient` 先作为 facade 保持稳定，避免调用方到处拼 URL。后续接口继续增加时再按职责拆分：

```text
api/
  http.ts                  # request、joinUrl、readJsonResponse
  sse.ts                   # consumeSse、SSE frame parsing
  oah-api.ts               # facade：组合 workspaces/sessions/runs/actions
```

对外优先保留 `OahApiClient`，内部怎么拆不影响 CLI/TUI。

## 测试策略

- `tui/domain/*` 和 `api/sse` 是优先单测对象。
- Ink 组件先用 TypeScript 检查和人工 smoke test；复杂展示稳定后再加 snapshot 或组件级测试。
- 每次改 CLI/TUI 至少运行：

```bash
pnpm --filter @oah/cli exec tsc --noEmit -p tsconfig.json
pnpm dev:cli -- --help
```

涉及 runtime/workspace/session 行为时，再运行：

```bash
pnpm dev:cli -- --base-url http://localhost:8787 tui
```

## 维护红线

- 单文件超过约 400 行就要考虑拆分；超过约 600 行必须拆。
- 不把 web 端专属 UI 概念搬进 CLI；CLI 只复用领域能力和 API 语义。
- 不在 TUI 里重新实现一套后端契约类型；优先使用 `@oah/api-contracts`。
- 不让 workspace/catalog/session 三套概念在 TUI 主界面并列铺开；主界面只围绕当前 workspace 的当前 session 工作。
