# 计划 — pi 借鉴总纲（把 pi-coding-agent 的好东西分批"偷"进 Cogent）

> ⛔ **已封存（2026-11-13，全局架构定稿）**：未实施批次（技能+斜杠命令 / mcp 等）
> 停更，后续工作一律按 [全局架构.md](../全局架构.md) 的阶段路线走（对应能力落在
> 其阶段 4 能力总线）；已完成批次的事实见 `docs/模块/` 与 `docs/技术笔记/`。

> 状态：**进行中 —— 唯一活跃主计划**（2026-11-11 立项；**批次 3（工具终章）六步已于同日全部落地**，tools-smoke 39 项全过；**批次 4（上下文压缩）两步
> 已于 2026-11-12 落地**，compaction-smoke 8 项全过；同日归并
> 工具系统与审批.md 与 回合过程折叠.md 的全部遗留件，其余计划文档
> 均已归档——**日常只看本文档**）。素材库已就位：`reference/pi/`（sparse clone
> agent / ai / coding-agent 三包，MIT，gitignore + eslint ignore 隔离；更新走
> `git -C reference/pi pull`，仓库级代理已配）。
> 前提共识：pi-coding-agent 是**同引擎（pi-agent-core）不同形态**（终端 CLI 单进程
> vs 我们 Electron GUI 三进程）的官方参考实现，不是竞品。
> **批次编号说明**：续接 [工具系统与审批.md](工具系统与审批.md) ——
> 批次 1（read/glob/grep + 段化 + 工具卡，2026-11-10）与批次 2（write + 审批拦截 +
> 完全访问，2026-11-11）**已实现上线**，本文档从批次 3 起；不重编号，保与提交历史 /
> 提交历史 / 技术笔记的口径一致（别处说"批次 3"恒指 edit/bash）。

## 0. 偷法四则（每批开工前重读）

1. **算法照搬，接线照 Cogent**：diff / 截断 / 队列等纯逻辑按 MIT 直接搬（文件头
   保留上游版权声明），但每个工具必须包 `CogentTool{tool, kind, summarize}`、
   kind 进 ToolKind×权限矩阵、写类走 `resolveWithinRoots` 软限界、历史回查与流式
   双投影同源——这些是三进程拓扑（renderer←IPC→main←JSON-RPC→agent-service）的
   结构约束，绕不开也不该绕；
2. **上游单进程的优势拿不走，模式拿得走**：TUI renderers / 富 details 直渲染 /
   零序列化搬不动；Operations 注入、file-mutation-queue、content与details分离、
   扩展系统这些**模式**可以跨进程搬，无损失；
3. **一模块一笔记**：每批完成后 [docs/技术笔记/](../../技术笔记/README.md) 一篇，必须
   含"上游怎么做 vs 我们怎么做 vs 为什么不同"三段对比（学习项目核心产出）；
4. **每步可运行 + 用户验收**：步内三关全绿（lint / typecheck / build），冒烟配方
   沉淀配方（现 docs/UI布局.md），UI 件用户逐件验收后才算过；
5. **存量也要过堂（实现归实现，好归好）**：已实现 ≠ 已最优，已上线不是免检
   金牌。每个存量模块都要与上游对应物对照一遍，结论四选一并记录：**照搬替换 /
   吸收改造 / 我们更好（写明理由）/ 上游无对应（记录）**——举证责任在我们这边：
   默认上游参考实现值得学，除非说清为什么我们的更适合三进程 GUI 形态。
   总表见 §1.5，逐行销账。

## 1. 借鉴总清单（全景，含状态追踪）

上游路径均相对 `reference/pi/packages/coding-agent/src/`。

