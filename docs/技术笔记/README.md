# 技术笔记 — Cogent

> 学习项目的核心产出：每实现一个技术模块，在**本目录**写一篇笔记 ——
> 该领域的原理（pi 怎么做的）+ **与 DeepAgent 及其他主流 Agent 同主题实现的对比**。
> 没写笔记 = 该模块没完成（见 AGENTS.md「项目性质与工作方式」）。

## 文件组织

- **一个技术模块一个文件**，目录即分类，不放代码（代码落点写在笔记里）;
- 文件名用模块的英文 kebab-case（`tool-execution.md`），标题用中文;
- 单文件超过 ~150 行就拆子模块（如 `tool-execution.md` 拆出 `approval.md`），
  子模块文件名用 `主题-子题.md`；
- 图片/图示放 `assets/` 子目录，按模块加前缀（`assets/tools-flow.svg`）。

## 笔记骨架（每篇必须遵守，保证横向可比）

1. **问题**：这个模块解决什么问题，为什么 Agent 引擎绕不开它；
2. **pi 的做法**：源码层面怎么实现（引用 `node_modules/@earendil-works/*/dist` 的文件与行号）；
3. **对比**：DeepAgent 同主题怎么做的（引代码/回忆均可，注明来源）、其他主流 Agent
   （Claude Code、OpenAI Agents SDK、LangGraph 等，按模块挑相关的）；
4. **取舍**：各自设计选择的代价，Cogent 采用了哪种、为什么；
5. **在 Cogent 的落点**：对应哪些文件，与协议/审批/存储怎么衔接。

## 写作纪律

- 对比要有具体出处（文件、类名、行为描述），不接受"DeepAgent 也支持"这种空话；
- pi 的行为以源码为准（版本 1.5.0），发现与 README 不符处注明。

## 已有笔记

| 笔记 | 对应路线项 | 状态 |
| --- | --- | --- |
| [pi Agent 接入与会话管理](pi-agent-integration.md) | 路线 2（SessionManager + pi Agent） | 已完成（2026-11-06） |
| [凭据存储与模型目录](credential-storage.md) | 路线 5（safeStorage 凭据存取） | 已完成（2026-11-06） |
| [自定义 Provider 与模型目录管理](custom-providers.md) | 模型设置扩展（createProvider/setProvider 机制） | 已完成（2026-11-06） |
| [思考（Reasoning）流式呈现](thinking-reasoning.md) | 路线空位 4（thinking 半边） | 已完成（2026-11-08） |
| [会话隔离与受理语义](pi-agent-integration-isolation.md) | 串话事故复盘（新聊天接线 + submit 受理校验） | 已完成（2026-11-09） |
| [会话存储与转录持久化](session-storage.md) | 路线空位 3（StorageDriver + 本地 JSON + 惰性恢复） | 已完成（2026-11-09） |
| [项目/工作区模型与存储根](project-workspace.md) | 计划第 2–6 步（~/.cogent 根 + 项目域 + 工作区注入） | 已完成（2026-11-09） |
| [token 用量统计](token-usage.md) | 路线空位 1 的 usage 先行（pi Usage 投影 + 消息级统计行） | 已完成（2026-11-09） |
