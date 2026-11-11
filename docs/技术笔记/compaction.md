# 上下文压缩（context compaction）

> 对应 [计划-pi借鉴.md](../计划-pi借鉴.md) 批次 4（D7 定稿：自动阈值 90% + 手动
> 双路）。代码：`agent-service/runtime/compaction.ts`（纯函数）+
> `runtime/session.ts`（接线）+ `features/home/CompactionBar.tsx`（折叠条）。
> 上游对照：`reference/pi/packages/coding-agent/src/core/compaction/`。

## 1. 问题

长会话的转录只增不减，三笔账迟早爆：

1. **窗口**：pi 每轮全量重发上下文，转录长过模型 contextWindow 后请求直接
   被端点拒绝（context overflow）；
2. **成本**：input 随轮次线性涨，第 50 轮为一个错别字重发 49 轮的历史；
3. **注意力**：远期的工具输出噪音稀释近期任务焦点（lost in the middle）。

朴素的头部截断不行：模型会忘记自己做过什么、用户要什么。压缩的本质是
**用一次便宜的 LLM 调用把旧历史蒸馏成结构化检查点（checkpoint）**——目标、
约束、进度、关键决策、下一步——旧区换摘要、近期对话原样保留，续聊时模型
拿着"摘要 + 近期原文"继续工作。

## 2. pi 的做法（源码，coding-agent compaction/）

- **存储表示**：压缩是会话树上的 `CompactionEntry`（summary + firstKeptEntryId
  + tokensBefore + details），**不是转录消息**。投影时（session-manager.ts
  `buildContextEntries`）最新的压缩条排最前、保留区从 firstKeptEntryId 起、
  被摘要条目全部隐去；压缩条投成 `compactionSummary` 自定义 AgentMessage
  （messages.ts 声明合并 `CustomAgentMessages`），`convertToLlm` 把它转成
  user 消息（"The conversation history before this point was compacted into
  the following summary: <summary>…"）——**对模型是上下文，对 UI 是标记行**，
  一个角色两种投影；
- **触发三路**（agent-session.ts）：`/compact` 手动；threshold（agent_end 后
  `_checkCompaction` + 下一响应前 `_compactBeforeNextAssistantResponse`
  双检查点）；overflow（provider 报上下文溢出 → 删失败轮 → 压缩 → 重试一次，
  `_omitRecoveryAttempt` + `_overflowRecoveryAttempted` 单次闸）；
- **判定**：`shouldCompact = tokens > contextWindow - reserveTokens`（缺省
  16384 **固定绝对值**）；估算 = 末条有效 usage + 其后消息 chars/4 粗估
  （`estimateContextTokens`），且带**时效守卫**——压缩摘要等前缀消息插入后，
  早于它的 usage 不能再描述当前前缀（pi-ai estimate.ts L80 注释点名该场景）；
- **切点**：`findCutPoint` 从尾往回累计 token 至 keepRecentTokens（缺省 20000），
  合法切点 = user/assistant 消息（**永不切 toolResult**——它必须跟着自己的
  toolCall）；允许切在 assistant 上（回合被劈开），代价是 turn-prefix 二次
  摘要把劈开的前半段单独总结，两段摘要拼接；
- **摘要请求**：`completeSimple` 独立小请求（系统提示词 "Do NOT continue the
  conversation. ONLY output the structured summary"）；主提示词 = `<conversation>`
  标签包序列化文本（防模型当对话续写）+ 结构化模板（Goal / Constraints &
  Preferences / Progress(Done/In Progress/Blocked) / Key Decisions / Next
  Steps / Critical Context）；**迭代更新**：已有旧摘要时换 UPDATE 提示词 +
  `<previous-summary>` 标签（PRESERVE all existing information）；toolResult
  截 2000 字符、thinking 不序列化；文件操作表（read/write/edit 的 path）以
  `<read-files>`/`<modified-files>` XML 尾缀进摘要，details 里另存结构化一份；
  error/length 停因的半截摘要拒收（`getSummarizationFailure`）；整包套
  `retryAssistantCall` 走重试策略；