| 域 | 上游素材（行数） | 价值与去向 | 批次 | 状态 |
| --- | --- | --- | --- | --- |
| 并发写防护 | `core/tools/file-mutation-queue.ts` | pi 并行执行同批工具 → 写文件竞态串行化；**回补批次 2 write 的真实缺口** | 3 | **✅ 3.2 完成**（write 已入队；edit 3.3 同队；冒烟 tools-smoke 11/11a/12） |
| 输出护栏 | `core/tools/truncate.ts`(302) + `output-accumulator.ts`(257) + `utils/output-files.ts`（注：立项时写的 output-guard.ts 上游不存在，实际三件 = 这三个） | 截断/流式累积三件套，批次 1 read/grep 简单上限的加强版 | 3 | **✅ 3.1 完成**（read/grep/glob 已迁移统一截断器；accumulator 待 3.4 bash 首用） |
| 批次 1 工具加固 | `core/tools/read.ts`(365) / `grep.ts`(337) / `find.ts`(359) / `ls.ts`(175) | 既有 read/glob/grep 对照上游补差距：offset/limit 翻页、.gitignore 尊重、grep 参数、ls 可选；图片读取依赖空位 1 挂起 | 3（步骤 3.6） | **✅ 3.6 完成**（gitignore 层叠+嵌套仓边界 / grep context / ls / 文件级搜索存量 bug 修复 / ~ 展开吸收） |
| edit 工具 | `core/tools/edit.ts`(221) + `edit-diff.ts`(745) | old/new 串替换 + diff 算法（CRLF↔LF 偏移映射对 Windows 关键），工具计划批次 3 本体 | 3 | **✅ 3.3 完成**（D4 diff 进协议双路径；CRLF 映射冒烟验证） |
| bash 工具 | `core/tools/bash.ts`(476) + `powershell.ts` + `core/bash-executor.ts` + `utils/shell.ts`(杀进程树/detached 跟踪) + `utils/child-process.ts` | shell 执行全家；Windows 有官方 PowerShell 答案 | 3 | **✅ 3.4/3.5 完成**（D2 单工具 PowerShell 路由 / killProcessTree+引擎退出清场 / tool.progress 流式 / 超时杀树 / abort 心跳法无孤儿 / 自主模式第四档 D6） |
| 上下文压缩 | `core/compaction/compaction.ts`(1104 纯函数) + `utils.ts`(164) | 阈值触发摘要压缩 + 会话重建；上下文指示器"预警线"一直等它 | 4 | **✅ 4.1/4.2 完成**（2026-11-12；D7 双路：submit 前阈值 90% + session.compact 手动；compactionSummary 转录角色 + convertToLlm；切点线性改造只取 user 边界；冒烟 8 项全过；笔记 技术笔记/上下文压缩.md） |
| 技能 | `core/skills.ts`(505) + `resource-loader.ts` + `source-info.ts` | SKILL.md 发现（frontmatter 规范 / .gitignore 尊重 / 全局+项目双层）、系统提示词技能段 | 5 | 未开始 |
| 斜杠命令 | `core/slash-commands.ts`(44) + `core/prompt-templates.ts`(341) | 自定义命令模板（$ARGUMENTS 类）；Cogent 输入框 "/" 菜单 | 5 | 未开始 |
| MCP | `extensions/mcp/`(~3900) + `core/mcp-servers.ts` | stdio client / 配置 / 工具投影 / resources；上下文明细"MCP 段"空位 | 6 | 未开始 |
| 用量累计 | `core/usage-totals.ts`(99) | 会话/全局 token 累计视图 | 7 | 未开始 |
| 嵌套工具对照 | `core/nested-tool-calls.ts`(263) | 我们已走 runToolCall 保审批；对照 parentToolCallId 呈现与 usage 记账补差距 | 7 | 未开始 |
| 系统提示词对照 | `core/system-prompt.ts`(228) | 上游装配 vs 我们的 工作区注入+AGENTS.md+工具段，找漏 | 7 | 未开始 |
| 信任对照 | `core/project-trust.ts`(97) + `trust-manager.ts` | 我们已有多目录+信任确认，对照官方口径 | 7 | 未开始 |
| 会话导出 | `core/session-export.ts`(45) + `export-html/` | 单文件 HTML 回看，挂会话"更多"菜单 | 7 | 未开始 |
| 缓存统计 | `core/cache-stats.ts` + `cache-warmer.ts` | 提示缓存命中统计（预热器不搬，GUI 场景待议） | 7 可选 | 未开始 |
| 引擎 steering | `reference/pi/packages/agent/src/`（agent.ts / agent-loop.ts，**引擎包本体非 coding-agent**） | run 中消息排队（steering），Cogent 输入框 run 中可发（归并自工具计划 §6） | 7 | 未开始 |

## 1.5 存量对照总表（已实现模块全量过堂，逐行销账）

