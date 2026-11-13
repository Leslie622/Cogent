# 笔记：pi Agent 接入与会话管理（host/runtime）

> 对应路线项：第 2 项（SessionManager + pi Agent 接入）。落点：
> `src/host/runtime/session.ts`、`src/host/index.ts`、`src/protocol/types.ts`。

## 1. 问题

把"用户一句话"变成"Agent 的一次完整执行"，引擎绕不开四件事：

1. **会话隔离**：多会话并行时，每会话要有独立的转录（transcript）、模型、思考级别；
2. **流式转发**：LLM 输出以 delta 到达，引擎要把它转译成宿主可消费的事件流；
3. **长任务与请求-响应的矛盾**：LLM 循环以分钟计，阻塞式请求-响应会挂死宿主；
4. **错误归一**：provider 401/403/网络断/中止，要归一成宿主能呈现的失败事件。

## 2. pi 的做法（1.5.0 源码）

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
自己维护累积缓冲（`session.ts` StreamingState），最终文本以 `agent_end` 时的缓冲为准。

### 2.3 错误处理：双通道汇于一处

- 流内错误（provider 返回 4xx/5xx）：`pi-ai` 的 `lazyStream`（`api/lazy.js:45`）把 setup
  异常转成 `{ type: "error" }` 事件；`agent-loop.js:314` 收到后构造
  `stopReason:"error"` + `errorMessage` 的 AssistantMessage，经
  `message_start/end → turn_end → agent_end` 正常走完事件序列；
- 循环外异常（编程错误）：`agent.js:361` catch → `handleRunFailure`（`agent.js:368`）
  合成同形状的失败消息，照样发完整事件序列。

两条路都把 `errorMessage` 写进 `Agent.state.errorMessage`（`agent.js:424`，turn_end 时）。
**Cogent 的转译器只读 `agent.state.errorMessage`（agent_end 时）即可覆盖全部失败路径**，
不需要在 message_update 里逐事件判断 —— 这是 pi"错误也是一条消息"设计的直接收益。

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
| 流式累积缓冲放引擎（StreamingState），`run.completed` 带最终消息 | renderer 自己拼 delta | 协议消费方（将来可能是旧项目宿主）不必各自实现拼接逻辑；renderer 拼错不重试就丢字 |
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
  session.messages / models.list / credentials.* method + run.completed.message 字段；
- renderer 消费侧：`src/renderer/src/stores/chat.ts`（事件 → 状态转译集中一处）。
