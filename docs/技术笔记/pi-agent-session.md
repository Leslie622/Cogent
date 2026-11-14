# 笔记：pi AgentSession 托管机制

> 对应决策：全局架构 D5/D6（内核 = pi coding-agent AgentSession，Cogent
> 不写第二个内核）。落点：`src/host/kernel/pi-session-factory.ts`（装配）、
> `src/host/runtime/session.ts`（会话域服务）。前置：[kernel-contract.md](kernel-contract.md)
> （南缝合同）、[pi接入与会话管理.md](pi接入与会话管理.md)（pi 核心机制）。

## 1. 问题：全托管 vs 自组装，谁拥有转录

pi 的核心 `Agent` 只是循环引擎；`AgentSession`（agent-session.ts）是它上面的
**全托管层**：自己装配 Agent、把每条消息 append 进会话树（SessionManager
JSONL）、在 prompt() 的 Promise 生命周期内自管压缩 / 溢出恢复 / provider
重试。消费方若绕过它直接组装 Agent 并原位改 `agent.state.messages`，与
事件驱动的追加树必然分叉（改动永远不落树）。所以 Cogent 的选择是**全托管 +
窄合同**：SessionManager 只经 kernel/contract.ts 驱动 AgentSession，自己保留
的运行期逻辑只有 AUTO_CONTINUE 续写（显式 user 消息，兼容 append-only 树）
与审批挂起（链式 beforeToolCall）。

## 2. 托管语义（pi 1.5.2 实证）

### 2.1 prompt() 生命周期与终态纪律

`_startRun`（agent-session.ts:1943）：`await agent.prompt()` 后进 post-run 循环
（`_handlePostAgentRun` → 溢出恢复 / 阈值压缩 / 队列派发 → `agent.continue()`），
finally 里 `_emitAgentSettled`。**`agent_settled` 每轮 prompt 恰好一次，晚于全部
内聚恢复** —— 它是天然的单一权威终态：协议 run.completed/run.failed 的发射点
钉在这里，溢出/续写窗口不存在终态竞态。

### 2.2 压缩：reserve 触发线 + 固定 keep 窗 + split-turn

- 触发：`contextTokens > contextWindow − reserveTokens(16384)`（compaction.ts:269）；
- 切点：`findProjectedCutPoint` 从尾累计 `estimateTokens`（**chars/4 口径**，
  compaction.ts:300-349 —— 与 estimateContextTokens 的 usage 锚定口径不同源），
  跨过 keep(20000) 的条目处取**切点集合中首个 ≥ 它的条目**；user/assistant 都是
  切点，user 是 turn start，assistant 不是；
- **split-turn**：切点落在回合中段（assistant / 空条目）时，pi 把该回合前缀单独
  做 turn-prefix 摘要（TURN_PREFIX_SUMMARIZATION_PROMPT，"Turn Context (split
  turn)" 标记）。**空条目陷阱**：树里若有 model_change 等空消息条目，切点的
  "空条目回退"（844-849 行）会把切点挪到空条目上，`startsTurn(空条目)` 恒
  false → 误判 split-turn。教训：**pi 树对"每次调用落一条"的 API 要按需调用**
  （setModel/setThinkingLevel 判等再调）；
- **keep 固定 20000**（不随窗口缩）：小窗（ctx ≤ keep）会「触发线早早响、
  压缩无可压缩收场」—— Cogent 的缓解 = factory 链式包裹 getCompactionSettings
  做小窗自适应（keep = min(keep, ctx/2)、reserve = min(reserve, ctx/4)）；
- 摘要请求：被摘要消息**文本化序列化**进 `<conversation>` 标签 + 指令作末条
  user（buildSummarizationContext，compaction.ts:682）—— 官方防续写手法。

### 2.3 length 双层自愈

pi 对 length 停因有两层：带 toolCall 的消息直接 fail + 自愈重发（agent-loop 层）；
纯文本且 `usage.output < maxTokens`（isRecoverableLength，pi-ai overflow.js:177）
判定"输出低于本愿上限"→ omit 截断消息 + 压缩 + continue 重试（_checkCompaction
case 1）。**真实端点的贴上限 length 不满足 recoverable**（输出 = 上限），此时
Cogent 的 AUTO_CONTINUE 接管（显式 user 续写指令，无缝拼接语义）；mock 环境
要带满额 usage（tests/integration/compaction.test.ts textResponse 注释）。

