# 技术笔记 — 会话存储与转录持久化

> 落点：`agent-service/storage/`（StorageDriver + JsonStorageDriver）+
> `runtime/session.ts` 持久化改造（2026-11-09，计划
> [计划-工作区与会话真实化.md](../计划-工作区与会话真实化.md) 第 1 步 = 路线空位 #3）。

## 1. 要解决什么

会话（摘要 + 消息转录）此前只活在引擎进程内存（`Map<string, Session>`）：
重启即失、侧栏真实化没有数据可拉、cwd/置顶等会话级字段无处安放。
本文记录存储层的形状决策、写时机选择与恢复语义，及与 DeepAgent /
主流 Agent 的同主题对比。

## 2. 存储形状：文档集合，一会话一文件

```
~/.cogent/sessions/<sessionId>.json     # { version, summary, transcript }
```

- **接口面**：`StorageDriver` = 文档集合 CRUD（ids/get/put/delete）。
  刻意不做通用 KV 或 SQL —— 引擎的持久域就是「一形数据按 id 整读写」，
  接口跟着领域走，将来接云只换实现（架构.md「本地优先」决策）；
- **一会话一文件 vs 单大 JSON**：回合边界落盘只重写本会话文件，写放大 O(1)；
  单大 JSON 每次全库重写，长会话场景不可接受。也顺带白送手工可检查性
  （开发者受众翻 `~/.cogent/sessions/` 直接就是学习材料）与单文件备份粒度；
- **vs sqlite**：访问模式是整文档读写，sqlite 的索引/事务/查询能力用不上，
  反而引入二进制不可检查性。Codex 的会话也是 jsonl 平文件，同款判断；
- **盘上格式带 `version`**：将来字段演进据版本迁移（同 credentials.json 手法）；
- **写法原子 + 恢复逐文件隔离**（2026-11-10，架构审查修复）：`put` 先写同目录
  `.tmp` 再 rename 覆盖（Node 在 Windows 带 MOVEFILE_REPLACE_EXISTING，同卷原子）
  —— 裸 `writeFileSync` 覆盖目标会在写入中途崩溃/断电时留下截断文件，而截断的
  会话文件在恢复处只能被隔离，等于丢整个会话。恢复侧对应 `quarantine`：单个
  损坏文件改名 `.corrupt` 旁置 + stderr 记录 + **继续恢复其余**（可见性保留：
  日志可查、旁置文件可手工抢救）—— 此前任其炸构造器会让引擎进程拒启 = 全部
  会话陪葬，超出「报错而非静默重建」的立法本意。main 侧三处落盘
  （credentials/custom-providers/settings）同款原子写，见 storage-root.writeFileAtomic。

## 3. 存什么：pi 完整转录，不存投影

**核心决策（D5）**：盘上 `transcript` 存 pi 的 `AgentMessage[]`（含 system
消息、assistant 的 usage/stopReason/思考块等全部字段），`ChatMessage` 协议
投影只是**读时视图**（`toChatMessages`）。

为什么不用投影做存储格式：投影丢弃了 thinking 块边界、usage、模型元信息，
是有损形态 —— 有损格式存档，恢复就永远回不到 pi 的真实状态，将来的
toolCall 渲染、上下文压缩（需要完整块结构）全都无处取材。存储保真、
展示有损，两层各司其职。

## 4. 写时机：回合边界，不逐 delta

LLM 流式一秒多拍，逐拍写盘是纯写放大。选择**回合边界**写（create /
delete / setPinned / agent_end）：

- 回合内崩溃：丢当前回合（进程重启场景用户本就要重发），已完成回合永不丢；
- `persist()` 是**尽力语义**：失败只记 stderr 诊断、不抛 —— 转录还在内存，
  下次回合边界重写补上。绝不因存储故障炸掉/吞掉一次成功的 `run.completed`
  （外部世界失败是常态，约定.md §1.1；也绝不让它回滚一次成功的模型回复）。

## 5. 恢复语义：摘要即载，Agent 惰性重建

> 归属澄清（2026-11-09 追问）：`ensureAgent()` 是 **Cogent 自己写的**（session.ts
> 私有方法，pi 无此物）——它是持久化策略的落点：什么时候建实例、建的时候
> 灌什么历史，都是宿主的决定。`initialState.messages` 则是 **pi 的**：`AgentOptions.
> initialState` 类型 = `AgentState` 的 Partial（agent.d.ts:8），构造时传入即"预置转录"。
> 微妙处：pi 的类型注释明确约定 `messages` 已带 leading system 消息时，
> `initialState.systemPrompt` 不再另拼——盘上转录第一条就是当时的 system 消息，
> 所以恢复后连"当时的工作区声明"都原样回放，不会被新的默认提示词覆盖。