- **事件**：`compaction_start` / `compaction_end`（reason = manual/threshold/
  overflow，失败带 errorMessage）；压缩后**会话重载**（投影重建，树存储的
  天然动作）。

## 3. 对比

| | 触发 | 判定口径 | 摘要形态 | 摘要请求 | 特殊能力 |
| --- | --- | --- | --- | --- | --- |
| **pi** | 手动 / 阈值（固定 reserve 16384）/ 溢出恢复 | 末轮 usage + trailing 粗估（带时效守卫） | 结构化 checkpoint（6 节）+ 迭代更新 + 文件表 XML | 同会话模型 completeSimple（可带思考档、走重试策略） | 会话树 + 分支摘要（branch-summarization） |
| **Claude Code** | 手动 `/compact`（可带聚焦指示）+ auto-compact（默认开，接近上限触发，公开提示词工程同源） | 官方未公开精确阈值；上下文百分比档 | 8 段结构化摘要（Primary Request / Key Technical Concepts / Files and Code Sections / Errors and fixes / …/ Current Work，提示词随版本泄露广为流传） | 主对话模型 | **microcompact**（0.2.x）：空间紧张时只压缩旧工具结果，不整段摘要 —— 分层压缩思路 |
| **OpenAI Codex CLI** | 自动（接近上限时后台压缩历史） | rust 侧 token 计数 | 历史要点摘要 | 独立请求 | 压缩后继续同一会话，无手动命令（公开资料层面） |
| **DeepAgent**（LangChain deepagents） | 中间件 opt-in（`summarization`） | 步数/触发器可配 | 摘要替换旧消息（prompt 定制） | 图内 summarize 节点 | 挂在图编排层：压缩即图状态，天然可持久化/恢复 |
| **Cogent** | 手动 `session.compact` / submit 前阈值（**90% 百分比**，D7） | pi-ai `estimateContextTokens` 同源（预算同口径 + 时效守卫白捡） | pi 同款 6 节 checkpoint + 迭代更新 + 文件表 XML（照搬） | 会话当前模型 `completeSimple`（带思考档；重试不接，批次 8.4 挂账） | 转录内 `compactionSummary` 消息角色（线性存储，无投影层） |

关键分歧：**压缩记录存在哪**——pi 存会话树的 entry（投影时才变成消息），
Claude Code/Codex 在各自的会话状态里，Cogent **直接作为转录消息存盘**（线性
JSON 转录，无投影层可依赖，消息即真源）；**溢出恢复**——pi 有 compact-and-
retry，Cogent D7 明确不做（provider 溢出走 run.failed 显式暴露，用户手动
压缩或换大窗模型）；**阈值口径**——pi 固定 16384（对 8K 模型=79% 触发、对
200K 模型=92%，小窗反而更早触发），Cogent 百分比对各窗口语义一致。

## 4. 取舍记录（Cogent 线性转录的改造，偷法第 1 则）

- **转录表示 = 自定义消息角色 + convertToLlm 选项**：`declare module
  '@earendil-works/pi-agent-core'` 声明合并加 `compactionSummary` 角色（pi
  官方扩展通道），Agent 构造给 `convertToLlm` 把它转 user 消息——请求组装、
  落盘、历史回查零特殊分支（除投影处一处 role 分支）。**必须给**：缺省的
  convertToLlm 是恒等直通，未知 role 透给 provider 会被拒收；
- **system 消息全保留前置**（vs 上游保留段滤掉、压缩条带一条 systemMessage）：
  我们的 systemPrompt 是转录全部 system 消息的重放拼接（权限通告
  `[cogent:permission]` 在转录里），随摘要丢弃 = 静默丢失权限语义；领头
  system（工作区+工具声明）还是 ensureAgent "已在首位不再补插"的判据；
- **切点只取 user 边界**（vs 上游 user/assistant + split-turn 二次摘要）：
  线性转录里整回合摘要/保留语义更清晰，砍掉 turn-prefix 摘要的复杂度；
  已知边界：单回合超窗口 → 不压缩、provider 显式报错（比静默劈开回合诚实）；
