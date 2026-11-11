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
  `role:'toolResult'` 消息（toolCallId 配对）—— 恢复历史按 id 配对投影；
- **systemPrompt 是重放产物，不是存储字段**（批次 2.5 调研，改提示词的官方
  通道）：`AgentState.systemPrompt` 只读，getter = `getCurrentSystemPrompt(
  messages)` —— 遍历 transcript **全部** system 消息按序拼接文本（pi-ai
  `utils/transcript.js`）；要改提示词就**追加 system 消息**（types.d.ts 注释
  原话）。mid-conversation system 的落点：请求组装时 `resolveTranscript` 按
  方言分叉 —— 模型支持（`supportsMidConvoSystemMessages`）则原位保留；
  不支持（anthropic 默认 false、openai-completions 按模型 compat）则
  `collapseSystemMessages`：重放合并的 system 提到最前、原位置各条全部滤掉
  —— **合并而非丢弃**，toolUse/toolResult 配对不被中部 system 打断。这使
  "权限通告"可以安全地落在 transcript 里随切换更新（见取舍记录）。

Cogent 在 pi 骨架外补的：`CogentTool { tool, kind, summarize }` 包装（pi 的
AgentTool 无风险类别 —— kind 是产品语义不是引擎语义）；`TOOL_METAS` 静态表
（历史回查在 Agent 未实例化的会话上也要 kind/摘要，不能依赖活实例）。

## 3. 对比

| | 风险分级 | 审批判定 | 挂起实现 | 记忆（"总是允许"） |
| --- | --- | --- | --- | --- |
| **Cogent** | ToolKind 四类（read/write/exec/network） | 引擎一处矩阵：kind × permissionMode（会话级 auto/ask/plan）+ 工作区级规则表（批次 2.5） | beforeToolCall 返回 pending Promise + pendingApprovals 表 + signal 兜底 | **工作区级持久**（`~/.cogent/approvals.json`，roots×kind 快照；批次 2.5） |
| **Claude Code** | 工具名 × 参数（Write/Edit/Bash 分立，Bash 按命令前缀） | permission-mode（default/acceptEdits/plan/bypassPermissions）× settings.json 的 allow/deny 规则表 + PreToolUse hook 可改写判定 | SDK 侧 control protocol 挂起（CLI 内联 canApprove 弹窗；headless 模式 canUseTool 回调） | 分工具：Bash/WebSearch 域 = 永久落盘 settings（存精确命令，**曾泄漏密钥** —— Apiiro 实锤 settings.local.json 被误提交）；文件写（Edit/Write）**只到会话结束，刻意不落盘**，永久放行走模式不走规则 |
| **OpenAI Codex CLI** | 沙箱三档（read-only/workspace-write/danger-full-access）与审批策略（untrusted/on-failure/on-request/never）**两维独立** | Rust 引擎 exec 前按 (sandbox, approval_policy, 命令分类) 查表 | TUI 收到审批请求渲染按钮，通道双向（approveRequest/denyRequest） | 无 always 规则；等价物 = trusted projects（`~/.codex/config.toml` 目录信任）；`untrusted` 策略因太烦已退役（0.49+） |
| **DeepAgent**（LangChain deepagents） | 工具粒度：human_in_the_loop=[...] 指定哪些工具要审 | 包装层：待审工具改为先返"待确认"标记内容 | **LangGraph interrupt()**：图执行硬停在节点边界，Command(resume) 恢复 —— 挂起即图状态，天然可持久化/可恢复（Cogent 的挂起是进程内 Promise，引擎重启=丢） | 无内置（resume 时业务自己记） |
| **ChatGPT 桌面 Agent** | 操作分级（浏览/改动/系统） | 会话级"完全访问"开关（关=逐操作确认） | 产品侧（非开源），确认卡挂在消息流 | 会话级记住 |

