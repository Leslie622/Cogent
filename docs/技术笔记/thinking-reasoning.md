# 思考（Reasoning）流式呈现

> 路线：空位 4 的 thinking 半边（thinking/toolcall UI 呈现）。完成于 2026-11-08。
> 落点：协议 additive 扩展 → 引擎转译 → renderer Reasoning 组件。

## 1. 问题

推理模型（DeepSeek-R 系、Claude extended thinking、o 系等）在正文之外产出"思考"。
引擎绕不开三件事：**怎么发**（请求侧把思考力度映射成各家方言参数）、**怎么收**
（响应侧把思考从流里分离出来）、**怎么呈现**（思考先于正文流出，UI 要"思考中
自动展开、正文来了收起、用户可重开"）。思考还是签名化的（Anthropic 加密签名
回传才能多轮连续），不是"多一段文本"那么简单。

## 2. pi 的做法

**类型层**（`pi-ai/dist/types.d.ts`）：

- `ThinkingContent`（:256）：`{ type: 'thinking', thinking, thinkingSignature?, redacted? }`
  —— 思考是 assistant 消息 content blocks 里与 text/toolCall 并列的一等块；
  `thinkingSignature` 存加密签名供多轮回传（Anthropic 方言），`redacted` 标记
  安全过滤改写（原文不可见，负载在签名里）。
- `AssistantMessageEvent`（:607）：`thinking_start/delta/end` 与 `text_*` 完全对称
  （`delta: string` + `contentIndex`），流层面思考与正文是两路。
- 思考力度：`ModelThinkingLevel`（`providers/model-schema.d.ts:80`）六档 +
  `getSupportedThinkingLevels` / `clampThinkingLevel`（`models.d.ts:271`）按模型
  收窄档位；`Model.thinkingLevelMap` 声明各档映射。

**方言归一**（`providers/compat-schema.js:157`）：请求侧按 provider 翻译——
anthropic 走 thinking budget、openai 系走 `reasoning_effort`、deepseek 走
`thinking.type`、qwen 走 `enable_thinking`……引擎只面对统一的 ThinkingLevel。

**响应侧**（`api/openai-completions.js:372-390`）：把 `reasoning_content`
（DeepSeek/llama.cpp）、`reasoning`、`reasoning_text` 三家字段名统一解析进
thinking 块 —— openai-completions 兼容端点的思考天然被收编。

**循环层**（`pi-agent-core/dist/agent-loop.js:295-310`）：`thinking_*` 流事件与
`text_*` 一样包成 `message_update`（带 `assistantMessageEvent`）吐给订阅者，
Agent 状态里 `thinkingLevel` 可全局可逐轮覆盖。

## 3. 对比

**DeepAgent（作者此前项目，回忆）**：思考是"事后补丁"——模型思考与正文混在
同一条渲染消息里，靠 `displayContent` 字段把思考从渲染数据里剥离（见
[pi Agent 接入](pi-agent-integration.md) §3）；事件名自造（`agent_delta` 等）、
无类型约束，思考与正文共用一路 delta，分流的活全压给前端猜。pi 是结构性的：
块联合类型 + 两路流事件，Cogent 在协议边界做投影即可。

**DeepSeek 官方 API**：`delta.reasoning_content` 与 `content` 分离（pi 直接消费
此形状）；官方 App 的"已深度思考（用时 N 秒）"折叠条是思考 UI 的事实标准。
**Anthropic Messages API**：thinking block + 签名回传（pi 的
`thinkingSignature`/`redacted` 与之一一对应）。**OpenAI Responses API**：reasoning
只给加密 blob + 摘要（不给原文）——pi 的 `TextSignatureV1.phase`
（commentary | final_answer，types.d.ts:250）为这类"交错思考"预留了承载。

**UI 层共识**（ChatGPT / Claude / DeepSeek App）：思考中自动展开 + 流光标题，
正文开始即收起，点击可重开且不再被状态抢走。shadcn AI Elements 的 Reasoning
pattern（open ?? running 语义）就是这个共识的组件化。

## 4. 取舍

- **pi**：思考=结构化块+判别联合+方言归一，代价是类型面大，收益是任何 provider
  的思考同形——Cogent 全盘继承（这是选 pi 的理由本身）。
- **Cogent 协议**：不搬 content blocks（协议保持最小形状），思考以 flat string
  挂 `ChatMessage.thinking?` + `message.delta` 加 `kind?`（缺省 text，老宿主
  零破坏，PROTOCOL_VERSION 不动）。代价：交错思考的 phase、签名透传暂不可见；
  归路线 1（content blocks 细化）继续 additive。
- **Cogent UI**：思考阶段判定用派生信号（流式占位 id + 正文为空）而非协议显式
  信号——代价是 commentary 交错的收起时机不精确；收益是零协议负担，等路线 1
  有块结构再换真信号。
- **shimmer 文字流光**：background-clip: text 的可见字形由渐变 stop 实色承担，
  不违反"文字实色"方针（见 globals.css 注释）。

## 5. 在 Cogent 的落点

| 层 | 文件 | 内容 |
| --- | --- | --- |
| 协议 | `src/protocol/types.ts` | `ChatMessage.thinking?`；`message.delta` 加 `kind?: 'text'\|'thinking'` |
| 引擎 | `src/agent-service/runtime/session.ts` | `StreamingState.thinking` 缓冲；`translateEvent` 转发 `thinking_delta`；`run.completed` 带思考全文；`toChatMessages` 拼 ThinkingContent 块（历史与流式结束态同源） |
| 壳类型 | `src/renderer/src/env.d.ts` | 协议镜像声明 |
| renderer | `stores/chat.ts` | delta 按 kind 分流累积进流式占位消息 |
| renderer | `components/ui/trace.tsx` + `collapsible.tsx` + `reasoning.tsx` | base-luma 原语 ×2 + Reasoning pattern 落地（open ?? running） |
| renderer | `features/home/HomeChat.tsx` | 助手消息挂 Reasoning（思考中=占位且正文未开始） |
| 样式 | `globals.css` | 补 `shimmer` / `shimmer-none` 工具类（base-luma 空引用，同 scroll-fade 先例） |

冒烟：本地 mock SSE 端点吐 `reasoning_content`（见 [开发.md](../开发.md) 冒烟节）
→ 引擎帧验证 `kind:"thinking"` 两拍 → `kind:"text"` 两拍 → `run.completed.message.thinking`
全齐 → `session.messages` 历史同带思考。