- 启动只读摘要（`ids()` + `get()` 拉 summary），**不实例化 pi Agent**；
- `Session.agent` 变为 optional，首次 `submit`/`messages`/`abort` 时
  `ensureAgent()` 才重建实例并把持久转录灌进 `initialState.messages` ——
  下一轮请求模型天然可见全部历史（保真恢复的本意）；
- 不惰性的代价：会话一多启动全量实例化，内存与启动时间都白花；
- **会话 id 用 UUID**：自增序号（旧 `s-${nextId++}`）在持久化后重启必然
  与盘上旧文件撞号 —— 这是纯增量改造里最容易被漏掉的破坏点；
- 形状收窄在信任边界（约定.md §1.1「持久化读取」行）：`asStoredSession`
  校验 version/summary.id/transcript 数组，损坏报错不静默重建。

### 5.1 坑：恢复期的"空列表自动初始化"撞上归档终态（2026-11-10 修）

现象：用户归档最后两个会话后重启，侧栏"最近"又出现两个"新会话"，看似归档
失效。盘上取证：被归档会话的 `archivedAt` 落盘无误，重启 4 秒后冒出的是**新建**
的会话（且相差仅 13ms 一对）——归档没坏，是启动路径在造幽灵。

根因两层，都在 renderer `chat.ts` 的 `load()`：

1. **语义冲突**：初载里"列表空就自动建一个"（为首装可直发写的）在引入归档
   （回收站语义）后变成 bug——「活跃列表空」有了第二种含义：**用户归档了
   全部会话（合法终态）**。每次重启都自动物化一个新会话并持久化，用户看到
   的"还在"其实是新生成的幽灵；
2. **并发放大**：React StrictMode（dev）双挂载 effect，两个 `load()` 并发
   都看到空列表 → 各建一个 → 盘上 13ms 双胞胎（取证时发现历史上已有多对，
   用户反复"归档→重启→又出现→再归档"）。

修法：**会话只随用户动作物化**——`load()` 不再自动建，空列表（首装/全归档
同态）统一落"新聊天"着陆页；发送时 `submit()` 按需 `createSession`（顺带修掉
"着陆页直发被静默丢弃"的隐患：原来 `activeSessionId` 为 null 直接 return）。

教训：**"空集合"在引入软删/归档语义后不再是单一状态**——初始化逻辑（首装
引导）与终态（清空）撞在同一信号上。引入软删时必须复查所有"列表为空"分支
的语义假设；另一条：任何"启动时自动创建持久化实体"的便利逻辑，都要问一句
"重启 N 次会怎样"（本 bug 即重启一次一个幽灵）。

## 6. 投影的 timestamp 修正

恢复历史时 assistant 消息的 `timestamp` 此前取 `Date.now()`（投影函数里
的顺手之笔）——重启回查后所有历史消息时间戳漂移成「回查时刻」。pi 的
`AssistantMessage.timestamp` 本就是请求开始时刻（毫秒），投影改为直取转录值。
教训：**投影层的"造"值会在存储层换数据源的那天变成 bug**。

## 7. 与 DeepAgent / 主流 Agent 对比

| 维度 | Cogent | DeepAgent（作者前项目） | Claude Code | Codex CLI |
| --- | --- | --- | --- | --- |
| 存储根 | `~/.cogent/`（userData 派系的反叛，见计划 D1） | 应用数据目录 | `~/.claude/projects/<cwd哈希>/` | `~/.codex/sessions/<日期>/` |
| 文件形态 | JSON，一会话一文件 | 单库/单会话随驱动而异 | jsonl（追加流） | jsonl（rollout，追加流） |
| 存的内容 | pi 完整转录（整文档覆盖写） | 消息列表（偏展示形状） | 完整事件流（追加，含工具事件） | 完整事件流 |
| 写时机 | 回合边界整写 | 按实现 | **逐事件追加**（jsonl 天然流式） | 逐事件追加 |
| 恢复 | 摘要先载 + Agent 惰性重建 | 直接读库 | 按需 resume 会话文件 | resume 读 rollout |

值得展开的三点：

