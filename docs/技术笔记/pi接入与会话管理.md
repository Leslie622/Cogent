# 笔记：pi Agent 接入与会话管理（host/runtime）

> 对应路线项：第 2 项（SessionManager + pi Agent 接入）。落点：
> `src/host/runtime/session.ts`、`src/host/index.ts`、`src/protocol/types.ts`。

## 1. 问题

把"用户一句话"变成"Agent 的一次完整执行"，引擎绕不开四件事：

1. **会话隔离**：多会话并行时，每会话要有独立的转录（transcript）、模型、思考级别；
2. **流式转发**：LLM 输出以 delta 到达，引擎要把它转译成宿主可消费的事件流；
3. **长任务与请求-响应的矛盾**：LLM 循环以分钟计，阻塞式请求-响应会挂死宿主；
4. **错误归一**：provider 401/403/网络断/中止，要归一成宿主能呈现的失败事件。

## 2. pi 的做法（Agent 基础与 AgentSession 收口）

### 2.1 Agent 是状态机 + 事件源，不是回调接口

`pi-agent-core/dist/agent.d.ts`：`Agent` 类持有 `_state`（systemPrompt/model/thinkingLevel/
messages/isStreaming/errorMessage），对外只暴露三个动作面：

- `prompt(input)` —— 启动一次 run（`agent.js:246`，已有 activeRun 时 throw）；
- `steer()/followUp()` —— 排队注入消息（steering 机制，本版未用）；
- `abort()` —— 经 AbortController 贯穿到 provider 请求。

事件用 `subscribe(listener)` 发布（`agent.js` `processEvents`）：listener 按订阅序 await，
`agent_end` 之后还要等所有 listener settle 才算 idle —— pi 把"事件消费完成"纳入 run
生命周期，宿主的转译逻辑不会与引擎状态产生竞态。

### 2.2 事件流形状（`pi-agent-core/dist/types.d.ts:461`）

```
agent_start → turn_start → message_start(user) → message_end(user)
  → message_start(assistant) → message_update×N（含 assistantMessageEvent）
  → message_end(assistant) → [tool_execution_* …] → turn_end → agent_end
```

关键点：**流式 delta 不在 message_update 的 message 字段里逐字给**，而是携带
`assistantMessageEvent`（`pi-ai/dist/types.d.ts:585` 的 `text_delta { delta }` 等），
`message` 字段是累积 partial。Cogent 转译时取 `assistantMessageEvent.delta` 做增量，
自己维护累积缓冲（`session.ts` StreamingState）；turn_end 封段，AgentSession 的
agent_settled 才是包含恢复、重试与收口钩子的整个执行周期终态。

### 2.3 终态原因：消息失败与 run 中止分开

run 是一次用户提交的完整执行周期，里面可以有多轮模型请求、工具与后处理；
assistant.stopReason 描述一轮消息，不能代替整个 run 的结果。pi 的错误消息仍经
message_end → turn_end → agent_end 收口；中止也走 turn_end，保留已抵达的正文
（`reference/pi/packages/agent/src/agent-loop.ts:250-264`）。

AgentSession 在活跃 run 收到 abort 时独立记下请求，新 run 清零；所有收口处理完成后
通过 `agent_settled.aborted` 发布这个事实（`reference/pi/packages/coding-agent/src/core/agent-session.ts:209-217,1139-1146,1943-1986,2598-2610`）。
代表场景是模型回答已成功、agent_before_settle 钩子仍在运行时停止：末条 stopReason
可以还是 stop，也没有 errorMessage，但整个 run 已中止。上游回归保留成功正文、抑制后续
继续并断言 aborted=true（同仓 `test/suite/agent-session-boundaries.test.ts:705-736`）。

