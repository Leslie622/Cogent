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
（mock 手法见 tests/integration/harness.ts）。

## 4.2 估价 ≠ 账单：≈ 前缀（2026-11-10 用户对照 DeepSeek 官网定价引出）

pi 的成本有两级口径，`cost.totalFromProvider` 区分：**端点实报**
（OpenRouter 响应自带账单金额，`openrouter-cost.js` 覆盖 total）与
**目录估价**（其余一切直连厂商，`calculateCost` 按 USD/Mtok 单价 × token/1e6）。
估价的结构性偏差以 DeepSeek 为例（官网人民币定价 vs 目录 USD）：基准单价
= 官方**高峰价 ÷ 6.8** 的快照（1.32×6.8≈¥9 严丝合缝），但**分时计费未建模**
——官方空闲时段全线半价，晚上/周末跑目录估价**虚高一倍**；汇率漂移另算 ~5%。

落地：`MessageUsage.totalCostFromProvider?` 随链路透传（session.ts
`projectUsage` 归一为显式布尔——pi 里缺省与 false 同义，落盘形状稳定；
多轮累加取 AND——任何一轮是估价，总和只能是估价），UI `formatCost`
对估价加 `≈` 前缀。两个诚实细节：下限分支 `<$0.0001` 不加（`<` 本身
已传达不精确，再叠 ≈ 是双重标记）；旧会话数据无此字段，按估价处理
（本来也几乎全是估价）。

对照主流：Claude Code / Codex CLI 的成本显示同样不区分估价与账单
（Anthropic/OpenAI 计费本就 USD 报价，无此问题）；跨厂商统一 USD 估价
+ 显式 ≈ 标记，是直连混合厂商场景下的必要诚实。

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
  tests/integration/harness.ts 冒烟节）。

**将来**（空位 1 content blocks 时一并考虑）：会话级聚合账本（对齐 Claude
Code `/cost`）、`reasoning` 细分展示。

## 6. 上下文窗口指示器（2026-11-10）

输入卡工具行的细横条 + 百分比（两位小数：低占用时整数百分比信息量不足；
≥75% 转 warning、≥90% 转 destructive，变色只落 bar），点击弹悬浮卡：总量
（`70.0K/1.00M（6.25%）`）+ 进度条 + 平均缓存命中率
（ΣcacheRead / Σ(input+cacheRead) 全会话聚合）。

**口径（方案核心）**：占用 = 末条带 usage 的 assistant 消息
`input + cacheRead + cacheWrite + output`。pi 每轮全量重发上下文，三项和
即该轮**端点实报的实发量**，加 output = "下一轮将重发"。所以**总量不需要
估算**——usage 是实报真相，与 Claude Code status 百分比同源（同样拿末轮
usage 算，非实时计数；流式中保持上一轮值是诚实不是缺陷）。分母 =
`contextWindow`（目录/自定义 merge 值；**不上网络的客户端元数据**——OpenAI
兼容接口只发 `max_tokens`，窗口长度是客户端预算认知，自定义模型缺省 128K
偏保守 → 真实窗口更大时百分比显示偏高，方向安全）。

**明细（分类占比）为什么先不做**：需要把总量拆成 系统提示词/系统工具/
MCP/消息 各段分别计数，pi 无 estimator API。主流三条路：
① **官方 count API**——Anthropic 有 `count_tokens` 端点，Claude Code
`/context` 的分类明细就是逐段调它（精确、与计费同源词表）；OpenAI chat
模型无公开 count 端点；② **本地 tokenizer**——tiktoken 对 OpenAI 精确
（词表公开），对 GLM/DeepSeek 只能近似（各家 BPE 词表不同）；
③ **chars 粗估**（~4 chars/token，中文更密）——Cherry Studio 等通用客户端
做法，跨模型一视同仁地不准。Cogent 当时无工具/MCP，明细只有"消息"一项，
是空架子；待工具铺开后若主力 Anthropic 系可接 ①，通用场景退 ③ 并标 ≈。
压缩预警线（Claude Code "Context left until auto compact"）同理等压缩模块。
**→ 明细已于 2026-11-11 接上，见 §6.1。**

## 6.1 分类明细三段（2026-11-11，工具落地后接上）