### 2.4 呈现口径 vs 上下文口径（两套投影）

pi 的 `agent.state.messages`（= buildSessionProjection）是**上下文口径**：压缩后
影子区（被摘要的旧历史）不进请求、也不在投影里。Cogent 的历史回查是**保留式
呈现**（被摘要区原文照旧可滚，D9）。所以 `messages()` 恒走 pi JSONL 全量回查
（factory 的 `readPiTranscript`：遍历 getBranch 条目自投影，影子区/多代压缩条
全保留）；pi 未装配（惰性会话）同路 —— 只读路径不装配完整内核。

### 2.5 会话文件寻址

pi 会话文件 = `<ISO时间戳>_<sessionId>.jsonl`（session-manager newSession
:712），按 id 找文件要 `endsWith('_'+id+'.jsonl')`，精确名查不到（delete 的
rmSync 同理）。会话 id 经 `SessionManager.create(cwd, dir, {id})` 显式对齐
Cogent uuid。

## 3. 装配纪律（pi-session-factory.ts）

- **凭据**：ModelRuntime 全内存（空 CredentialStore + setRuntimeApiKey overlay，
  host-main.ts 的凭据 sink 三入口联动：initialize / credentials.set / remove 都
  await 应用后再生效）—— 绝不读写 ~/.pi 的 auth.json；
- **custom/\* 双注册**：同一 `createProvider` 实例既 `models.setProvider`（UI 目录）
  又 `modelRuntime.registerNativeProvider`（pi 请求路由）—— 单一构造源，两套
  目录永不分叉。内置 provider 不需要：覆盖值写在 Model.baseUrl 上随请求透传；
- **审批（D8）**：**链式包裹 `agent.beforeToolCall`** 而非 InlineExtension 的
  tool_call 事件 —— pi AgentSession 装的扩展分发器**丢弃核心循环传入的 abort
  signal**（agent-session.ts:719 形参无 signal），挂起审批在中止时会永悬；链式
  包裹保住 pi 原钩子（扩展链不失联）且拿回 signal（agent-loop.ts:738 传入）；
- **观测三钩**：sdk.ts 构造 Agent 时已占用 onPayload/onResponse/
  onProviderStreamEvent 做扩展事件桥 —— 直赋会拆 pi 接线，必须链式包裹
  （观测先行、原钩子后行、透传返回值）；
- **系统提示词**：systemPromptOverride 整体注入；pi 自动追加 cwd 环境段
  （重复声明无害，自拼提示词已对账去重）；
- **权限通告**：内联扩展挂 `before_agent_start`，每轮按活 mode 设
  `systemPromptOptions.sections.cogent_permission`（pi 对 sections「变更才追加
  patch、回放按名替换」—— 切换下一轮生效、不堆积）。systemPromptOverride
  动态拼段不可行（loader 只在 reload 求值）；
- **v1 旧转录**：装配时一次性导入 pi 树（legacy-import.ts：compactionSummary →
  appendCompaction(null)、其余角色 appendMessage），盘上文档随之重写 v2
  （summary-only）。

## 4. 对比

| | 内核形态 | 转录真源 | 终态 |
| --- | --- | --- | --- |
| pi AgentSession（Cogent 现行） | 全托管：压缩/恢复/重试内聚于 prompt 生命周期 | 会话树 JSONL（追加式） | agent_settled 单点 |
| 自组装 Agent（pi 核心层直接用） | 调用方自管 convertToLlm/压缩/溢出/落盘 | 调用方自选（易与事件追加分叉） | 自定义 |
| Claude Code | 进程内 agent，转录 JSONL --resume | 同 pi 形态 | - |
| Pi-meme | SdkSession 内嵌 worker，Host 只见 HostApi | Host 侧自管 | - |

## 5. 在 Cogent 的落点

`kernel/pi-session-factory.ts`（装配 + readPiTranscript + settings 自适应包裹）、
`runtime/session.ts`（SessionManager：受理/转译/终态/AUTO_CONTINUE）、
`kernel/legacy-import.ts`（v1 转录导入）。冒烟 = tests/integration/
{compaction,tools,approval-upgrade,pi-bin-domain}.test.ts。
