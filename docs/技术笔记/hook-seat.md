# 钩子座：Agent 循环的干预缝（hook-seat）

> 对应模块页 [../模块/钩子座.md](../模块/钩子座.md)；实现文档
> [../计划/钩子座实现.md](../计划/钩子座实现.md)（2026-11-16，阶段 4d）。

## 1. 问题

Agent 宿主必须能在循环的关键时刻插手：工具执行前拦下来问用户（审批）、
每轮开跑前改提示词（段注入）、旁观全部流量（审计）。关键是这些干预挂在哪里、
用什么形状挂 —— 挂错缝的代价具体得很：pi 的扩展 `tool_call` 事件拿不到
abort signal，挂起审批遇「停止」就永悬。

## 2. pi 的做法（源码口径，锚点 74dcca7d4 → HEAD 827383a15）

- **事件面**：`core/extensions/types.ts:1426-1458` 共 32 个事件
  （1.5.2 与 HEAD 一致）。四类干预各对官方缝：`before_agent_start`（段）、
  `context` / `context_with_system`（每次 LLM 调用前改 messages）、
  `tool_call` / `tool_result`（拦截）、`before_provider_request` /
  `after_provider_response` / `provider_stream_event`（厂商标量）。
- **signal 断链**：loop 层传 signal（`agent-loop.ts:745`），但
  `AgentSession` 适配器是 `(context) => this._beforeToolCall(context)`
  单参（HEAD `agent-session.ts:716`，installed 1.5.2 dist 同）—— 扩展
  handler 看不到 signal。锚点后唯一相关修复 `4438c58ba` 只保证「已中止
  信号量下未执行的调用合成错误结果」（agent-loop.ts:718,747 前后各查
  一次 aborted），**挂起中的 handler 永不 resolve 时依旧永悬**。
- **注册形状**：`InlineExtension = ExtensionFactory | { name, factory, ... }`
  （types.ts:1564）；`bindExtensions({ mode: 'rpc' })` 后扩展才收
  session_start（不调 = 挂它的扩展零初始化，Cogent 4a-1 实测）。

## 3. 对比

- **Pi-meme**（`pi-runtime/src/sdk/session.ts:570-795`）：单内联工厂集中
  注册全部 `pi.on(...)`（context 门控 / 目标限流 gate / sections / model
  同步）——「一个具名装配点」的形状先例，Cogent 的 createCogentHooks 同款。
- **zcode**（core/src/）：7 事件 hook 系统（SessionStart/PreToolUse/
  PermissionRequest/PostToolUse/…，`contracts/hooks/index.ts:7-15`），分发器
  **带 signal + 每钩超时 + onError:deny fail-closed**（`hooks/runner.ts:382-527`）；
  审批双应答方竞速（broker 用户 vs PermissionRequest hook 自动应答，
  `permission-responder-race.ts:38-93`）；「放行也留痕」—— 每次判定
  `tool.permission.evaluated` 结构化日志 + PermissionRequested/Resolved
  事件对（`permission-flow.ts:199-218,338-358`）。
- **dsh**（deepseek-harness）：审批是 seam（定义/提供/消费三角色，
  `docs/glossary.md:9`）；`approval/asked`+`approval/decided` 成对落
  Session 事件流、turn 包围、**审计写不进就拒绝返回决策**
  （`user-approval/src/index.ts:225-251`）；取消语义最完整：signal 是
  事件 payload 一等字段、挂起与 abort 竞速 + 迟到答案构造性丢弃
  （`index.ts:320-333`）、按 bodyInvoked 分 ABORTED/ABORTED_BEFORE_DISPATCH
  两码保证重放合法。

## 4. 取舍

- **审批走链式包裹不走扩展事件**：pi 的 signal 断链是真墙（§2），
  zcode/dsh 的分发器都带 signal —— pi 修了再迁，升级时重查。
- **signal 竞速语义沿用 Cogent 既有实现**（早于本座）：session.ts 挂起时
  注册 abort listener、与 respondApproval 先到先得 —— 与 dsh 同构，没重造。
- **审计采 dsh 的配对纪律、不采它的 CI 守卫**：Cogent 钩子消费者全是
  Host 内部，三角色对账用文档表格就够（模块页）。
- **厂商标量不迁扩展总线**：`onPayload(payload, model)` 带 model 上下文，
  事件版只有 payload —— 数据保真 > 形状统一。
- **不建 matcher/超时/进程级 hook 配置**（zcode 有）：无第三方 hook
  来源，此复杂度无收益面。

## 5. 在 Cogent 的落点

- `src/host/runtime/hook-seat.ts`：createCogentHooks（具名扩展：段注入 +
  context 预留缝）+ wrapApprovalChain（审批包裹器）；
- `src/host/kernel/pi-session-factory.ts`：extensionFactories 换具名工厂、
  审批包裹一行挂装；
- `src/host/runtime/session.ts`：decideApproval 全路径审计点（plan/auto/
  autonomous/规则/ask 五路）+ respondApproval / abort listener /
  settleApprovals 三收尾；pendingApprovals 条目补 toolName；
- `src/host/runtime/inspector.ts`：approvalAsked / approvalDecided +
  VERDICT_LABELS；`src/protocol/types.ts`：`approval.asked` /
  `approval.decided` 两 kind（additive）；renderer `kinds.ts` 呈现。
- 测试：`inspector.test.ts`（单测 3）+ `approval-upgrade.test.ts` S8
  （集成回查五条裁决路径）。