Cogent 因此先读事件 aborted，再读 errorMessage，分别发 `run.failed(reason:'aborted')`
与 `run.failed(reason:'error')`，其余照常完成或自动续写。renderer 清 stopping 请求窗口，
按user.id存入turnOutcomes供各回合头使用；lastRunOutcome只保最近结果供无user组兜底。
停止后再发下一条user，旧回合也必须保留结果，不能硬编码历史done；零输出回合否则只
剩用户泡。错误条也可以来自压缩等操作，不能拿 lastError 当回合结果。自动续写持有
本次 StreamingState，终态已释放就退出，不能因末条仍为 length
重新起跑。机制真源见 [会话与对话](../模块/会话与对话.md#停止请求与终态结果)。

正文的结构权威也在 Host：中止轮已经 turn_end 封存时，run.failed.messages 已包含其尾段；
renderer 再追加本地 streaming 会让半截出现两份。有 messages（包括 []）便采用完整快照，
缺字段才走旧事件封存分支，无需文本匹配或段落 hash。最后一轮正常成功再中止、以及中止
轮本身，都遵守同一分段合同。

#### 准备期取消与运行预约

pi 的输入/鉴权 preflight 早于 active run，直接调用 abort 不能保存该窗口的停止意图；
before_agent_start 阶段则已经 active，原生取消本来就有效。导出的 PromptOptions 的
preflightResult（标注 RPC internal）区分 started/handled/queued，started 在准备结束后、core prompt 前同步
回调（`reference/pi/packages/coding-agent/src/core/agent-session.ts:325-339,1943-1969,2186-2195`）。
回调只补 pi.abort，不抛异常：它位于内核 finally 之前，抛错会破坏收口。

删除是额外的接力边界：pi.dispose 会断开 AgentSession 对 core Agent 的监听
（`reference/pi/packages/coding-agent/src/core/agent-session.ts:1477-1492`），却不能
强制杀掉已进入的 input await。Host 因此直接订阅本次 prompt 的首次 core agent_start，
先退订，再按 owner 失效或 stopRequested 补取消，finally 再兜底退订。监听只守一次启动，
避免旧 prompt 的收尾影响新 run；随后请求取消包装在 provider 前检查同一 signal。

Cogent 在首个 await 前预约 StreamingState，以 stopRequested 保存意图。装配、切模型、
校验返回后只继续自己的 owner；continue 同样从准备期发 run.started，末条无效也有
明确的失败终态与 RPC 错误。任意扩展 await 没有 signal 时仍需等待它收敛，此时保留
账本并显示「正在停止」，不用 Promise.race 提前放行下一 run。

started 接力将 core signal 设为取消后，pi 循环仍可能进入请求准备；factory 因此链式包裹
公开 Agent.prepareRequest，在原 hook 前后执行 signal.throwIfAborted，保留原结果和异常。
上游调用点为 `reference/pi/packages/agent/src/agent-loop.ts:228-236`。这能挡住进入检查时
已经取消的工作；之后的异步转换/鉴权仍依赖 provider 遵守 signal，不能承诺所有取消时点
都零 streamFunction 入口。包装的 owner 与边界见 [钩子座](../模块/钩子座.md)。

handled 不发 agent_settled，Host 在本次调用已收敛后自行收口；queued 不当成完成。
未开始 prompt 的取消先经 pi 公开 appendMessage + refreshContext 保存原始 user，
已交付输入不再追加。手动 continue 的显示快照合并旧 assistant 前缀和新增分段，
不把旧费用记进本 run Inspector；手动压缩另持操作 owner，在 manual compaction_start
补 abortCompaction，堵住 pi.compact 先 await abort 再建 controller 的窗口
（`reference/pi/packages/coding-agent/src/core/agent-session.ts:2923-2926`）。

renderer 的 runRequestId 与 stopRequestId 分别保护运行请求和停止回包；旧 submit/continue
拒绝不能覆盖已停止结果或丢弃新 run 的 delta。输入区还独立核对编辑、请求、视图与卸载
代次，旧成功不能清新草稿。完整 owner 顺序见
[会话与对话](../模块/会话与对话.md#停止请求与终态结果)。

### 2.4 每轮请求都重新解析 key

`agent-loop.js:275`：`const resolvedApiKey = config.getApiKey ? await config.getApiKey(model.provider) : ...`。
getApiKey 在**每次 provider 请求前**调用 —— 支持 OAuth 过期刷新、运行中换 key。
Cogent 的实现：`getApiKey: (provider) => credentials.get(provider)`（内存表直查）。

### 2.5 模型目录：catalog 生成制

`pi-ai/dist/providers/all.js`：`builtinModels()` 注册 41 个内置 provider（`all.js:83`），
每个 provider 的模型清单由 `catalog/generate.ts` 批量生成进 `providers/data/*.json`
（含 contextWindow/maxTokens/thinkingLevelMap/价格），`getModels()` 同步读内存。
Cogent 的 `models.list` 直接投影这份目录（`session.ts listModels()`），零网络请求。

## 3. 对比

### 终态原因与停止窗口（三仓同主题）

- **pi** 的 run 级 aborted 与消息级 stopReason 分工见 §2.3；Cogent 使用现成的
  AgentSession 终态事实，不新增另一套引擎取消状态。
- **deepseek-harness**：`reference/deepseek-harness/packages/core/session/src/types.ts:193-218`
  将取消指令原因与 turn/end 的 completed/aborted/error 分开；
  `packages/core/agent-loop/src/agent.ts:408-428`（同 Harness 根）最终记录结构化原因。
  Cogent 借结果与请求窗口的分工，不搬其完整回合日志模型。
  其 `agent.ts:235-256` 在异步 kick 前同步建立 running/controller，等待收敛再接下一次
  唤醒；Cogent 采用同一预约原则，不引入整套队列。
- **zcode**：`reference/zcode/packages/shared/src/zcode-protocol-v4/snapshot.ts:29-39,134-145`
  独立定义 completedInterrupted 与 stopState；
  `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts:2755-2788`
  （同 zcode 根）在保留结果的同一终态里把 stopState 清为 idle。Cogent 同样允许
  stopping=false 与该user的turnOutcomes=stopped同时成立，采用现有协议上的可选reason字段；
  回合结果在下一次提交后仍保留，不能仅把会话级最近结果交给最后一组。
  准备期的同主题做法见 `apps/zcode-cli/packages/core/src/runtime/methods/prompt-admission.ts:107-162`
  与 `steering.ts:370-392`（同 methods 目录）：首 await 前 reserve，释放时核对 turn 身份。
  Cogent 用已有操作对象识别 owner，旧准备链不释放新预约。

### DeepAgent（作者此前项目）

- **会话管理**：DeepAgent 把会话状态放在主进程的 service 层（MongoDB/内存二选一），
  消息模型与 UI 模型混用（直接把渲染用 message 数组当转录）——引擎重启即丢，
  且无法做"转录 ≠ UI 消息"的分离（thinking 块污染渲染数据）。
  pi 把 transcript（LLM 视角）与 UI 渲染彻底分开，Cogent 的 `toChatMessages()`
  （`session.ts`）在协议边界做投影，UI 永远只见纯文本 —— 这层分离在 DeepAgent 里
  是事后补的（加 `displayContent` 字段），pi 是结构性的。
- **事件转发**：DeepAgent 用 SSE + 每事件一个 JSON（自造 `agent_delta`/`tool_result`
  等事件名），事件 schema 靠约定无类型约束。pi 的事件是**判别联合**
  （`AgentEvent`），TS 下 switch 全覆盖有穷尽性检查；Cogent 沿用此形制翻译成协议事件。

### Claude Code

- **会话 = 进程**：Claude Code 一个终端会话一个 Agent 实例，无多会话并存，
  转录持久化用 JSONL（`--resume` 重放）。Cogent 是 GUI 多会话，引擎内
  `Map<sessionId, Session>` 隔离，每会话独立 Agent 实例（转录/模型/思考级互不干扰）；
  持久化留待 storage 路线项（届时 StorageDriver 落 JSON，方向与 Claude Code 一致）。
- **错误呈现**：Claude Code 把 provider 错误直接打到终端让用户读原文；
  Cogent 经协议事件（`run.failed`）到 UI 呈现错误条 —— 引擎/壳/UI 三层各自翻译一次，
  与 Cogent"每层一个信任边界"的架构一致。

### OpenAI Agents SDK（Python）

- Runner.run_streamed() 返回事件流对象，宿主 async for 消费 —— 与 pi 的
  AssistantMessageEventStream 同构（都是 async iterator + 终结事件）。
  区别：OpenAI SDK 的流事件是 provider 原始形状（RawResponsesStreamEvent），
  跨 provider 不归一；pi 在 `pi-ai` 层就归一成 `text_delta/thinking_delta/toolcall_delta`
  统一形状 —— Cogent 因此不用为每家 provider 写转译分支。

## 4. 取舍

| 决策 | 备选 | 采信理由 |
| --- | --- | --- |
| `agent.submit` 受理即回（accepted:true），进度走事件 | 请求-响应等完整回复 | LLM 循环分钟级，阻塞会挂死宿主；事件流本来就是引擎的输出形状（架构.md §2） |
| 流式累积缓冲放引擎（StreamingState），完成/失败事件携带终态分段 | renderer 自己拼 delta 并猜尾段覆盖关系 | 协议消费方不必各自实现封段与去重；完整终态快照包含中止尾段，renderer 直接采用 |
| 会话在引擎内存，storage 另行落地 | 本次一并做 JSON 存储 | 小步走（AGENTS.md 工作方式）；storage 是独立技术主题，值得单独一篇笔记 |
| `ChatMessage` 只有纯文本 | 协议直接透传 pi content blocks | 协议只暴露 UI 所需；content blocks 细化是路线第 1 项，届时加 optional 字段（只增不破） |
| 每会话每 submit 前 set model/thinkingLevel | 会话级模型固定 | UI 的模型下拉是全局选择，随每次提交下发最直观（Claude Code 的 `/model` 也是即时生效） |

## 5. 在 Cogent 的落点

- `src/host/runtime/session.ts`：SessionManager（create/list/delete/messages/
  submit/abort/disposeAll）+ pi 事件转译（translateEvent）+ 模型目录投影（listModels）；
- `src/host/runtime/credentials.ts`：getApiKey 的数据源，见
  [凭据存储与模型目录](凭据存储与模型目录.md)；
- `src/host/index.ts`：method 注册表挂 runtime（handler 零防御，边界校验在 dispatch）；
- `src/protocol/types.ts`：ChatMessage/ModelSummary/ProviderSummary +
  session.messages / models.list / credentials.* method + run.completed.message、
  run.failed.reason/messages 字段；
- renderer 消费侧：`src/renderer/src/stores/chat/`（events.ts 事件 → 桶更新转译集中一处）。
