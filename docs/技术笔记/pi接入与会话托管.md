# pi 接入与会话托管

> 学习主题：Agent 循环、AgentSession 全托管、会话隔离与终态收口。
> 当前机制见 [会话与对话](../模块/会话与对话.md)，内核边界见 [内核合同](内核合同.md)。

## 1. Agent 与 AgentSession 分别拥有什么

核心 `Agent` 是状态机与事件源，持有模型、思考档位、消息和活跃请求；
`prompt` 启动执行，`steer/followUp` 排队注入，`abort` 把取消信号传给 provider。
`AgentSession` 则在其上托管会话树、扩展、压缩、溢出恢复和 provider 重试。
消费方若一边使用 AgentSession，一边直接改 `agent.state.messages`，修改不会自动进入
追加式会话树，磁盘与上下文就会分叉。因此 Cogent 经窄合同驱动托管层，不另写循环。

pi 依据：`reference/pi/packages/agent/src/agent.ts` 的 `prompt/subscribe/abort`；
`reference/pi/packages/coding-agent/src/core/agent-session.ts:1943-1986` 的 run 生命周期。
这里沿用原接入与停止调研的源码出处；文档合并没有重新执行三仓测试。

## 2. 事件流与两级终态

```text
Agent：agent_start → turn_start → message_start/update/end
                     → tool_execution_* → turn_end → agent_end
AgentSession：准备 → Agent 循环 → 压缩/恢复/重试 → agent_settled
Host：受理即回 accepted；进度与最终结果走协议事件
```

`message_update.assistantMessageEvent` 提供 `text_delta/thinking_delta/toolcall_delta`；
同事件的 `message` 是累计 partial，不能当作增量再拼一次。`turn_end` 适合封存本轮消息，
`agent_end` 也不等于完整 prompt 已收敛。AgentSession 在 finally 发出一次
`agent_settled`，晚于内聚恢复，才适合作为 Host 的权威完成点。

**消息 stopReason 与 run 结果是两种事实。** 在模型已回答、收口钩子仍挂起时停止，
末条消息仍可能是 `stop` 且无错误文本，但 `agent_settled.aborted` 为 true。
不能从“点过停止”、末条 stopReason 或错误文案猜运行结果。

- pi：`agent-session.ts:209-217,1139-1146,1943-1986,2598-2610` 独立记 run 级取消；
  `test/suite/agent-session-boundaries.test.ts:705-736` 覆盖收口钩子期间停止并保留成功正文。
- pi 正文：`reference/pi/packages/agent/src/agent-loop.ts:250-264,453-465`，
  abort/error 仍经 `message_end/turn_end` 保留已经生成的内容。
- Harness：`reference/deepseek-harness/packages/core/session/src/types.ts:193-218,340-356`
  将驱动 idle 与 `turn/end` 的 completed/aborted/error 分开。
- zcode：`reference/zcode/packages/shared/src/zcode-protocol-v4/snapshot.ts:29-39,134-145`
  将 completedInterrupted 与 stopState 分开；`apps/zcode-cli/packages/bootstrap/src/
  zcode-protocol-v4/product-projection.ts:2755-2788` 同笔终态清停止窗口、保留结果。

Cogent 采用“请求窗口与最终结果分开”的分工。Host 发布完整终态分段，renderer 直接采用
该快照，不把本地尾占位再补一次；回合结果按 user.id 保留，操作错误条不冒充回合失败。
完整 owner 和顺序由模块页维护，笔记不复制状态表。

## 3. 准备期取消为什么需要接力

pi 输入与鉴权 preflight 早于 active run，这时直接 `abort()` 不能保存停止意图；
`before_agent_start` 已位于 active run，原生取消有效。`PromptOptions.preflightResult`
区分 started/handled/queued，started 在准备结束后、core prompt 前同步回调
（`agent-session.ts:325-339,1943-1969,2186-2195`）。回调只补取消，不抛异常：
它早于内核 finally，抛错反而破坏收口。

Cogent 在首次 await 前预约操作 owner，把停止意图留在该 owner；异步返回只继续自己的
预约。删除还要覆盖监听断开的窗口：pi.dispose 会退订 AgentSession 的 core 监听，
但不能强杀已进入的 input await（`agent-session.ts:1477-1492`）。首次 core
`agent_start` 的一次性接力和 provider 前 signal 检查分别守住启动与请求边界。

