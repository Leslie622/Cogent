# 工具系统与审批（tools & approval）

> 对应路线空位 2 本体 + 空位 4 后半 + 空位 6。批次 1（2026-11-10，只读工具 +
> 段化 + 工具卡）与批次 2（2026-11-11，write + 审批拦截 + 完全访问）两批落地，
> 本笔记覆盖全景。代码：`src/agent-service/tools/`、`runtime/session.ts`、
> `electron/main/ipc/approval.ts`、`renderer/.../ApprovalCard.tsx`。

## 1. 问题

没有工具循环的 Agent 只是聊天机器人：模型说"我应该先读 package.json"，然后
只能等用户贴内容。工具系统要回答三个问题：

1. **执行**：工具怎么注册、参数怎么校验、结果怎么回灌模型（工具循环）；
2. **风险分级**：读文件和写文件不是一种动作 —— 谁来判定"这个调用需要人点头"；
3. **挂起**：LLM 循环是异步流水线，"等用户点击"意味着循环中途悬停 —— 谁保它
   不死锁、可中止、可恢复。

第 3 问是工程难点：挂起发生在模型两次请求之间，协议层要有事件通知宿主"我在
等你裁决"，宿主裁决要有回流通道，中止/删会话/退出要把悬着的 Promise 收口。

## 2. pi 的做法（源码，pi-agent-core 1.5.0）

pi 无内置工具包（连 read 都没有），只给骨架：

- **AgentTool**：`{ name, label, description, parameters, execute }`，参数用
  pi-schema builders（obj/str/opt/int…）声明 + 自动校验（`agent-loop.js`
  prepareToolCall → validateToolArguments，非法参数直接 error 结果，不进 execute）；
- **执行管线**（`agent-loop.js` executeToolCalls）：`tool_execution_start` 事件
  （L352/385/421 三处 —— sequential/parallel/truncated 三路都先发）→
  `prepareToolCall`（L499 内含 beforeToolCall 钩子）→ execute →
  `emitToolExecutionEnd`（L654）。**start 事件在审批钩子之前**：宿主会先看到
  running 卡、随后才是审批请求 —— 不是 bug，是"调用已发生、执行未放行"的
  如实呈现；
- **beforeToolCall**（`types.d.ts` L279）：`(context, signal?) => Promise<
  BeforeToolCallResult | undefined>`；`{ block: true, reason }` = 拒绝（模型收
  error 工具结果，reason 为可见原因），undefined = 放行；**返回 pending
  Promise = 挂起**，signal 在 abort 时触发 —— 挂起方必须监听它，否则中止后
  Promise 永悬、run 永不收尾；block 后 pi 照发 `tool_execution_end(isError)`，
  事件流不需要合成任何帧；
- **转录**：工具调用 = assistant 消息的 toolCall 块，结果 = 独立
  `role:'toolResult'` 消息（toolCallId 配对）—— 恢复历史按 id 配对投影。

Cogent 在 pi 骨架外补的：`CogentTool { tool, kind, summarize }` 包装（pi 的
AgentTool 无风险类别 —— kind 是产品语义不是引擎语义）；`TOOL_METAS` 静态表
（历史回查在 Agent 未实例化的会话上也要 kind/摘要，不能依赖活实例）。

## 3. 对比

| | 风险分级 | 审批判定 | 挂起实现 | 记忆（"总是允许"） |
| --- | --- | --- | --- | --- |
| **Cogent** | ToolKind 四类（read/write/exec/network） | 引擎一处矩阵：kind × permissionMode（会话级 auto/ask/plan） | beforeToolCall 返回 pending Promise + pendingApprovals 表 + signal 兜底 | 无（逐次裁决，批次 3 再议） |
| **Claude Code** | 工具名 × 参数（Write/Edit/Bash 分立，Bash 按命令前缀） | permission-mode（default/acceptEdits/plan/bypassPermissions）× settings.json 的 allow/deny 规则表 + PreToolUse hook 可改写判定 | SDK 侧 control protocol 挂起（CLI 内联 canApprove 弹窗；headless 模式 canUseTool 回调） | 有：`Always allow` 写会话级规则，可持久化到 settings |
| **OpenAI Codex CLI** | 沙箱三档（read-only/workspace-write/danger-full-access）与审批策略（untrusted/on-failure/on-request/never）**两维独立** | Rust 引擎 exec 前按 (sandbox, approval_policy, 命令分类) 查表 | TUI 收到审批请求渲染按钮，通道双向（approveRequest/denyRequest） | 有：session 级 remember choice |
| **DeepAgent**（LangChain deepagents） | 工具粒度：human_in_the_loop=[...] 指定哪些工具要审 | 包装层：待审工具改为先返"待确认"标记内容 | **LangGraph interrupt()**：图执行硬停在节点边界，Command(resume) 恢复 —— 挂起即图状态，天然可持久化/可恢复（Cogent 的挂起是进程内 Promise，引擎重启=丢） | 无内置（resume 时业务自己记） |
| **ChatGPT 桌面 Agent** | 操作分级（浏览/改动/系统） | 会话级"完全访问"开关（关=逐操作确认） | 产品侧（非开源），确认卡挂在消息流 | 会话级记住 |