1. **jsonl 追加 vs JSON 整写**：Claude Code/Codex 选 jsonl 是因为它们要
   在运行中随时崩溃安全（追加是 O(1) 且不会半文档损坏——最坏丢最后一行）；
   我们的回合边界整写在同样场景下最坏丢「最后一回合的落盘」（内存还在，
   进程死了才真丢）。桌面 GUI 场景回合粒度够用，且整写保留了「文件即
   完整状态」的可检查性。这是**崩溃窗口粒度**与**文件语义简洁性**的交换，
   不是优劣题。
2. **会话按工作区哈希归档（Claude Code）** vs **会话文件带 cwd 字段（我们 /
   Codex）**：前者目录结构即索引（`cd` 到哪个项目，历史就在哪个目录），
   但工作区移动/改名后哈希路径断裂；后者靠字段过滤，路径自由但要自己建索引。
   桌面应用有全局会话列表 UI，字段过滤更合适。
3. **DeepAgent 的教训**：存储形状跟着 UI 走（存展示形状），一旦要回放/
   分析/压缩就发现原始信息丢了 —— 本项目「存引擎真状态、投影做视图」
   的分层直接来自这个教训，与 pi 的 transcript-first 设计不谋而合。

### 7.1 DeepAgent/LangGraph checkpoint vs Cogent 的手写持久化

解决同一个问题（状态跨步骤存活），但机制与定位不同：

| 维度 | DeepAgent / LangGraph checkpoint | Cogent |
| --- | --- | --- |
| 谁实现 | 框架自动（checkpointer 一挂即有，业务零存储代码） | 业务手写（存储在 Cogent StorageDriver，重放在 pi agent loop） |
| 快照粒度 | 每一步（超步/super-step：单次 LLM/工具调用） | 每回合（agent_end 整文档覆盖写） |
| 主目的 | 中断恢复 + **时间旅行/分叉重跑** + 审批挂起 | 会话恢复（重启不丢） |
| 后端 | 可插拔（Memory/SQLite/Postgres） | StorageDriver（本地 JSON 先行） |

关键差异在目的：LangGraph 把 checkpoint 做成一等公民不是为了"重启不丢"，
而是为了**回到任意一步重跑**（从第 5 步分叉出另一条执行线）与
**人工干预后继续**（interrupt → 状态挂起等审批 → approve → resume）——
复杂工具链的中途干预场景。Cogent 当前纯对话（无工具层）用不到这些，
回合边界落盘已够。

**将来做审批流时不需要引入快照机制**：pi 的 `beforeToolCall` 钩子把 agent
停在工具执行前（等用户裁决），那一刻 transcript 本身就是"挂起状态"，
配合本层已有的回合边界落盘，等价于 checkpoint 的中断恢复——只失
"时间旅行"一项，而那需要"从中间状态恢复"的 API，pi 没有，真要做
属 pi 上游能力扩展。两个框架的哲学差异：**LangGraph 把执行图状态做成
框架资产；pi 把 transcript 做成唯一真相，怎么存、存哪里归宿主自定。**

顺带把"谁做了什么"归档：每轮请求把完整历史重放给模型 = pi；
转录跨重启存活 = Cogent（StorageDriver）；恢复时應回 = 两者合作——
Cogent 的 `ensureAgent()`（自写，决定何时/灌什么）经 pi 的
`initialState.messages`（pi 的预置入口）把盘上转录给回 agent。

## 8. 冒烟验证（协议级，无需窗口）

`COGENT_HOME` 指临时目录 + mock SSE 端点（同 开发.md 手法）：

1. 建 cwd 会话 → 对话一回合 → 置顶 → 盘上文件出现（UUID 文件名、
   version/summary/transcript 齐全、pinnedAt 在）；
2. **杀引擎重启** → `session.list` 复原（title/cwd/pinnedAt 全在）、
   `session.messages` 复原（转录 + 真实 timestamp）；
3. 恢复的会话直接续聊（惰性重建路径）→ mock 端点捕获请求体：模型可见
   全部旧上下文；转录累积、投影正确；
4. 删除会话 → 重启后列表只剩 1 条（删除真落盘）。

踩坑记录（探测脚本侧，非引擎）：断言里把 JSON 转义后的 `\\` 与源码字面量
`\\\\` 混写导致假 FAIL；响应 id 对错一个就静默等不到帧（引擎侧无任何问题）。
协议级冒烟的探测脚本本身也要小步验证。