`reference/pi/packages/agent/src/agent-loop.ts:228-236` 在请求准备时调用公开
`Agent.prepareRequest`；链式包装在原 hook 前后检查同一 signal。它能拦住已取消的工作，
不能保证之后每个异步鉴权都不再进入 provider；没有 signal 的 await 仍须等待返回。
用 Promise.race 提前释放账本，会允许新旧运行重叠。

横向参照：Harness `packages/core/agent-loop/src/agent.ts:192-200,235-256,289-313`
在异步 kick 前建立 running/controller；其 `tests/cancel.spec.ts:167-192` 与
`input-lifecycle.spec.ts:55-81` 区分立即取消和未合作钩子的收敛。
zcode `apps/zcode-cli/packages/core/src/runtime/methods/prompt-admission.ts:107-162`
及同目录 `steering.ts:370-392` 在首次 await 前预约，释放时核对 turn 身份。
Cogent 借预约与归属校验，不引入它们的整套队列。

早停输入通过 pi 公开 `appendMessage + refreshContext` 保存一次；已交付输入不再追加。
手动压缩也有准备窗口：`compact` 先 await abort 再创建 controller
（`agent-session.ts:2923-2926`），取消须在 compaction_start 接力。

## 4. 转录、上下文与呈现不能混为一份数组

pi 的 `agent.state.messages` 是上下文投影，压缩后的影子区不再进入请求；
Cogent 要保留可滚动的原历史，所以历史读取遍历 pi JSONL 分支，再投影成 UI 消息。
惰性会话回查只读转录，不为读列表装配完整内核。存储原理见
[会话存储与转录持久化](会话存储与转录持久化.md)。

会话文件是 `<ISO时间戳>_<sessionId>.jsonl`，不是单纯 id 文件名
（pi `core/session-manager.ts:712`）；寻址与删除按 id 后缀匹配。
压缩切点、split-turn 和保留窗口见 [上下文压缩](上下文压缩.md)。一条重要装配教训是：
`setModel/setThinkingLevel` 会写树条目，判等后再调用，避免无意义空条目影响切点。

length 有两级恢复：pi 的可恢复 length 会省略截断消息、压缩并继续；真正贴满 maxTokens
的纯文本 length 不一定满足该判定，此时 Host 用显式 user 续写指令接续。
测试应携带真实满额 usage，不能靠不完整 mock 把两条路径混成同一机制。

## 5. 装配边界与取舍

| 选择 | 为什么 |
| --- | --- |
| 每会话独立 AgentSession，协议只传可序列化投影 | 实例隔离转录；UI 不依赖 pi 内部对象；发错 sessionId 仍会串话，导航也必须守隔离 |
| submit 受理即回，最终结果走事件 | LLM 循环可能持续分钟；受理校验、运行预约和执行结束有不同时间边界 |
| ModelRuntime 全内存 + 宿主注入凭据 | 不读写用户的 `~/.pi/auth.json`，密钥持久化保持在 Electron 壳 |
| custom provider 同实例双注册 | UI 目录和 pi 请求路由是两个消费面；只注册一个会出现“可选但不可调用” |
| 审批链式包装 `beforeToolCall` | AgentSession 扩展适配器未向 tool_call 事件透传核心 signal，挂起审批需要保住 signal |
| 观测钩子链式包装 | SDK 已用 onPayload/onResponse/onProviderStreamEvent 转发扩展；直接赋值会拆原接线 |
| 动态提示段走 before_agent_start | sections 按名 diff、净变更追加进树；整体 override 只在 reload 求值，不适合活权限与技能 |

Pi-meme 的 SDK 形态是 worker 内嵌 SdkSession，Host 只见 HostApi；
`reference/Pi-meme/packages/pi-runtime/src/sdk/session.ts:917` 也手动调用 bindExtensions。
它说明 SDK 装配与 CLI 产品生命周期不同，不能假定创建 AgentSession 就完成全部扩展启动。

## 6. Cogent 落点

- `src/host/kernel/pi-session-factory.ts`：托管装配、只读转录投影、ModelRuntime 桥；
- `src/host/runtime/session.ts`：受理、owner、事件转译、终态和显式续写；
- `src/host/kernel/legacy-import.ts`：旧转录一次性导入 pi 会话树；
- `src/host/runtime/hook-seat.ts`：扩展与核心 signal 的链式包装；
- [会话隔离与受理语义](会话隔离与受理语义.md)、[凭据与模型目录](凭据与模型目录.md)
  分别解释导航与模型装配的独立边界。

本轮文档/运行身份、提交/迁移、配置与退出的三仓对照见[运行交接与数据可靠性](运行交接与数据可靠性.md)，当前实现以对应模块为准。