> 偷法第 5 则的落地表。"处置"列是**初判**，对照完回填终判；"状态"列：
> 未对照 / 免对照（理由） / 已销账（结论一句话）。

| Cogent 存量 | 上游对应 | 处置（初判） | 状态 |
| --- | --- | --- | --- |
| tools/read·glob·grep | `read.ts`(365) / `find.ts`(359) / `grep.ts`(337) | §3.1 截断器迁移 + §3.6 加固（翻页 / gitignore / 参数） | 已销账（2026-11-11 批次 3）：截断迁移 + gitignore/context/ls 加工全落；文件级搜索存量 bug 顺带修复；终判=吸收改造（截断器/gitignore 照搬，read 行号输出与翻页语义保留自有实现——cat -n 先验强于上游裸文本） |
| tools/write | `write.ts` + `file-mutation-queue.ts` | §3.2 并发队列回补；write 本体在 §3.3 顺手对照（details / structuredContent 取舍） | 已销账（2026-11-11）：队列照搬；本体对照终判=我们更好（成功结果一行中文摘要 + details 带字节数，上游同款思路；errorResult 直接返回优于 throw-再包装） |
| tools/path.ts 双口径 | `path-utils.ts` | §3.6 顺手对照（解析与限界口径差异） | 已销账（2026-11-11）：~ 展开吸收；macOS 文件名变体（NFD/智能引号）不搬（非目标平台）；写类软限界是我们独有的产品语义，终判=我们更好 |
| runtime/session.ts 会话编排 | `agent-session.ts` + `agent-session-runtime.ts` + `sdk.ts` | 批次 8.1：生命周期 / 惰性重建 / 事件出口 / 双投影 | 未对照 |
| storage/（JsonStorageDriver） | `session-manager.ts` | 批次 8.2：格式（整写 vs 追加）/ 原子写 / 损坏恢复；树状结构留远期池 | 未对照 |
| credentials/store.ts | `auth-storage.ts` + `runtime-credentials.ts` | 批次 8.3：初判我们更安全（safeStorage 加密 vs 上游明文 auth.json），对照后写理由销账 | 未对照 |
| runtime/custom-providers.ts | `provider-composer.ts` / `provider-matching.ts` / `http-dispatcher.ts` | 批次 8.4：重试 / 超时 / 故障转移是否被 pi-ai 层覆盖待核（我们包装层未显式接） | 未对照 |
| 模型目录快照 | `model-registry.ts` / `models-store.ts` / `remote-catalog-provider.ts` | 目录远程刷新在远期池；批次 8 顺带对照目录合并口径 | 未对照 |
| 工作区注入 + 系统提示词 | `system-prompt.ts`(228) | §7 件 3 ✓ | 未对照 |
| project.ts / 信任确认 | `project-trust.ts` / `trust-manager.ts` / `session-cwd.ts` | §7 件 4 ✓ | 未对照 |
| 审批矩阵 / approvals.ts | 上游 main **无**（`approvals` 分支开发中） | 初判我们领先；上游分支合入后补一轮对照找减法（远期池挂账） | 未对照 |
| inspect 域 / 运行时控制台 | 上游无对应（telemetry 不偷） | 独有能力，免对照 | 免对照 |
| 协议事件 / translateEvent | `event-bus.ts` + `modes/json-event.ts` | 批次 8.5：事件粒度与命名，有没有上游有而我们丢的信息 | 未对照 |
| usage / estimate 口径 | `usage-totals.ts` / `cache-stats.ts` | §7 件 1/6 ✓；estimate 同源已核实（token-usage §6.1） | 部分完成 |
| 回合呈现 / Markdown / Reasoning | 上游 TUI renderers 与 export-html（形态不对应） | 免对照：单进程直渲染无法跨形态搬 | 免对照 |

## 2. 待拍板决策速览（随批次推进逐个定，定完回填）

> **2026-11-11 定稿**：用户授权"决策全按你倾向的来，不用让我审批了"——
> 下表全部按倾向列定稿，后续按此执行不再逐项请示；实现中若发现倾向需要
> 修正，在对应批次记录原因后自行改判并回填本表。

