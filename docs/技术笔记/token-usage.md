# 技术笔记 — token 用量统计

> 落点：`runtime/session.ts` 用量摘取/累加 + `protocol` `MessageUsage` /
> `ChatMessage` 三件套 + `HomeChat` `UsageLine`（2026-11-09，路线空位 1 的
> usage 先行）。

## 1. 要解决什么

"这段回答花了多少 token、多少钱、多快" 是 Agent 客户端的高频诉求：调试
提示词膨胀、对比模型成本、评估缓存命中率都要它。难点不在算术在**链路**：
usage 产生在引擎进程的流式回调里，要跨 stdio JSON-RPC、协议类型、store
一路到 UI 消息脚下，任何一环"顺手丢掉"就永不可见 —— Cogent 此前正是
`translateEvent` 只摘 `stopReason` 把整份 usage 扔了（数据其实早已随
transcript 落盘，见 §5）。

## 2. pi 的做法

**Usage 结构**（`pi-ai/dist/types.d.ts:285-313`）：

```
input / output / cacheRead / cacheWrite / cacheWrite1h?(仅 Anthropic) /
reasoning?(output 的子集) / totalTokens / cost{ input, output, cacheRead,
cacheWrite, total, totalFromProvider? }
```

三个值得学的语义决策：

- **input 不含缓存**：方言层就把缓存从输入里扣掉（openai-completions.js
  `parseChunkUsage`：`input = prompt_tokens − cached_tokens − cache_write_tokens`）。
  OpenAI 原生 `prompt_tokens` 是**含**缓存命中的，pi 归一后四路互斥、
  相加即 `totalTokens` —— 消费端不用再做减法。冒烟断言
  `1000 − 800 − 100 = 100` 验的就是这个口径；
- **方言归一收三家的缓存字段**：同一份 `cached_tokens`，OpenAI 放
  `prompt_tokens_details`、DeepSeek 用顶层 `prompt_cache_hit_tokens`、
  Kimi 文档写在末 chunk 顶层 `usage.cached_tokens`，pi 逐一探测
  （openai-completions.js:1160-1167 注释原文引了 OpenRouter PR 与 ds4 佐证）。
  cache_write 则是 OpenRouter 系扩展。host 一行代码不用管；
- **cost 双源**：`cost.total` 端点实报优先、目录估价兜底，
  `totalFromProvider` 标明出处 —— 目录没录价的模型 cost 全 0（诚实显示
  "无价"而不是估个假数）。

**携带路径**：`AssistantMessage.usage` 是必有字段（types.d.ts:388），
`durationMs` 可选（types.d.ts:399-405：单调钟、只对"看见开始"的流计时，
旧消息/延迟取回的结果没有）。Agent 循环把它放进 `turn_end.message` 与
`agent_end.messages`，每轮一份。

## 3. 对比

| 实现 | usage 归属 | 粒度 | 聚合 |
| --- | --- | --- | --- |
| **pi** | 消息属性（AssistantMessage 必带） | 每轮模型调用一份 | 宿主自己加总 |
| **DeepAgent / LangChain** | 消息属性：`AIMessage.usage_metadata`（`input_tokens/output_tokens/total_tokens` + `input_token_details.cache_read/cache_creation` + `output_token_details.reasoning`），另留 provider 原形状在 `response_metadata.token_usage` | 每轮一份 | 无内建聚合，展示层自己加总 |
| **Claude Code** | API 流 `message_delta` 携带 usage（Anthropic Messages 协议）；客户端侧按**会话**聚合，`/cost` 命令查总账 | 会话级为主 | 内建（会话累计） |
| **Codex CLI** | 会话结束打印 tokens 与估算成本 | 会话级汇总 | 内建 |
| **Cherry Studio / LobeChat** | 消息脚下常显 tokens/耗时 | 每条回答 | 无跨轮（单轮对话场景） |