规则表流派补充（批次 2.5 三家调研，详表见 计划-审批交互升级.md §1.5）：
Qoder「始终允许本项目」= 项目级持久（Cogent 同流派）；三家共识 = **文件写的
永久放行绑定"位置"不绑定"内容"** —— Cogent 只存 roots 不存命令/内容，且存
引擎侧全局（`~/.cogent`）不进项目目录，杜绝 Claude Code 的 repo 内误提交
泄漏面。判定优先序 = 软边界（工具执行层越界恒拒）> 规则表放行 > mode 矩阵，
与 Claude Code「deny > allow 严格序、跨作用域 deny 终局」铁律同构。

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
  宿主可感知（store 层乐观翻卡 + catch 收声，终局以 run 终态事件为准）；
- **确认面板 vs 弹窗（批次 2.5 D1；2026-11-11 用户两次定调）**：弹窗打断感强
  （模态抢焦点，多审批排队更糟），Claude Code/Codex/图 1 产品全是内嵌面板 ——
  Cogent 落对话底部确认面板，且**待审批时替换输入区**（首版「输入区上方常驻
  + 输入框仍可打字」被用户推翻：run 挂起中本就发不出消息，留着能打字的框是
  误导 —— HomeChat 条件切换 Panel/Composer，输入草稿提升父层持防卸载丢字）；
  **卡内布局照参考图定稿** = 竖排全宽选项列表 + 序号 + 选中态高亮（终端式
  选择的 GUI 化：↑↓/Tab 移动选中、Enter/确认钮执行选中项、点击直接执行），
  替代首版的横排按钮组 —— 竖排每项带说明文案的空间是横排给不出的。pending
  态是会话级状态（pendingApprovalsBySession，数组形态 —— pi 并行执行同批工具
  会并发多个 approval.request），裁决完成后落置灰痕迹行进消息流（ApprovalCard
  收窄为终态 TraceLine；痕迹是进程内存态，跨重启审计靠工具卡 error 形态 ——
  拒绝的写在转录里是 isError toolResult，持久）；
- **「告诉模型接下来怎么做」= 拒绝 + 附言（D2）**：附言拼进 block reason →
  pi 工具 error 结果回灌模型（2000 字符截断），是 steering 的最小雏形 —— 真
  运行中插话（pi 已有 steer()/followUp() 队列）是后续空位，不混做；
- **规则表为什么单文件 + 只存 roots（D3）**：规则是全局一小份（预计个位数），
  单文件整读整写最贴切（driver collection 是一实体一文件的目录语义，不匹配）；
  Claude Code 的 settings.local.json 存精确命令（含密钥）被误提交泄漏的教训
  → 只存位置；`untrusted` 策略太烦被 Codex 退役的教训 → 面板五件套封顶、
  「本会话始终允许」中间档不做（完全访问已覆盖会话级需求）；
- **权限通告走 transcript 单条替换，不进 buildSystemPrompt（D6 评审补）**：
  leading system message 在 createAgent 固化，而模式运行中可切 —— 若把权限
  句固化进 leading，auto 切回 ask 后残留「已授予完全访问」的有害提示。正道
  （pi systemPrompt 重放机制，见 §2）：transcript 内单条 `[cogent:permission]`
  system 通告，setPermission 时按前缀识别**原地替换**（纯追加会随来回切换
  堆积 —— 重放是文本拼接不是覆盖）；ask = 移除。审批挂起时切「完全访问」
  也安全：中部 system 在请求组装时被 collapse 合并领头，不打断
  toolUse/toolResult 配对，下一轮即生效。