| # | 决策 | 定稿 | 状态 |
| --- | --- | --- | --- |
| D1 | 工具是否跟随上游 Operations 注入模式（fs/shell 操作作接口传入） | 跟（照搬成本低、冒烟可 mock） | ✅ 定稿 |
| D2 | Windows 上 bash 形态：双工具（bash+powershell 照上游） vs 单工具按平台路由 | 单工具路由（GUI 产品模型侧一个名字更简） | ✅ 定稿 |
| D3 | bash 审批粒度：kind 级（同 write） vs 命令前缀规则（Claude Code 风） | 批次 3 先 kind 级，前缀规则留升级 | ✅ 定稿 |
| D4 | edit diff 是否进协议给 UI（工具卡显示 diff） | 进（ToolCallRecord 加 optional diff 摘要，additive） | ✅ 定稿 |
| D5 | bash 流式输出呈现：协议加 tool.progress 事件 vs 收尾一次性 | 加 tool.progress（OutputAccumulator 节流已就位） | ✅ 定稿 |
| D6 | 「自主模式」解灰时机：bash 落地即开 vs 等 network 工具 | bash 落地即开（占位文案写明 exec only） | ✅ 定稿 |
| D7 | 压缩触发：自动阈值+手动双路？阈值默认值？自动开关可关？ | 双路；阈值 90%；自动默认开 | ✅ 定稿 |
| D8 | 技能/命令目录名与格式：`.cogent/`（兼容 SKILL.md 规范） | .cogent/skills 双层（全局+项目），格式照 Anthropic/pi 规范 | ✅ 定稿 |
| D9 | MCP 配置位置与工具审批定级 | .cogent/mcp.json 双层；MCP 工具 kind='mcp' 默认 ask | ✅ 定稿 |
| D10 | network 工具审批准则 | kind 'network' 默认 ask；域名白名单规则留升级 | ✅ 定稿 |

## 3. 批次 3：工具终章（edit / bash，= 工具计划明示另计划的批次 3）

上游工具全套 ~4000 行，不一步到位。顺序：**先地基后工具，edit 先于 bash**
（edit 与批次 2 write 同属文件写、审批语义现成；bash 牵扯进程管理面更大）。

- **步骤 3.1 输出护栏基建** ✅（2026-11-11）：搬 truncate 三件套（`tools/truncate.ts` +
  `tools/output-accumulator.ts` + `tools/output-files.ts` 等位落 `agent-service/tools/`），
  read/grep/glob 上限迁移到统一截断器（行为只加强：read 字节口径 64KB 与旧字符上限同数值、
  grep 单行 300→500 对齐上游常量 + 总量 30KB 新封顶、glob 总量 30KB 新封顶）。
  tools-smoke 原 12 项被 /tmp 清理，按文档口径重建于 `tmp/cogent-smoke/tools-smoke.mjs`
  并扩到 17 项（截断三态 + 显式 limit 走截断器分支 + 长行标注），全过。
- **步骤 3.2 并发写队列** ✅（2026-11-11）：搬 `withFileMutationQueue`（等位
  `tools/file-mutation-queue.ts`），write 落盘段（mkdir+writeFile 整段）入队——
  同批并行 4 写冒烟验证：同文件串行内容不交错、不同文件不互斥。接线点取上游
  口径（工具工厂内部包裹），buildTools 注册表不感知。
- **步骤 3.3 edit 工具** ✅（2026-11-11）：搬 edit.ts + edit-diff.ts（`diff` 包 + CRLF 偏移映射
  原样保留——我们是 Windows 项目，这是宝藏代码）；kind `'edit'`，审批矩阵同
  write（ask 询问 / auto 放行 / plan block）；TOOL_METAS + 系统提示词工具段更新；
  D4 若定"进协议"则 ToolCallRecord.diff 摘要落地。验收：精确替换 / 多处匹配
  报错 / 旧串不存在 / CRLF 文件编辑 / 越界拦截 / 历史回查带 diff 冒烟。
- **步骤 3.4 bash 工具** ✅（2026-11-11）：搬 bash.ts + utils/shell.ts（killProcessTree /
  detached 子进程跟踪——**Electron 孤儿进程教训在引擎侧同样成立，杀不净
  bash 子进程就是重演**）；D2 定形态后落 `tools/bash.ts`；timeout 参数 +
  输出走 3.1 截断器；AbortSignal → 杀进程树（接既有 abort 语义）；kind
  `'bash'`，D3 定审批粒度。验收：echo 往返 / 超时击杀 / 输出截断 / abort
  杀树无孤儿（Get-Process 断言）/ 越界（cwd 限制策略随 D2/D3 定）冒烟。
