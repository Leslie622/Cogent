# 笔记：会话隔离与受理语义（串话事故复盘）

> [pi-agent-integration.md](pi-agent-integration.md) 的子题（主题-子题拆分，见 README）。
> 起因：2026-11-08 用户报告"全新对话串进旧话题"。落点：
> `src/agent-service/runtime/session.ts`、`src/agent-service/index.ts`、
> `src/renderer/src/features/home/HomeSidebar.tsx`、`src/renderer/src/stores/home.ts`。

## 1. 问题

会话隔离这件事有两半：**引擎把不同会话的转录分开**只是前一半；后一半是
**UI 的"新会话"动作必须真的在引擎侧产生新会话**。后一半错了，前一半形同虚设 ——
模型收到的请求体由引擎从"那个 sessionId 的转录"组装，发错会话 = 模型看见别人的历史。
受理语义同理：LLM 循环分钟级，submit 必须受理即回，但"受理"若不包含校验
（会话存在？空闲？），错误就会掉进异步段的深渊。

## 2. pi 的做法（1.5.0 源码）

- **实例即边界**：`pi-agent-core/dist/agent.js` `createMutableAgentState`（agent.js:30）
  为每个 Agent 实例闭包持有独立 `messages`；`prompt()` 走
  `createContextSnapshot()`（agent.js:300，`_state.messages.slice()`）——
  跨会话污染在 pi 层没有通道。Cogent 每会话一个 Agent 实例（session.ts `createAgent`）。
- **busy 即抛**：`agent.js:246` prompt 入口检查 `activeRun`，进行中再 prompt 直接
  `throw "Agent is already processing"`。注意这是**异步 reject**（async 函数），
  不是同步 throw —— 调用方必须接住。
- **截断的转录语义**：流式期间 partial 消息实时进转录（agent-loop.js:284-309，
  message_start push + message_update 原位替换）；流错误/中止时以
  `stopReason: "error"/"aborted"` 正常走完 `message_end → turn_end → agent_end`
  （agent-loop.js:148-160），半截文本**留在转录里** —— 模型知道自己说过半截话，
  同会话后续请求可见。实验实证（mock SSE 掐断连接）：引擎发 `run.failed
  ("terminated")`，`session.messages` 回查含半截问候。

## 3. 事故链路（2026-11-08，协议级复现实证）

**现象**：全新对话发「你好」，回复 = 半截问候「你好！有什么我可以帮」+ 一整篇
与本项目无关的设计文档（"语音指令窗"三 tab）。

**链路**（每步都有实证）：

1. 用户首聊「你好」→ 回复流中断（网络/端点抖动）→ 引擎 `run.failed`，半截问候
   留转录（§2 实验实证）；renderer 收 run.failed 清掉流式占位 —— 回复**无声消失**，
   用户体感"被截断"；
2. 用户"去聊别的"：**同一引擎会话**里问了"语音指令窗"设计 → 一问一答入转录；
3. 用户点「新聊天」→ **只切了视图态**（HomeSidebar → home.startNewChat()，而
   `chat.createSession` 全仓库只有 load() 空列表时这一个调用点）→ 发「你好」→
   引擎把 s-1 完整历史发给模型；
4. 模型看见 [你好, 半截问候, 语音指令窗问答, 你好]，回放对话自身的模式：
   问候 + 重新生成设计文档 —— 即截图回复。半截问候的"回声"来自转录留存（§2）。

**关键证据**（mock OpenAI 端点捕获引擎真实外发请求体）：

| 场景 | 外发 messages |
| --- | --- |
| 同会话点"新聊天"后再发「你好」 | **6 条**（system + 你好 + 答复 + 语音指令窗问答 + 你好） |
| 真正的新会话发「你好」 | **2 条**（system + 你好） |

**排查中的误判（记录在案）**：一度结论"流错误被吞成 run.completed"——
实为复现脚本缺陷（user content 是 block 数组，脚本按字符串匹配导致截断分支
从未触发）。教训：**复现脚本自身要先证明它真的复现了**（探针两次跑一致才算）。
provider 侧串话也排除过：读 `%APPDATA%/cogent/custom-providers.json` 确认只有
官方端点 override，无服务端会话态的可能。