DeepAgent 与 pi 同哲学：**usage 是消息的属性**，不是独立的遥测流 ——
transcript 保真则统计免费。Anthropic 协议族把 usage 放增量流而非消息对象，
Claude Code 收到手后仍落到会话账本上。差异主要在**聚合层次**：编码
CLI（Claude Code/Codex）倾向会话总账（用户关心"这个任务花了多少"），
聊天客户端倾向逐条标注（用户关心"这句花了多少"）。

## 4. 取舍

- **消息字段 vs 独立 usage 事件**：选前者（`ChatMessage.usage?` additive）。
  独立事件（如 `usage.reported`）要 UI 自己按 messageId 归位，流式占位替换
  的时序里多一个竞态窗口；挂在消息上则 `run.completed` 整体替换时自然带到，
  store 零改动。代价是流式过程中看不到实时计数 —— 本来也没有（usage 只在
  轮末到达）；
- **多轮累加（各轮之和）而非只看末轮**：工具循环每轮请求都携带全量上下文
  重发，端点账单就是逐轮相加，这是"本次回答共消耗"的**计费真相**；
  `input` 的逐轮重复不是 bug 是口径。当前 Cogent 无工具恒单轮，累加逻辑
  纯为空位 2 铺路；`sumOptional` 保持"没报告 ≠ 报告了 0"的缺省语义；
- **零值省略的展示规则**：缓存 0/无定价不显示对应项 —— 常显一排 0 是噪音
  （UI布局.md 对话流配方）；
- **与主流相反的诚实点**：cost 无价显示缺省而非估价 0 —— pi 的 `totalCost=0`
  原样投影，UI 端判 `> 0` 决定显隐。

## 4.1 定价继承（2026-11-09 用户实测引出的修复）

用户 DeepSeek 实测无成本项，落盘 usage `totalCost: 0` 与目录有价矛盾 ——
根因在 Cogent 自己的模型覆盖层：用户在模型设置里编辑过 `deepseek-flash`
（override.models 同 id 条目），而 `buildModel` 把 cost **硬编码 0** 且同 id
用户条目顶掉目录条目 → "编辑目录行"反而丢掉目录定价，成本统计静默归零。

修复 = merge 语义（`custom-providers.ts` `buildModel` 加目录基底参数）：
同 id 命中目录时以目录条目为基底，用户 ModelDef **显式设置的字段才覆盖**；
cost 一律不取自 def（协议 ModelDef 无此字段，用户不可配价）——有基底继承
目录定价，全新自定义模型保持 0（自定义端点计费对外不可知）。思考映射、
命名同理继承。对照冒烟：同 id 条目 $0.0004 级 / 全新 id 恒 0
（配方入 [../开发.md](../开发.md) 冒烟节）。

## 5. 在 Cogent 的落点

- **引擎** `runtime/session.ts`：`StreamingState` 补 usage/durationMs/model
  累加缓冲；`turn_end` 摘取（此处不摘即永久丢失 —— `agent_end` 只剩聚合态
  转录，协议事件不回头）；`agent_end` 投影进 `run.completed`；
  `toChatMessages` 历史回查同源投影；
- **协议** `MessageUsage`（手写投影形状，不 import pi —— 协议零运行时依赖）
  + `ChatMessage` 三件套 optional 字段，`PROTOCOL_VERSION` 不动（additive）；
- **存储红利**：会话存储 D5 决策（盘上存 pi 完整转录）在此兑现第一笔回报 ——
  usage 本就躺在 `~/.cogent/sessions/*.json` 的 transcript 里，读时投影补上
  即可，**无迁移、老会话也能显示**。当初若存投影格式，这里就得写数据迁移；
- **renderer**：`env.d.ts` 镜像 + `HomeChat` `UsageLine`（11px muted
  tabular-nums，`↑ 41 · ↓ 1.2K · 缓存读 8.2K · $0.0031 · 2.4s`，零值省略）；
- **冒烟**：mock SSE 末 chunk 带 OpenAI usage → 12 项断言（配方入
  [../开发.md](../开发.md) 冒烟节）。

**将来**（空位 1 content blocks 时一并考虑）：会话级聚合账本（对齐 Claude
Code `/cost`）、`reasoning` 细分展示、上下文余量（input+cacheRead 对
contextWindow 的占比水位）。
