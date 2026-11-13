# 技术笔记 — Cogent

> 学习项目的核心产出：每实现一个技术模块，在**本目录**写一篇笔记 ——
> 该领域的原理（pi 怎么做的）+ **与 DeepAgent 及其他主流 Agent 同主题实现的对比**。
> 没写笔记 = 该模块没完成（见 AGENTS.md「项目性质与工作方式」）。

## 文件组织

- **一个技术模块一个文件**，目录即分类，不放代码（代码落点写在笔记里）;
- 文件名用模块的英文 kebab-case（`tool-execution.md`），标题用中文（既有中文
  文件名先例 测试体系.md 保持不动，不强改）;
- 单文件超过 ~150 行就拆子模块（如 `tool-execution.md` 拆出 `approval.md`），
  子模块文件名用 `主题-子题.md`；
- 图片/图示放 `assets/` 子目录，按模块加前缀（`assets/tools-flow.svg`）。

## 笔记骨架（每篇必须遵守，保证横向可比）

1. **问题**：这个模块解决什么问题，为什么 Agent 引擎绕不开它；
2. **pi 的做法**：源码层面怎么实现（优先引 `reference/pi/` 源码克隆的文件与
   行号，包产物 `node_modules/@earendil-works/*/dist` 为辅）；
3. **对比**：DeepAgent 同主题怎么做的（引代码/回忆均可，注明来源）、其他主流 Agent
   （Claude Code、OpenAI Agents SDK、LangGraph 等，按模块挑相关的）；
4. **取舍**：各自设计选择的代价，Cogent 采用了哪种、为什么；
5. **在 Cogent 的落点**：对应哪些文件，与协议/审批/存储怎么衔接。

## 写作纪律

- 对比要有具体出处（文件、类名、行为描述），不接受"DeepAgent 也支持"这种空话；
- pi 的行为以源码为准（对照克隆 reference/pi/，锚点 74dcca7d，补拉配方见 ../架构.md），
  发现与 README 不符处注明。

## 已有笔记

| 笔记 | 对应路线项 | 状态 |
| --- | --- | --- |
| [pi Agent 接入与会话管理](pi接入与会话管理.md) | 路线 2（SessionManager + pi Agent） | 已完成（2026-11-06） |
| [凭据存储与模型目录](凭据存储与模型目录.md) | 路线 5（safeStorage 凭据存取） | 已完成（2026-11-06） |
| [自定义 Provider 与模型目录管理](自定义Provider与模型目录.md) | 模型设置扩展（createProvider/setProvider 机制） | 已完成（2026-11-06） |
| [思考（Reasoning）流式呈现](思考流式呈现.md) | 路线空位 4（thinking 半边） | 已完成（2026-11-08） |
| [会话隔离与受理语义](会话隔离与受理语义.md) | 串话事故复盘（新聊天接线 + submit 受理校验） | 已完成（2026-11-09） |
| [会话存储与转录持久化](会话存储与转录持久化.md) | 路线空位 3（StorageDriver + 双层存储：pi 树 JSONL 转录真源 + Cogent 会话域 summary，惰性装配） | 已完成（1.2a 起双层） |
| [项目/工作区模型与存储根](项目工作区模型与存储根.md) | 计划第 2–6 步（~/.cogent 根 + 项目域 + 工作区注入） | 已完成（2026-11-09） |
| [token 用量统计](token用量统计.md) | 路线空位 1 的 usage 先行（pi Usage 投影 + 消息级统计行） | 已完成（2026-11-09） |
| [运行时控制台](运行时控制台.md) | inspect 域（pi hooks 观测 + 独立 DevTools 窗口 + 实时时间线） | 已完成（2026-11-10） |
| [Markdown 渲染](Markdown渲染.md) | 路线空位 4 前半（Streamdown + Shiki + CJK 插件） | 已完成（2026-11-10） |
| [工具系统与审批](工具系统与审批.md) | 路线空位 2/4/6（工具循环 + beforeToolCall 审批挂起 + 权限矩阵，批次 1+2 全景） | 已完成（2026-11-11） |
| [bash / edit 工具与输出护栏](bash与edit工具与输出护栏.md) | pi借鉴 批次 3（截断三件套 + 并发写队列 + edit CRLF 映射 + bash 进程树 + 自主模式 + gitignore 加固） | 已完成（2026-11-11） |
| [上下文压缩](上下文压缩.md) | pi 内核接管（reserve 触发线 / 固定 keep / split-turn / 溢出恢复）+ Cogent 承接面（事件转译 / 预警线公式 / AUTO_CONTINUE） | 已完成（1.2a 起 pi 内核） |
| [测试体系](测试体系.md) | 计划/归档/测试体系.md（Vitest 三层 + 冒烟正名迁移 + CI；三家上游对照与迁移踩坑） | 已完成（2026-11-13） |
| [内置浏览器与聚合面板](内置浏览器与聚合面板.md) | 未立项调研（内置浏览器四层模型 / browser-use 插件与面板双面性 / ZCode + ChatGPT + dsh 三家对照，含引擎路线对照） | 调研完成（2026-11-12，无代码落点） |
| [自带 Node 运行时分发](node-runtime-distribution.md) | 全局架构阶段 0（fetch-runtime + SHA256 对官方清单 + 三级链定位；Pi-meme / zcode / dsh 对照与踩坑） | 已完成（2026-11-13） |
| [CogentKernel 合同](kernel-contract.md) | 全局架构 D4 / 阶段 1.1（南缝窄合同显式化：pi AgentSession 方法面对照 + Pi-meme/zcode/dsh 缝形态对比） | 已完成（2026-11-13） |
| [pi 内核替换](pi内核替换.md) | 全局架构 D6 / 阶段 1.2a（手搓 Agent 层让位 AgentSession：终态纪律 / split-turn 陷阱 / 呈现与上下文双口径 / 装配纪律） | 已完成 |