- **步骤 3.5 UI 与权限收尾** ✅（2026-11-11）：工具卡 bash 流式（D5）/ edit diff 呈现（D4）；
  PermissionMenu「自主模式」解灰（D6）；ApprovalPanel 选项文案覆盖新 kind。
  验收：用户人工验收 + 三关全绿。
- **步骤 3.6 批次 1 工具对照加固** ✅（2026-11-11）（不依赖 3.3/3.4，可与 3.1 同期插队）：对照
  上游 read/grep/find 核出的真实差距——① read 加 `offset`/`limit` 参数
  （1-indexed 行起点 + 行数，大文件翻页）；② walk.ts 尊重 .gitignore/.ignore
  （上游走 fd 外部命令，我们用 `ignore` 包在自研遍历器上应用规则，不引外部
  依赖；嵌套 repo 边界照上游口径停在子仓）；③ grep 加 `ignoreCase` /
  `context`（上下文行）/ 长行截断；④ ls 工具可选补上（glob 已覆盖大半，
  目录速览场景）；⑤ read 图片读取（PNG/JPEG → image 块 + 按模型 input 能力
  降级）**依赖路线空位 1（content blocks），挂起不做**——引擎转录天然能存，
  投影与 UI 等空位 1 后接。验收：tools-smoke 扩断言（gitignore 命中 / 翻页 /
  上下文行）+ 既有 12 项不回归。
- **笔记** ✅：`技术笔记/bash与edit工具与输出护栏.md`（对比：Claude Code 的 background
  shell / BashOutput、Codex 沙箱内执行、上游 TUI 流式渲染 vs 我们的协议投影）。

## 4. 批次 4：上下文压缩

> **完备化加码（2026-11-12 立项）**：UI 验收实测发现「小窗输出预算饿死」
> 死锁（20K 窗 + 推理模型，67% 即被思考吃光 room，到不了 90% 触发线）。
> 五家调研与决策定稿见 [方案-上下文压缩.md](方案-上下文压缩.md)，
> **执行计划见 [上下文压缩完备化.md](上下文压缩完备化.md)**
> （十维路线选择 + S1–S8 步骤 + 冒烟扩至 22 项；用户定调：一步到位
> 不设远期、以 pi 与 DeepSeek-Harness 源码为主要参照，dsh 源码已浅克隆
> reference/deepseek-harness）。**批次 4 已完结（2026-11-12）**：4.1/4.2
> 引擎与 UI + 4.3 完备化 S1–S8 全部落地。**

- **步骤 4.1 引擎压缩本体** ✅（2026-11-12）：搬 compaction 纯函数，按线性转录
  改造（详尽取舍见 技术笔记/上下文压缩.md §4）——压缩记录 = 转录内
  `compactionSummary` 自定义消息角色（pi 声明合并通道 + Agent `convertToLlm`
  选项转 user 消息），system 消息全保留前置（权限通告在转录里，不能随摘要丢）；
  切点只取 user 边界（回合原子，砍上游 split-turn 二次摘要）；文件表靠摘要文本
  自身跨代合并（UPDATE 提示词 PRESERVE 规则）；submit 前单点触发（自动失败不拦
  提交的尽力语义）+ `session.compact` 手动路（忙/无可压缩 → InvalidRequest）；
  `compacting` 集合护栏堵 pi 在 prompt 前不置 isStreaming 的并发窗口。
  事件 `compaction.started/completed`（completed 带 summary/前后 token/
  summarizedUntil 锚/失败 error，additive）。验收：compaction-smoke 8 项全过
  （阈值触发 / 前后 token / 请求体不携带已摘要原文 / 摘要+保留区+新问进请求 /
  重启复原 / 手动双态 / 迭代 previous-summary）。
- **步骤 4.2 UI 联动** ✅（2026-11-12）：上下文指示器预警线接上（90% 刻度 +
  越线说明行 + 压缩回落：压缩条新于末条 usage → 分子切 tokensAfter 估算带 ≈）
  + 消息流「已压缩」折叠条（TraceCollapsible 家族，独立行快路不套「已工作」
  头条）；completed 事件做本地列表手术（summarizedUntil 之前原位换折叠条，
  不重拉历史——与 prompt() 追加用户消息有竞态）。验收：用户人工验收。