## 5. 在 Cogent 的落点

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 工具本体 | `tools/read|glob|grep|write.ts`（path/walk 底座） | 只读不限界（resolveAgainstBase）；write 软限界（resolveWithinRoots，越界 error 结果带可写根提示） |
| 注册表 | `tools/index.ts` | buildTools(基根) + TOOL_METAS（kind/摘要静态表，历史回查共用） |
| 审批矩阵 | `runtime/session.ts` createAgent.beforeToolCall | read 放行；write 按 mode：auto 放行 / plan block / ask 先查规则表（任一根命中放行）再发 approval.request 挂起（D5 无超时；signal abort、会话删除、disposeAll 三路收尾） |
| 规则表 | `runtime/approvals.ts` ApprovalRegistry | `~/.cogent/approvals.json` 单文件（tmp+rename 原子写，不走 driver collection）；roots×kind 快照、判定 = 会话根交集、add 幂等、损坏旁置 .corrupt 按空表继续 |
| 权限通告 | `runtime/session.ts` applyPermissionNotice | transcript 内单条 `[cogent:permission]` system 通告（替换式更新，ask = 移除）；setPermission/ensureAgent 两处驱动 |
| 协议 | `protocol/types.ts` | approval.request 事件 / approval.respond（message 附言 + always='workspace' 扩参，additive）、session.setPermission method / SessionSummary.permissionMode |
| 壳 | `electron/main/ipc/approval.ts` + `ipc/settings.ts` | `approval:respond` 专属 IPC 透传 optional 新参；settings.json 增 defaultPermissionMode（新会话默认，开关两态） |
| renderer | `stores/chat.ts`（pendingApprovalsBySession + ApprovalItem 痕迹行）+ `features/home/ApprovalPanel.tsx` / `PermissionMenu.tsx` / `ApprovalCard.tsx`（终态痕迹） | 底部确认面板五件套（允许/始终允许此工作区/完全访问两步串/拒绝/附言输入）；权限模式菜单四档（自主模式随 bash 落地解灰）；侧栏等待确认 tag（HomeSidebar 派生） |

冒烟：`/tmp/cogent-smoke/approval-smoke.mjs`（14 项断言：允许往返落盘 / 拒绝
error 结果 / 重复裁决 InvalidParams / auto 零审批直写 / 越界拦截 / abort 挂起
收尾），配方入 开发.md。

## 6. 验收修复实录（2026-11-11 批次 3 验收）

1. **权限菜单点击无响应**：PermissionMenu 菜单项误用 Radix 风格 `onSelect`，
   而 base-luma 是 Base UI 原语 —— `onSelect` 静默落到 DOM 原生 select 事件
   （只在输入框选中文本时触发），菜单项点击永远不进 handler，整个模式切换
   是死的（用户"开了自主模式"实际没切上，write 照弹审批）。修 = `onClick`
   （项目内 ModelMenu/HomeSidebar 本就同款）。教训：**shadcn 组件名相容
   Radix/new-york 语法，但 base-luma 变体的事件语义跟 Base UI 走**，从
   Radix 文档抄配方时要对每招核对原语实现；
2. **「已允许」痕迹行位置与方向（两轮验收）**：run.completed 终态替换原把
   keptApprovals 一律续在段化终态之后（回合尾部），痕迹行被压到思考行之下
   —— 第一轮修成"锚回工具卡**之后**"；用户复验仍觉颠倒（读成"先完成再
   允许"），终判 = 痕迹行在工具卡**之前**（时序：先裁决、后执行，与批次 2
   时代审批卡在消息流的原位置同向）。按 名+摘要（与工具卡同源于
   TOOL_METAS.summarize）配对插放，流式期 respondApproval 与终态重锚同方向
   （收尾翻转零位移），配不上退尾部兜底。
3. **完全访问升级为危险确认闸门 + 触发钮配色按 D5 收敛**（同日用户定调，
   照参考图）：菜单选「完全访问」不再直接切换 —— FullAccessConfirm 弹窗
   （警告图标/权限项卡片/风险提示/「我已了解风险」勾选门控/取消 + destructive
   红确认，未勾选禁用；每次打开重置勾选）。确认钮红与菜单触发钮琥珀并存：
   前者是危险动作闸门语义，后者是常态警示（D5 不变）。触发钮曾全态
   text-warning（模式间无区分），修为三色：完全访问 = warning 琥珀、
   自主模式 = chrome-accent 蓝（用户点名，链接同款实色 token）、
   计划/变更前确认 = muted-foreground 灰。权限项卡片只列已落地能力
   （文件/终端），network 工具（D10 批次 7）落地后补「网络和应用」行。
   配方沉淀 UI布局.md。
