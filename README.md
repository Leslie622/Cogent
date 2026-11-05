# Cogent

基于 **Electron + [pi](https://github.com/earendil-works/pi)** 的 Agent 桌面应用，前端使用 **React + shadcn/ui**。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面壳 | Electron 45（ESM 主进程，内置 Node 24） |
| Agent 运行时 | [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi)（Agent 循环、工具执行、事件流） |
| LLM 接入 | [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi)（统一多 Provider API，流式 + 工具调用） |
| 工具 Schema | `@earendil-works/pi-schema`（JSON Schema 构建器） |
| 前端 | React 19 + Tailwind CSS v4 + shadcn/ui（new-york / neutral） |
| 构建 | electron-vite 6 + Vite 8，TypeScript 严格模式 |

## 架构

```
┌────────────────────────── Renderer (React + shadcn) ──────────────────────────┐
│  App.tsx                                                                     │
│   ├── hooks/use-agent.ts   订阅 AgentEvent 流，折叠成会话条目（消息/工具卡片）  │
│   └── components/chat/*    MessageList / Composer                            │
└──────────────▲───────────────────────────────────┬───────────────────────────┘
               │ agent:event (事件推送)              │ agent:status / prompt / abort
┌──────────────┴───────────────────────────────────▼───────────────────────────┐
│  Preload (contextBridge, 暴露 window.cogent 窄接口)                            │
└──────────────▲───────────────────────────────────┬───────────────────────────┘
               │                                    │
┌──────────────┴────────────────────────────────────▼──────────────────────────┐
│  Main (Electron 主进程)                                                      │
│   ├── ipc.ts               IPC 桥：handle 请求 + webContents.send 事件转发     │
│   └── agent/                                                                │
│       ├── runtime.ts       pi Agent 单例：systemPrompt / prompt / abort       │
│       ├── models.ts        pi-ai Models 集合：Provider 注册 + 默认模型解析     │
│       └── tools/           AgentTool 定义（tools/index.ts 汇总注册）           │
└──────────────────────────────────────────────────────────────────────────────┘
```

**数据流**：renderer 调 `window.cogent.send(text)` → main 触发一轮 agent run（不阻塞 IPC 响应）→ pi Agent 事件流（`text_delta` / `tool_execution_*` / `message_end` …）经 `agent:event` 推回 renderer → `use-agent` 钩子把事件流折叠成 UI 状态。

**关键决策**：

- **主进程为 ESM**：pi 系列包是 ESM-only（exports 只有 `import` 条件），因此整个工程 `"type": "module"`，preload 输出为 `.mjs`（ESM preload 要求 `sandbox: false`；`contextIsolation` 始终开启，renderer 只能访问 preload 暴露的窄接口）。
- **pi 依赖保持 external**（`externalizeDepsPlugin`）：pi-ai 的 Provider SDK 是懒加载的，打进 bundle 会破坏这一机制；运行时直接从 `node_modules` 加载。
- **IPC 契约集中在 `src/shared/ipc.ts`**：三端共用的 channel 名与类型，只放类型和常量，无运行时依赖。

## 目录结构

```
├─ electron.vite.config.ts      # 三目标构建配置（main / preload / renderer）
├─ components.json              # shadcn CLI 配置
├─ src/
│  ├─ shared/ipc.ts             # IPC 契约（channel 名 + 类型）
│  ├─ main/
│  │  ├─ index.ts               # 应用入口、窗口创建
│  │  ├─ ipc.ts                 # IPC 注册与事件转发
│  │  └─ agent/
│  │     ├─ runtime.ts          # pi Agent 运行时（单例）
│  │     ├─ models.ts           # Provider 注册、默认模型解析
│  │     └─ tools/              # AgentTool 定义
│  ├─ preload/index.ts          # contextBridge → window.cogent
│  └─ renderer/
│     ├─ index.html
│     └─ src/
│        ├─ App.tsx
│        ├─ globals.css         # Tailwind v4 + shadcn 主题变量
│        ├─ components/ui/      # shadcn 组件
│        ├─ components/chat/    # 会话界面
│        ├─ hooks/use-agent.ts  # Agent 事件流 → UI 状态
│        └─ lib/                # cn() / IPC client
```

## 快速开始

```bash
npm install

# 配置任一 Provider 的 API Key（Anthropic / OpenAI / Z.AI）
set ANTHROPIC_API_KEY=sk-...     # Windows CMD（或对应的环境变量设置方式）

npm run dev                      # 启动开发模式（HMR）
```

常用脚本：

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 开发模式（renderer HMR + 主进程热重启） |
| `npm run build` | 产出 `out/`（main / preload / renderer） |
| `npm run start` | 运行已构建产物 |
| `npm run typecheck` | 两个 TS 工程分别做严格类型检查 |

> 国内网络如果 Electron 二进制下载失败：
> `cd node_modules/electron && ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node install.js`

## 如何扩展

**新增工具**：在 `src/main/agent/tools/` 下新建文件，导出 `AgentTool`（parameters 用 `pi-schema` 构建，`execute` 失败直接 throw），然后在 `tools/index.ts` 的数组里加入。

**新增 LLM Provider**：在 `src/main/agent/models.ts` 注册工厂（`@earendil-works/pi-ai/providers/*`，或用 `createProvider()` 接任意 OpenAI/Anthropic 兼容端点），并在 `PROVIDER_SETUP` 里补一条凭据/默认模型配置。

**添加 shadcn 组件**：`npx shadcn@latest add button dialog ...`（别名已通过根 tsconfig 的 paths 配置好）。

**多会话**：目前 `runtime.ts` 持有单个 `Agent` 单例；做多会话时改为 `Map<sessionId, Agent>`，并考虑引入 `@earendil-works/pi-durable` 做会话持久化。

**打包分发**：接入 electron-builder / electron-forge（当前脚手架未包含，避免无关依赖）。

## 安全说明

- `contextIsolation: true`、`nodeIntegration: false`；renderer 无法直接触达 Node API。
- preload 因 ESM 需要 `sandbox: false`（Electron 限制），但只暴露 4 个方法的白名单接口。
- 生产环境建议在 `index.html` 补充 CSP 策略（开发模式受 Vite HMR 限制未启用）。