- **笔记** ✅：`技术笔记/上下文压缩.md`（对比：Claude Code auto-compact 与
  /compact、Codex 自动压缩、DeepAgent summarization、上游"压缩后会话 reload"
  语义；不搬清单：overflow 恢复 / retryAssistantCall（批次 8.4 挂账）/
  branch-summarization）。
- **步骤 4.3 完备化 S1–S8** ✅（2026-11-12，批次 4 完结）：S1 = `max(ctx×50%, min(ctx×90%,
  ctx−ROOM_FLOOR(8192)))` 触发公式 + ModelDef.compaction 按模型覆盖（声明合并
  通道挂 Model）+ 有效阈值随目录下发（指示器预警线跟随）；S2 =
  `prepareNextTurnWithContext` 工具轮间检查点（pi 原生钩子，压缩后返回新
  context 对齐 loop 工作副本）+ R6② 核实（pi 原生 fail length 停因的
  toolCall，参数完整也 fail）；S3 = L1 prune（dsh 数值与算法同款：全转录
  8192 线 / 保头 4096 / 保尾 1024 / 单 marker，compaction.pruned 事件）+
  检查点 L1→重计量→L2 链（L1 单独够时零摘要请求）；S4 = 摘要指令内联（R4：会话
  system+被摘要区原消息+指令 user 真前缀构造，KV cache 复用；投影前导语换 dsh
  CHECKPOINT_PREAMBLE 措辞）；S5 = 溢出恢复（R5：isContextOverflow 判定 →
  删失败轮 → L1/L2 → agent.continue 重试一次,单次闸;可恢复失败在 agent_end
  抑制 run.failed、streaming 保活,UI 全程一个 run）；S6 = auto-continue
  （R6③:length 截断注入 [cogent:continue] 显式指令再跑,上限 3 次,单 run 语义
  + 段合并投影 + session.continue 手动路 + 截断动作条「继续生成/立即压缩」）；S7 = compat
  通道（R7 评审修正落点:provider 级 compat + 模型级 thinkingBudgets,buildModel
  挂 Model.compat/thinkingBudgets,session 同步 Agent.thinkingBudgets;设置 UI
  两处高级折叠:provider 详情「端点兼容」预算字段名选择 + 模型弹窗压缩参数/
  档位预算）；S8 = UI 三件补齐（压缩中状态条 compactingBySession + 指示器
  手动压缩入口 + prune 副行 PrunedBar）+ R10 图片卸载事件形状预留（协议注释
  声明 compaction.offloaded 约定）。**完备化计划就此归档**（否决项继续有效）。评审修正四件（R1 特小窗
  公式表述/R3 L1 全转录范围/R7 compat 落 Model 非 createProvider/S1·S7 UI
  归属）已并入完备化计划。冒烟 22/22 + tools-smoke 39/39 + approval 18/18 回归，三关绿。**批次 4 全部完结**。
  见 [上下文压缩完备化.md](上下文压缩完备化.md) 执行日志。
- **注**：上游 `branch-summarization.ts`（会话树导航用）不随本批搬——我们转录
  是线性的，树结构属远期池。

## 5. 批次 5：技能 + 斜杠命令 + 提示词模板

- **步骤 5.1 技能发现**：搬 skills.ts 主干（SKILL.md frontmatter 规范 /
  .gitignore·.ignore 尊重 / 全局+项目双层发现）；目录 `.cogent/skills/`（D8）；
  系统提示词技能段（上游=清单进 system prompt，禁 model 触发的排除——实现时
  核对 progressive disclosure 细节）。验收：放两个技能文件 → 系统提示词含清单
  （mock 请求体断言）→ 上下文明细"技能"段出现（token-usage §6.1 空位补齐）。
- **步骤 5.2 斜杠命令**：输入框 "/" 前缀弹菜单：内置（/compact /clear /help）
  + 项目 `.cogent/commands/*.md` 自定义（$ARGUMENTS 占位，搬 prompt-templates）；
  协议 `chat.command` 通道或纯 renderer 短路（内置命令）+ 引擎命令（/compact）
  分流，实现时定。验收：用户人工验收 + 命令展开进消息流断言。
