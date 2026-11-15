# 交互座（todo / ask_user / plan 闭环）

> 学习主题：Agent 的"计划与人机协同"三件套怎么造。zcode 有完整实现
>（EnterPlanMode/ExitPlanMode/AskUserQuestion/TodoWrite），dsh 是事件溯源
> 派，Pi-meme 走 InlineExtension。Cogent 的选择：全部收敛到
> **customTools + 挂起/回填 + 面板** 同一副骨架。落点见
> [../模块/交互座.md](../模块/交互座.md)。

## 1. 问题

Agent 光会"审批工具调用"不够：多步骤任务要清单防丢步（todo）；被人的
决策卡住时要能问而不是瞎猜（ask_user）；大改动要先出方案人批再动手
（plan 闭环）。pi 内核不预置这三样（内置 8 工具没有，loop 层也不管），
属于宿主要自建的能力。

## 2. pi 的做法（可用的缝）

- **customTools**：`createAgentSession({ customTools: ToolDefinition[] })`
  （agent-session.ts:276）静态注入；与扩展注册的工具汇入同一注册表、同过
  `tools` 白名单过滤（`_isAllowedTool`，:3679）——**名字必须列进白名单**，
  这是本次实施验证的第一个事实（不列 = 注册不激活）；
- **defineTool**：官方为"经数组传递时保参数推断"造的包装
  （extensions/types.ts:705-712 注释原话点名 customTools 场景）——不用它
  concrete 泛型会被展宽，execute 的 params 变 unknown；
- **挂起原语就是 async execute**：execute 返回的 Promise 悬着，pi 的
  agent loop 就停在那（工具不落结果、run 不结束）；signal abort 贯穿；
- **AgentToolResult.terminate**（agent/src/types.ts:445）："stop after the
  current tool batch" —— 拒绝方案后停轮的零成本原语；
- **before_agent_start 是 run 级钩子**（`_prepareRun` 内，agent-session.ts:
  2009）：run 起点算一次段，工具循环的后续 turn 不重跑——run 中途写的
  todo 要下一个 run 才进段（本轮工具结果已在上下文，无需段）。

## 3. 对比（出处见实现文档对比表）

| 机制 | zcode | dsh | Pi-meme | Cogent |
| --- | --- | --- | --- | --- |
| 注入缝 | 自有 registry | Cordis `ctx.tools.register` | InlineExtension + `pi.registerTool` | **customTools**（配置期静态，少一层扩展生命周期；Pi-meme 修正：咨询会话误记它走 customTools，实为 InlineExtension） |
| 挂起 | 权限 broker ask + 1s 重发 | `userQuestions.ask()` waterfall | ExtensionUiBridge pending Map | **镜像 pendingApprovals**（stdio/WS 直连必达，不重发） |
| 停轮 | stopTurnAfterResult（turn-control.ts:44-82） | `exec.concludeTurn()` | 无 | **terminate 位**（pi 原生） |
| todo 存储 | SQLite + todo_reminder | Session 事件 + projection | 无 | **转录（真源）+ cogent_todos 段（提醒）**，StoredSession 私有字段做 UI 种子 |
| plan 状态 | planEnabled 正交布尔叠 5 基础档 | plan/mode 日志事件 | TaskMode 枚举 | **复用四档里的 plan 档**（Cogent plan 本就是平级档，无需正交） |
| 批准后 | 写 .zcode/plans 文件（compact 后重读） | pendingIntent 下个 pre-step 落日志 | PlanDocument 存宿主 | **cogent_plan 段每回合在场**（比 compact 触发重读更及时；不污染工作区） |
| 拒绝带反馈 | 反馈升级为真实 user message（steerTurn） | — | — | **直接写进工具结果**（Cogent 结果文本本就可变，等效且少一条链路） |

## 4. 取舍

- **复用挂起骨架而非权限管道**：zcode 把 ask_user 的挂起塞进权限审批管道
 （requiresUserInteraction → broker），好处是一条通道；代价是"作答"要伪装
  成 `decision: modify + modifiedInput`。Cogent 三件各自 pending 表 + respond
  方法——语义直白，且审批链保持纯工具裁决；
- **kind='read' 直通审批链**：三工具是会话内交互无副作用；plan 档下可用
  （清单维护/澄清/提交方案正是 plan 工作流组成）——对照 zcode 的
  `allowedInPlanMode` 显式白名单，Cogent 用 kind 天然达成；
- **拒绝停轮 vs 反馈重提分流**：无反馈 = 用户要继续讨论（terminate）；
  带反馈 = 修订指令（不停轮）——zcode turn-control.ts:74 注释同判。

## 5. 实施期发现（与报审稿差异）

- `header` 参数漏包 `Type.Optional` —— 集成测试抓到：不传 header 的
  ask_user 被 TypeBox 拒绝、pi 不执行直接错误收口（工具结果含校验错误）。
  TypeBox Optional 的显式缺失语义与 Zod 一致，但漏写时 schema 层静默
  必然化，集成断言（挂起事件未到）是唯一暴露点；
- before_agent_start 的 run 级语义（见 §2）——首版集成断言假设"回合级"
  热刷新，实测段在下一个 run 才出现，修正断言并记入本笔记；
- 与报审稿其余一致（批已含 §3.5 全部协议面）。

## 6. 落点

`interact-tools.ts`（schema/校验/格式化 + 三工厂）、`session.ts`
（pendingQuestions/pendingPlans + respondQuestion/respondPlan + settle +
段源）、`pi-session-factory.ts`（customTools 透传 + sections 通用化——
权限/技能/清单/计划四段同钩子）、协议 `question.asked`/`plan.requested`
事件 + `question.respond`/`plan.respond` 方法、壳三端 `questionRespond`/
`planRespond` 专属通道、renderer TodoStrip/QuestionPanel/PlanPanel。