关键分歧点：

- **判定在哪层**：Claude Code/Codex 在**宿主/引擎贴身层**查表（规则可来自用户
  配置文件），Cogent 放**引擎协议层**（beforeToolCall 一处，UI 只是裁决面板），
  DeepAgent 放**图编排层**。Cogent 的选择理由：矩阵是跨宿主一致的安全语义
  （换壳不改行为），且事件（approval.request）与回流（approval.respond）都已是
  协议帧，任何宿主可驱动；
- **审批 vs 沙箱**：Codex 的沙箱是 OS 级（seatbelt/landlock 白名单文件系统），
  审批只是沙箱之上的 UX；Cogent/DeepAgent/Claude Code 无 OS 沙箱，审批即安全
  边界（Cogent 前计划 D6 已定永不做硬沙箱，write 的 resolveWithinRoots 是**软**
  边界 —— 模型可见可纠正，防的是误写不是恶意）；
- **挂起语义**：DeepAgent 的 interrupt 挂在图状态里（可跨进程恢复），Cogent 挂在
  引擎进程内存（引擎重启=挂起丢失，run 已死无所谓恢复）；Claude Code 的
  headless canUseTool 也是进程内。桌面单机语境下进程内挂起够用。

## 4. 取舍记录

- **pi 时序（start 先于审批）起初与协议注释相悖**：注释原写"审批放行后才发
  tool.started"，实现时核对 pi 源码发现 start 恒先发。接受该时序：running 卡
  先行 + 审批卡随后，正好表达"调用已发生、执行未放行"；拒绝后 end(isError)
  自然收口，流式段化/历史回查/事件流三条投影路径零特判（修正了协议注释）；
- **审批卡是用户痕迹，不随终态替换消失**：模型转录里拒绝只是 error 工具结果，
  用户点过什么无处可查 —— run.completed 替换时保留 approval 行（续在段化终态
  后），终态呈置灰单行；
- **「完全访问」暂存位不持久化**：跨会话记住"上次开了全放行"会让用户忘了关；
  新会话永远回 ask 缺省（home store 视图态暂存，物化时随 session.create 落定）；
- **重复裁决 → InvalidParams 而非静默**：双击/与中止竞态都属此类，显式报错让
  宿主可感知（store 层乐观翻卡 + catch 收声，终局以 run 终态事件为准）。

## 5. 在 Cogent 的落点

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 工具本体 | `tools/read|glob|grep|write.ts`（path/walk 底座） | 只读不限界（resolveAgainstBase）；write 软限界（resolveWithinRoots，越界 error 结果带可写根提示） |
| 注册表 | `tools/index.ts` | buildTools(基根) + TOOL_METAS（kind/摘要静态表，历史回查共用） |
| 审批矩阵 | `runtime/session.ts` createAgent.beforeToolCall | read 放行；write 按 mode：auto 放行 / plan block / ask 发 approval.request 挂起（D5 无超时；signal abort、会话删除、disposeAll 三路收尾） |
| 协议 | `protocol/types.ts` | approval.request 事件 / approval.respond、session.setPermission method / SessionSummary.permissionMode（全部 additive） |
| 壳 | `electron/main/ipc/approval.ts` | `approval:respond` 专属 IPC（D3：不经 renderer 通用代理，安全边界独立成路） |
| renderer | `stores/chat.ts`（ApprovalItem）+ `features/home/ApprovalCard.tsx` | 审批卡（AI Elements Confirmation 配方 = Item 原语 + 双钮；终态 TraceLine 置灰）；respondApproval 走 preload 专属通道 |

冒烟：`/tmp/cogent-smoke/approval-smoke.mjs`（14 项断言：允许往返落盘 / 拒绝
error 结果 / 重复裁决 InvalidParams / auto 零审批直写 / 越界拦截 / abort 挂起
收尾），配方入 开发.md。
