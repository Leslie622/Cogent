# 路线 — Cogent

## 已实现

- 窗口壳（`electron/main/index.ts`）与生命周期
- 引擎进程与 stdio JSON-RPC 主循环（`agent-service/index.ts`，`initialize` 已可用）
- main 引擎代理（spawn + Node 版本守卫 + 握手 + 事件出口）
- `app:status` IPC 域 + preload `getStatus`（诊断位）
- ESLint 类型感知规则（防御政策机械强制）
- 空白 renderer（React + Tailwind + shadcn 主题就位）

## 空位（建议实现顺序，均为未写状态）

1. `protocol`：消息域类型细化（content blocks、消息模型）
2. `agent-service/runtime/`：SessionManager + pi Agent 接入
   （每会话一实例，pi 事件转译为协议事件）
3. `agent-service/storage/`：StorageDriver 接口 + 本地 JSON 实现
4. `agent-service/tools/`：工具注册 + `ToolKind` 分级 + 审批拦截点（发 `approval.request`）
5. `electron/main/credentials/`：safeStorage 凭据存取（握手时注入引擎）
6. `renderer`：壳层布局 + zustand store + 事件订阅（等页面指令再动）

> 每完成一项：勾掉并在「已实现」补一行；架构有变先改 architecture.md。