- **步骤 5.3 设置页**：集成组"技能/命令"分区（列表 + 打开目录 + 启停）。
- **笔记**：`技术笔记/skills-commands.md`（对比：Anthropic skills 规范 / pi
  双层发现 / ZCode 技能加载 / Claude Code commands）。

## 6. 批次 6：MCP

上游 ~3900 行且是 Extension 形态，我们没有扩展系统——**直接做 core MCP
manager，不走扩展抽象**（扩展系统属远期池，届时 MCP 可迁移）。

- **步骤 6.1 配置与连接**：`.cogent/mcp.json` 双层（D9）+ stdio client 连接
  管理（启停/健康/诊断落 inspect 域）。验收：配置真 server（如 filesystem
  参考服）→ models.list 侧的 `mcp.status` 可查。
- **步骤 6.2 工具投影**：`mcp__server__tool` 命名进 CogentTool，kind `'mcp'`
  （D9 定级），审批走既有矩阵；上下文明细"MCP 段"补齐。验收：模型经 MCP 工具
  读到文件（工具循环往返冒烟）+ 审批卡正常挂起裁决。
- **步骤 6.3 设置页**：集成组"MCP 服务器"分区（增删改 + 状态点 + 工具清单）。
- **步骤 6.4（可选后置）**：resources / prompts / oauth / tool-search（工具
  太多时动态检索——上游 `extensions/tool-search`，等真有几十个 MCP 工具再做）。
- **笔记**：`技术笔记/mcp.md`（对比：上游 Extension 形态 vs 我们 core manager
  的取舍、Claude Code .mcp.json、ZCode MCP 配置体系）。

## 7. 批次 7：小件杂烩（每件一小步，可随时插队）

每件一小步，可随时插队；**件 1–6 为 pi 借鉴小件，件 7–10 为两份旧计划归并的
遗留件**。每件 = 搬运/对照/自建 + 一段笔记（可并入相关既有笔记的追加节，不强制新文件）：

1. **usage-totals**：会话内/全局累计统计，挂会话信息或设置页；
2. **nested-tool-calls 对照**：核对 parentToolCallId 呈现与嵌套 usage 记账差距；
3. **system-prompt 对照**：上游环境块/git 注入内容 vs 我们工作区注入，找漏项；
4. **project-trust / trust-manager 对照**：找官方口径差距；
5. **export-html**：会话导出单文件 HTML（与运行时控制台落盘互补）；
6. **cache-stats（可选）**：提示缓存命中率统计（ContextIndicator 悬浮卡已有
   平均值，升级为分会话统计）；
7. **回合批次 B 收尾**（归并自 回合过程折叠.md）：协议
   `ChatMessage.thinkingMs?`（只增 optional）+ 引擎测每轮思考跨度（首个
   thinking delta → 首 text delta / 工具封段，历史回查同源）+ Reasoning 头条
   带时长（"深度思考 Xs"）+ 工具卡文案对齐 + UI布局.md 配方沉淀；
8. **network 工具**（归并自 工具系统与审批.md §6"第三批"）：Cogent 自建
   fetch（上游 coding-agent 无网络工具可搬），落 `tools/fetch.ts` + kind
   `'network'`（D10）；落地后「自主模式」占位文案去掉 exec only；
9. **会话级「本次会话总是允许」**（归并自工具计划 §6"第二批再议"）：
   ApprovalPanel 选项扩一档 —— 会话内存 allowlist（kind 粒度、不落盘），
   与既有工作区级规则（落盘）语义分层：会话内 > 工作区 > 每次问；
10. **steering 接线**（归并自工具计划 §6；能力在 pi-agent-core 本体）：run 中
    输入框可发 → 引擎排队消息（上游 agent-loop 的 queue 机制）→ 转录注入
    时序核对 + UI「已排队」呈现。

## 8. 批次 8：存量对照审计（§1.5 未分配行的销账，可随时插队）

> 立场（用户定调 2026-11-11）：**实现归实现，好归好**——已上线模块默认不是
> 免检金牌，逐个与上游对应物过堂，结论写回 §1.5 状态列。

