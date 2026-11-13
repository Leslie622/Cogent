# 笔记：pi 内核替换 —— 手搓 Agent 层让位 AgentSession（阶段 1.2a）

> 对应计划：`docs/计划/全局架构.md` 阶段 1.2。落点：`src/host/kernel/pi-session-factory.ts`
> （装配）、`src/host/runtime/session.ts`（托管层手术）、`src/host/index.ts`
> （ModelRuntime + 凭据 sink）。前置：[kernel-contract.md](kernel-contract.md)
> （南缝合同）、[pi接入与会话管理.md](pi接入与会话管理.md)（pi 核心机制）。

## 1. 问题：为什么必须整体换，而不是逐块借

手搓时代的 session.ts 直接组装 pi 的**核心 Agent**（new Agent + 自己管 convertToLlm /
beforeToolCall / 压缩 / 溢出恢复 / 落盘）。pi coding-agent 的 `AgentSession`
（agent-session.ts）是**全托管层**：它自己装配 Agent、把每条消息 append 进会话树
（SessionManager JSONL）、在 prompt() 的 Promise 生命周期内自管压缩 / 溢出恢复 /
provider 重试。两层在"谁拥有转录"上必然冲突 —— 手搓的原位 splice 改
`agent.state.messages`，pi 的事件驱动追加永远看不到这些改动（分叉）。所以 1.2a
是原子切换：手搓压缩四方法、溢出恢复、落盘、审批挂起全部让位，Cogent 保留的
运行期逻辑只剩 AUTO_CONTINUE 续写（显式 user 消息，兼容 pi 树）与审批判定。

## 2. pi AgentSession 的托管语义（1.5.2 实证）

### 2.1 prompt() 生命周期与终态纪律

`_startRun`（agent-session.ts:1943）：`await agent.prompt()` 后进 post-run 循环
（`_handlePostAgentRun` → 溢出恢复 / 阈值压缩 / 队列派发 → `agent.continue()`），
finally 里 `_emitAgentSettled`。**`agent_settled` 每轮 prompt 恰好一次，晚于全部
内聚恢复** —— 它是天然的单一权威终态。Cogent 的 run.completed/run.failed 发射点
从旧 agent_end 迁到 agent_settled 后，"溢出 / 续写窗口的终态抑制竞态"（旧实现
最绕的一段）整体消解。

### 2.2 压缩：reserve 触发线 + 固定 keep 窗 + split-turn

- 触发：`contextTokens > contextWindow − reserveTokens(16384)`（compaction.ts:269）；
- 切点：`findProjectedCutPoint` 从尾累计 `estimateTokens`（**chars/4 口径**，
  compaction.ts:300-349 —— 与 estimateContextTokens 的 usage 锚定口径不同源），
  跨过 keep(20000) 的条目处取**切点集合中首个 ≥ 它的条目**；user/assistant 都是
  切点，user 是 turn start，assistant 不是；
- **split-turn**：切点落在回合中段（assistant / 空条目）时，pi 把该回合前缀单独
  做 turn-prefix 摘要（TURN_PREFIX_SUMMARIZATION_PROMPT，"Turn Context (split
  turn)" 标记）—— 上游为命中预算的复杂度，手搓版当年明确裁剪掉；
- **keep 固定 20000**（不随窗口缩）：小窗（ctx ≤ keep）的常规被摘要料区间为空，
  触发线早早响但压缩以「无可压缩」收场，直到转录超 keep —— 与手搓
  `keep=min(20K, ctx/2)` 的行为差异是 1.4 的 CompactionSettings 对账点；
- 摘要请求：被摘要消息**文本化序列化**进 `<conversation>` 标签 + 指令作末条
  user（buildSummarizationContext，compaction.ts:682）—— 手搓 R4 撤掉的正是
  这个 pi 官方防续写手法，1.2a 起回归 pi 原生。

### 2.3 length 双层自愈

pi 对 length 停因有两层：带 toolCall 的消息直接 fail + 自愈重发（agent-loop 层）；
纯文本且 `usage.output < maxTokens`（isRecoverableLength，pi-ai overflow.js:177）
判定"输出低于本愿上限"→ omit 截断消息 + 压缩 + continue 重试（_checkCompaction
case 1）。**真实端点的贴上限 length 不满足 recoverable**（输出 = 上限），此时
Cogent 的 AUTO_CONTINUE 接管（显式 user 续写指令，无缝拼接语义）；mock 环境要
对齐该形态需在 length 响应里带满额 usage（tests/integration/compaction.test.ts
textResponse 注释）。

## 3. 手术的三个真 bug（集成测试挖出，全部引擎侧修复）

### 3.1 setModel 空条目 → split-turn 误判（最隐蔽）