**顺带发现并修复**：`index.ts` 原 `void sessions.submit(...)` —— 会话不存在 /
pi busy 的异步 reject 逃出 dispatch 的 try/catch（它只包同步段），变
unhandledRejection **崩掉整个引擎进程**（mock 双发复现：后续帧 EPIPE）。
全部会话随进程丢失，比串话更致命。

## 4. 对比

- **DeepAgent**（作者此前项目，描述见 [pi-agent-integration.md](pi-agent-integration.md) §3）：
  前端持有的 message 数组**就是**转录（无 transcript/UI 分离），会话切换 = 前端换
  数组引用 —— "发错会话"这类 bug 换了形态：多入口/多窗口对同一 service 会话并发
  写同一数组，串话以互踩形式出现。Cogent 的分层（引擎转录 / 协议投影 / renderer
  按 sessionId 分账）让每层可以独立验证隔离性 —— 本事故能定位到"引擎隔离无辜、
  UI 接线有错"，正受益于此。
- **ChatGPT 网页版**：New chat 前端即切空态，服务端会话**首条消息发出时才建**
  （懒创建）—— 空点"新聊天"不产生孤儿会话。Cogent 引擎协议要求 submit 必带
  sessionId，且标题依赖首条消息，故当前选择点击即建（取舍见 §5）。
- **LangGraph**：thread_id 由调用方传入 + checkpointer 按 thread 落库 —— 隔离形状
  与 Cogent 同构（id 是外键，传错即串），因此"受理入口校验 + UI 发起动作与引擎
  动作配对"这课同样适用；LangGraph 生态把这类问题归到 thread 管理层（store），
  Cogent 的对应物是未来的 storage + 会话列表 UI（路线空位 3）。
- **Claude Code**：会话 = 进程 + JSONL `--resume` 重放，"新会话" = 新进程，
  结构上不存在本类 bug；代价是无 GUI 多会话并存。

## 5. 取舍

| 决策 | 备选 | 采信理由 |
| --- | --- | --- |
| 新聊天**点击即建**引擎会话 | 懒创建（首条消息才建，ChatGPT 式） | 协议要求 submit 必带 sessionId；懒创建要把"虚拟新会话"态贯穿 submit/事件流，改动面大。代价 = 空点会产生孤儿空会话 —— 会话列表进侧栏（路线空位 3/4）时用"空会话不入列表或自动清理"消解，先记入空位 |
| 忙会话**显式拒绝**（InvalidRequest 错误帧） | pi 的 steer()/followUp() 排队注入 | Cogent 的 UI 语义是 ChatGPT 式停止钮，不是排队；steering 接线是独立交互决策，先拒绝、错误信息给出路（"请先停止或等待完成"） |
| 截断半截文本**留转录**（pi 原语义，未改） | 失败即弃 | LLM 视角连续性优先：模型知道自己说过半截话，续聊不重复；UI 侧 run.failed 清占位是渲染域选择，历史回查（session.messages）会还原，两层不冲突 |
| 受理校验放 SessionManager（同步 throw） | handler 层 try/catch 或 promise.catch 后回错误帧 | dispatch 只包同步段是既有边界形状（约定.md 1.3 照抄示范位）；submit 的校验本来就是受理语义的一部分，同步 throw 自然落进 dispatch 的统一翻译 |

## 6. 在 Cogent 的落点

- `src/agent-service/runtime/session.ts`：`submit()` 改同步校验 + 启动窗口
  catch → run.failed 兜底（运行期失败仍走 pi 事件流转译，见主笔记 §2.3）；
- `src/agent-service/index.ts`：agent.submit handler 去掉 `void`（同步调用，
  校验错误自然冒泡给 dispatch）；
- `src/renderer/src/features/home/HomeSidebar.tsx`：三类发起入口统一 `startNew()`
  = `chat.createSession()` + `home.startNewChat()`；`src/renderer/src/stores/home.ts`
  头注释澄清视图态边界；
- 复现/回归配方：mock OpenAI 端点 + 协议帧驱动（见 开发.md「引擎冒烟」的
  受理校验回归一节）。