- **8.1 会话编排对照**：runtime/session.ts vs `agent-session.ts` /
  `agent-session-runtime.ts` / `sdk.ts` —— 生命周期 / 惰性重建 / 事件出口 /
  双投影，吸收改造或写明我们更好的理由；
- **8.2 存储对照**：JsonStorageDriver vs `session-manager.ts` —— 格式（回合
  整写 vs 上游格式）/ 原子写 / 损坏恢复；树状结构维持远期池不动；
- **8.3 凭据对照**：credentials/store vs `auth-storage.ts` —— 初判我们更安全
  （safeStorage 加密 vs 上游明文 auth.json），对照后写明理由销账；
- **8.4 provider 网络层对照**：custom-providers vs `provider-composer.ts` /
  `http-dispatcher.ts` —— **重点核重试 / 超时 / 故障转移**：pi-ai 层有
  RetryPolicy 而我们包装层未显式接，确认是否已覆盖、缺则补；
- **8.5 事件协议对照**：translateEvent / 协议事件表 vs `event-bus.ts` +
  `modes/json-event.ts` —— 事件粒度与命名，找"上游有而我们丢"的信息；
- 每件产出 = §1.5 行销账（终判一句话）+ 相关技术笔记追加节（不强制新文件）。

## 9. 远期池（明确不现在做，防摊大饼）

| 项 | 上游参照 | 为什么值得 / 为什么缓 |
| --- | --- | --- |
| 扩展系统架构 | `core/extensions/` + `extensions/index.ts`(InlineExtension/replaceable) | 侧栏"插件"路由占位兑现时立项；先在 MCP/skills 批吸收模式 |
| 会话树回溯 + 分支摘要 | `session-manager.ts`（树存储）+ `compaction/branch-summarization.ts`(398) | 值得（回溯改一条消息开分支），但存储结构改树是大工程 |
| rpc 无头模式 | `modes/rpc/`(~1800) | 与外部引擎集成构想（SessionRunner 抽象）合并立项 |
| 模型目录远程刷新 | `core/remote-catalog-provider.ts` | 解 pi 目录快照滞后痛点（DeepSeek 只收录 2 个），依赖上游 catalog 服务可用性 |
| codemode | `extensions/codemode/` | 官方实验件，观察 |
| 上游 approvals 分支对照 | git 分支 `approvals`（未合入 main） | 我们审批领先；分支合入后对照一轮，学官方怎么做减法（§1.5 挂账） |
| 子代理（Task/agent 工具） | 上游无参照（Cogent 自建方向） | 归并自工具计划 §6；量大，等工具/MCP 齐后再立项 |
| 消息级 hover 工具栏 | ZCode 形态（复制/点赞） | 归并自回合计划 §5"后续件" |

**已封印（永不做 / 明示不做，防翻烧饼；来源 = 两份归档计划的"明示不做"节）**：
OS 级硬沙箱（边界永远软——工具计划前计划 D6）、批次间消息时间线可视化、
过程项折叠态持久化、ChatGPT 式"思考原文不留"（我们保留——数据已到客户端）。

## 10. 不偷清单（有理由的放弃）

| 类 | 上游 | 理由 |
| --- | --- | --- |
| TUI 全家 | `modes/interactive/`、`themes/`、`keybindings*`、`footer-*` | 形态完全不同，React 侧无对应物 |
| 运维件 | `telemetry.ts`、`bug-report*`、`crash-log.ts`、`client-identity.ts` | 产品化遥测，学习项目不需要 |
| 认证体系 | `auth-storage.ts`、`runtime-credentials.ts`、`auth-guidance.ts` | 我们有 safeStorage 凭据体系且已稳定 |
| Radius 网关 | `radius*.ts` | 官方托管网关产品件，非通用能力 |
| llama.cpp | `extensions/llama/` | 本地模型接入走自定义 provider 路线 |
| 设置域大改 | `settings-*.ts` | 设置域刚稳定，对照即可不重构 |

## 11. 产出义务（每批完成时）

- 技术笔记一篇（§0 第 3 则）+ 对应模块事实页同步；
- 新场景入库 tests/integration；协议改动 additive（PROTOCOL_VERSION 不动，见 约定.md）；
- 本文档状态列回填 + 决策表回填（用户拍板后写死，防翻烧饼）。