**现象**：全部压缩走 turn-prefix 路径，整回合摘要结构永不出现。
**链路**：Cogent 每 submit 无条件 `pi.setModel(model)` → pi 落一条 model_change
**空消息条目**进会话树 → findProjectedCutPoint 末段有"空条目回退"（把切点从
user 边界向前挪过空条目，844-849 行）→ 切点落到空条目上 → `startsTurn(空条目)`
恒 false → 误判 split-turn。**修复**：setModel / setThinkingLevel 判等再调
（session.ts driveRun）。教训：**pi 树对"每次调用落一条"的 API 要按需调用**。

### 3.2 呈现口径 vs 上下文口径

pi 的 `agent.state.messages`（= buildSessionProjection）是**上下文口径**：压缩后
影子区（被摘要的旧历史）不进请求、也不在投影里。Cogent 的历史回查是**保留式
呈现**（D9 验收：被摘要区原文照旧可滚）。**修复**：`messages()` 恒走 pi JSONL
全量回查（factory 的 `readPiTranscript`：遍历 getBranch 条目自投影，影子区 /
多代压缩条全保留）；pi 未装配（惰性会话重启后）同路 —— 只读路径不装配完整
内核。

### 3.3 JSONL 文件名带时间戳前缀

pi 会话文件 = `<ISO时间戳>_<sessionId>.jsonl`（session-manager newSession
:712），按 id 找文件要 `endsWith('_'+id+'.jsonl')`，精确名查不到（delete 的
rmSync 同理）。会话 id 本身经 `SessionManager.create(cwd, dir, {id})` 显式对齐
Cogent uuid（newSession `options?.id ?? createSessionId()`）✓。

## 4. 装配纪律（pi-session-factory.ts）

- **凭据**：ModelRuntime 全内存（空 CredentialStore + setRuntimeApiKey overlay，
  index.ts 的凭据 sink 三入口联动：initialize / credentials.set / remove 都
  await 应用后再生效）—— 绝不读写 ~/.pi 的 auth.json；
- **custom/\* 双注册**：同一 `createProvider` 实例既 `models.setProvider`（UI 目录）
  又 `modelRuntime.registerNativeProvider`（pi 内核请求路由）—— 单一构造源，
  两套目录永不分叉（custom-providers.ts）。内置 provider 不需要：覆盖值写在
  Model.baseUrl 上随请求透传；
- **审批（D8）**：**链式包裹 `agent.beforeToolCall`** 而非 InlineExtension 的
  tool_call 事件 —— pi AgentSession 装的扩展分发器**丢弃核心循环传入的 abort
  signal**（agent-session.ts:719 形参无 signal），挂起审批在中止时会永悬；链式
  包裹保住 pi 原钩子（扩展链不失联）且拿回 signal（agent-loop.ts:738 传入）；
- **观测三钩**：sdk.ts 构造 Agent 时已占用 onPayload/onResponse/
  onProviderStreamEvent 做扩展事件桥 —— 直赋会拆 pi 接线，必须链式包裹
  （观测先行、原钩子后行、透传返回值）；
- **系统提示词**：systemPromptOverride 整体注入；pi 自动追加 cwd 环境段
  （1641 token 实测），重复声明无害，1.4 对账去重；
- **v1 旧转录**：装配时一次性导入 pi 树（legacy-import.ts：compactionSummary →
  appendCompaction(null)、其余角色 appendMessage），盘上文档随之重写 v2
  （summary-only）。

## 5. 对比

| | 内核形态 | 转录真源 | 终态 |
| --- | --- | --- | --- |
| pi AgentSession（现行） | 全托管：压缩/恢复/重试内聚于 prompt 生命周期 | 会话树 JSONL（追加式） | agent_settled 单点 |
| 手搓 Agent 层（已删） | 自管 convertToLlm/压缩/溢出/落盘 | Agent.state.messages 原位改 | agent_end + 抑制竞态 |
| Claude Code | 进程内 agent，转录 JSONL --resume | 同 pi 形态 | - |
| Pi-meme | SdkSession 内嵌 worker，Host 只见 HostApi | Host 侧自管 | - |

## 6. 残留债（1.4 对账）

- 权限模式通告（D6）降级：append-only 树容不下"替换式 system 通告"，归位路径
  systemPromptOverride 读活 mode 动态拼段；
- 压缩条投影的 tokensAfter / summaryUsage 缺省（pi 树只存 tokensBefore；事件侧
  D9 账在 compaction.completed 有，历史回查折叠条没有）；
- keep 固定 20000 vs 手搓小窗减半的公式差（CompactionSettings 按模型覆盖可解）；
- estimateContext 明细的 systemPrompt/toolDefs 两段在 pi 投影源下为 0 估算
  （system 不进树）。
