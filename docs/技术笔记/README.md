# 技术笔记 — Cogent

> 学习项目的核心产出：每实现一个技术模块，在**本目录**写一篇笔记 ——
> 该领域的原理（pi 怎么做的）+ **与其他主流 Agent 同主题实现的对比**。
> 没写笔记 = 该模块没完成（见 AGENTS.md「项目性质与工作方式」）。

## 文件组织

- **一个技术模块一个文件**，目录即分类，不放代码（代码落点写在笔记里）;
- 文件名用模块的英文 kebab-case（`pi-agent-session.md`），标题用中文（既有
  中文文件名先例保持不动，不强改）;
- 单文件超过 ~150 行就拆子模块（如 `工具系统与审批.md` 拆出 `审批.md`），
  子模块文件名用 `主题-子题.md`；
- 图片/图示放 `assets/` 子目录，按模块加前缀（`assets/tools-flow.svg`）。

## 笔记骨架（每篇必须遵守，保证横向可比）

1. **问题**：这个模块解决什么问题，为什么 Agent 引擎绕不开它；
2. **pi 的做法**：源码层面怎么实现（优先引 `reference/pi/` 源码克隆的文件与
   行号，包产物 `node_modules/@earendil-works/*/dist` 为辅）；
3. **对比**：其他主流 Agent 同主题怎么做的（Claude Code、OpenAI Codex、
   LangGraph/DeepAgent、ChatGPT Agent 等，按模块挑相关的）；
4. **取舍**：各自设计选择的代价，Cogent 采用了哪种、为什么；
5. **在 Cogent 的落点**：对应哪些文件，与协议/审批/存储怎么衔接。

## 写作纪律

- 对比要有具体出处（文件、类名、行为描述），不接受"XX 也支持"这种空话；
- pi 的行为以源码为准（对照克隆 reference/pi/，锚点 74dcca7d，补拉配方见
  ../架构.md），发现与 README 不符处注明。

## 已有笔记

| 笔记 | 主题 |
| --- | --- |
| [pi 接入与会话管理](pi接入与会话管理.md) | SessionManager + pi 核心机制（Agent/事件/流） |
| [pi AgentSession 托管机制](pi-agent-session.md) | 全托管语义：prompt 生命周期/agent_settled 终态/压缩切点与 split-turn/双口径投影/装配纪律 |
| [CogentKernel 合同](kernel-contract.md) | 南缝窄合同显式化（D4）：pi AgentSession 方法面对照 + Pi-meme/zcode/dsh 缝形态对比 |
| [会话隔离与受理语义](会话隔离与受理语义.md) | submit 受理校验与新聊天接线（串话事故复盘） |
| [会话存储与转录持久化](会话存储与转录持久化.md) | StorageDriver + 双层存储（pi 树 JSONL 转录真源 + Cogent 会话域 summary） |
| [上下文压缩](上下文压缩.md) | pi 内核（reserve 触发线 / keep 窗 / split-turn / 溢出恢复）+ Cogent 承接面（事件转译 / 预警线 / AUTO_CONTINUE） |
| [工具系统与审批](工具系统与审批.md) | pi 内置工具消费面 + beforeToolCall 审批挂起 + 权限矩阵与规则表（四家对比）+ 部署事实 |
| [token 用量统计](token用量统计.md) | pi Usage 投影 + 消息级统计行 + 上下文估算与窗口指示器 |
| [思考（Reasoning）流式呈现](思考流式呈现.md) | thinking 半边（流式分流/档位/预算钳制） |
| [Markdown 渲染](Markdown渲染.md) | Streamdown + Shiki + CJK 插件 |
| [凭据存储与模型目录](凭据存储与模型目录.md) | safeStorage 凭据存取 + 模型目录 |
| [自定义 Provider 与模型目录管理](自定义Provider与模型目录.md) | createProvider/setProvider 机制与双注册 |
| [项目/工作区模型与存储根](项目工作区模型与存储根.md) | ~/.cogent 根 + 项目域 + 工作区注入 |
| [运行时控制台](运行时控制台.md) | inspect 域（pi hooks 观测 + 独立 DevTools 窗口 + 实时时间线） |
| [测试体系](测试体系.md) | Vitest 三层 + 冒烟 + CI；三家上游对照 |
| [内置浏览器与聚合面板](内置浏览器与聚合面板.md) | 调研（内置浏览器四层模型 / 插件与面板双面性 / 三家对照，无代码落点） |
| [自带 Node 运行时分发](node-runtime-distribution.md) | fetch-runtime + SHA256 对官方清单 + 三级链定位；Pi-meme / zcode / dsh 对照 |
| [HostApi HTTP 通道](hostapi-http.md) | 单一注册表多传输门（handleFrame 双门共用）+ 恒 200 语义分层 + loopback fail-closed；pi rpc / zcode server-core / Pi-meme 游标事件流 / im2.0 对照 |
| [webview 页面接入](hostapi-guest-page.md) | 凭证传递与 SDK 暴露面：一次性票据 + preload 内存 token + 直连 HTTP/WS；zcode lease+MessagePort / Pi-meme cookie / im2.0 教训对照 |
| [MCP 座](mcp-seat.md) | Host 管配置 + pi 管连接；实施期两坑（SDK 须自调 bindExtensions 才有 session_start / tools 显式列表过滤 direct MCP 工具）与 annotations 不可得验证 |
| [技能座](skill-seat.md) | Host 管目录 + 段钩子管注入 + read 即加载器；热刷新走 before_agent_start 段 diff（非 reload）、/skill: 展开搬家防脱节、同名优先级取舍 |
| [交互座](interact-seat.md) | customTools 注入 + 挂起/回填三次实例化（todo/ask_user/plan 闭环）；defineTool 保推断、白名单过滤、terminate 停轮位、before_agent_start 的 run 级语义、段双通道防失忆 |
| [对外 MCP](external-mcp.md) | agent-as-server 形态学：拓扑/凭据/审批/异步四题四家对比（Pi-meme 回执体系、dsh elicitation 生态实测、zcode 消费者画像）；annotations 是运行时审批数据源、「默认安全+放开显式」共识、事件不重放的订阅顺序 |