**先修正 §6 的一个过时判断**："pi 无 estimator API" 不成立 —— pi-ai
`utils/estimate.js` 导出 `estimateContextTokens`/`estimateMessageTokens`/
`estimateTextTokens`（3.5 chars/token 粗估 + 图片按 4800 chars），且
`clampMaxTokensToContext`（simple-options.js）每轮算 max_tokens 预算用的
正是它（`窗口 − estimate − 4096`）。**明细与引擎真实预算同源自洽**，这是
tiktoken/count_tokens 都给不了的（另一套词表对真实预算反而失真）——
当初列的三条路之外还有第四条：用引擎自己的估算器。误差特性随之变化：
不是"跨模型一视同仁地不准"，而是"对引擎预算零漂移、对端点实报有字符
粗估误差"（中文偏松）。UI 标记的演变：初版全区 ≈ + "≈ 分类明细"头行，
同日用户定调收敛 —— 头行去掉（估算语义记在本笔记，UI 不重复占行），
拆分靠"总量实报 + 按占比缩放对账"自明。

**三段拆法**：pi 把系统提示词与工具声明合并放在 leading system message
（`toolsAdded` 字段；`estimateMessageTokens` 对 system 消息 = 文本 +
`estimateToolsTokens`），按字段拆开各算各的——文本走
`getSystemMessageText`（含 sections 渲染，与 estimate 内部口径一致），
工具声明 `JSON.stringify(toolsAdded)` 走 `estimateTextTokens`（即 pi
`estimateToolsTokens` 的实现）；其余消息（user/assistant/toolResult）
全归"消息"段。total 直接取 `estimateContextTokens().tokens`
（= 末轮实报 usage + trailing 估算，即预算式里的"占用"），三段和与
引擎看到的占用天然一致。

**ZCode /context 对照**（6 段 vs 3 段）：系统提示词/系统工具/消息 三段
可算已接；MCP 工具（无 MCP 模块）、技能（无技能系统）待各自模块；
"其他"兜底段不仿——Cogent 三段之外没有数不清来源的段，硬凑即假明细。
ZCode 那边是 Anthropic count_tokens 逐段精确计数，Cogent 是粗估 + 实报
总量缩放对账，诚实口径不同。

**实现落点**：协议 `MessageUsage.contextEstimate?`（additive，搭 usage
便车不新增事件；`ContextEstimate` = systemPrompt/toolDefs/messages/
total）；**两条路径各自出数**（estimateContext 纯转录函数同源）：事件路径
在 `agent_end` 转录同步后算一次挂到协议侧 streaming 对象（聚合份与末段份
各一份，随 run.completed 飞走——不进盘上 transcript，pi 形状的 Usage 无
此字段，塞进去浑浊真源）；历史回查路径在 `session.messages` 投影后**按需
现算**挂"末条带 usage 的消息"（读时重算幂等、免盘上迁移）。首版只挂了
事件侧、历史路径无人补算 → 重启后明细消失（2026-11-11 用户报障修复），
附带旧会话从"无字段降级"升级为直接有明细。renderer 悬浮卡明细区
（色点 + 段名 + token + 占比，按占比降序、点色灰黑阶随行序变浅 —— 对标
ZCode /context 色阶的"越大越深"编码，2026-11-11 用户定调：去 ≈ 头行、
灰黑系不引调色板外的色，foreground 透明度阶梯即项目灰阶）。压缩预警线
仍等压缩模块。

**明细（分类占比）为什么先不做**：需要把总量拆成 系统提示词/系统工具/

**实现落点**：纯 renderer 零协议改动——chat store `messagesBySession`
（usage 已持久化，老会话直接可用）+ engine store `ModelSummary.contextWindow`
（分母模型与 ModelMenu 同走 `usableModels` 过滤，防同名跨 provider 命中
未配 key 条目）。`ContextBar` 斜纹轨道 = `repeating-linear-gradient` +
`--color-border`（原始 CSS 里 tailwind `/opacity` 修饰符不编译，token 须
实色引用）；空态（首答前）显示引导文案而非 0%（首轮其实有系统提示词
占用）；端点不报缓存的模型命中率行整行隐藏（cacheRead 恒 0 时 "0%" 是
误导，零值省略同 UsageLine）。