- **文件表靠文本载体**（vs 上游 details 结构化转发）：旧摘要的 XML 尾缀在
  摘要文本里，UPDATE 提示词的 "PRESERVE exact file paths" 规则让文本自身
  完成跨代合并，无需结构化字段；
- **触发单点 = submit 前**（vs 上游 agent_end + pre-prompt 双检查点）：
  正确性等价（下一请求前压缩即正确时机），指示器回落由 completed 事件直接
  驱动，不依赖提前一拍的检查；
- **重建 = `agent.state.messages` 换引用**（vs 上游会话 reload）：pi 的
  setter 自带拷贝，与 applyPermissionNotice 同一手法，无投影层就无需重载；
- **并发护栏 `compacting` 集合**：摘要发生在 prompt 之前——pi 尚未置
  isStreaming，submit 的忙碌检查在这个秒级窗口裸奔，第二个 submit 会双压缩
  +双 prompt；入口先查集（自动/手动/submit 三处），runCompaction 的
  finally 出集；
- **压缩条 timestamp = now 的妙处**：pi-ai 估算的时效守卫按"前缀里晚于
  usage 的消息"判 usage 作废——压缩后保留区的旧 usage 自动失效、估算退回
  纯字符口径，**不需要自己记账**；
- **自动失败不拦提交**（尽力语义）：摘要服务抖一下不该吞掉用户消息；真
  溢出由 provider 报错走 run.failed 显式暴露。手动路相反：无可压缩/失败都
  以协议错误显式反馈（手动动作要明确结果）；
- **不搬清单**：overflow compact-and-retry（D7）、retryAssistantCall 包装
  （批次 8.4 provider 网络层对照后统一）、branch-summarization（会话树在
  远期池）。

## 5. 在 Cogent 的落点

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 纯函数 | `runtime/compaction.ts` | 角色声明 + convertToLlmMessages（Agent 选项与估算前置共用）、shouldCompact（90%）、findCutPoint（user 边界）、prepareCompaction / rebuildTranscript（system 前置 + 压缩条 + 保留区）、双摘要提示词 + serializeConversation、文件表提取与 XML 尾缀、响应安全判定 |
| 接线 | `runtime/session.ts` | submit 前 maybeCompactBeforePrompt（阈值检查→runCompaction→prompt 串行）；compactSession 手动路（忙/无可压缩 → InvalidRequest）；runCompaction（completeSimple + 落盘 + 双事件 + compacting 护栏）；estimateContext 先过转换（自定义角色防估算炸）；toChatMessages 投影 role 'compaction' |
| 协议 | `protocol/types.ts` | `compaction.started/completed` 事件（additive；completed 带 summary/前后 token/summarizedUntil 锚/失败 error）、`session.compact` 方法、ChatMessage role 'compaction' + compaction 元数据 |
| 壳 | `electron/main/ipc/engine.ts` | 白名单加 session.compact |
| renderer | `stores/chat.ts` + `features/home/CompactionBar.tsx` + `TurnGroup.tsx` + `ContextIndicator.tsx` | completed 事件做**本地列表手术**（summarizedUntil 之前的条目原位换折叠条，不重拉历史——重拉与 prompt() 追加用户消息有竞态）；折叠条（TraceCollapsible 家族，展开可读摘要全文）；TurnGroup 独立行快路（不套「已工作」头条——压缩不是 run）；指示器 90% 预警刻度 + 回落（压缩条新于末条 usage → 分子切 tokensAfter 估算，≈ 标记） |

冒烟：`tmp/cogent-smoke/compaction-smoke.mjs`（8 项断言：阈值触发 / 前后
token / 请求体不携带已摘要原文 / 摘要投影+保留区+新问进请求 / 重启复原 /
手动无可压缩报错 / 手动成功 / 迭代 previous-summary 合并；mock 不回 usage
——回了反而锚在假数上永不触发），配方入 开发.md。
