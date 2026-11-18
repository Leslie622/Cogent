# token 用量统计

> 学习主题：计费真值、目录估价与上下文预算为何是三种口径。
> 当前采集、指示器与验收见 [用量与成本](../模块/用量与成本.md)。

## 1. usage 属于模型调用，不属于画面

pi 每条 AssistantMessage 带 Usage，内容包括 input/output/cacheRead/cacheWrite、
reasoning、totalTokens 和 cost。工具循环一次用户提交会多次调用模型，各轮都重发部分
上下文，因此回答总费用必须逐轮相加；重复 input 是计费口径，不是重复计账的 bug。
缺字段与数值 0 有不同含义，聚合时不能把“未报告”伪装成“报告了零”。

pi 依据：`node_modules/@earendil-works/pi-ai/dist/types.d.ts:348-365,388,399-405`。
各方言先归一 Usage，Host 不重复识别每家缓存字段。

## 2. 缓存归一为什么要在方言层完成

OpenAI 的 prompt_tokens 包含缓存命中，pi 归一后的 input 已扣缓存读写。
四项互斥，相加才是总量；消费端再扣一次缓存就会算小。DeepSeek、OpenAI 与 Kimi
的缓存字段位置不同，pi `api/openai-completions.js:1160-1167` 在解析层统一，
用协议里的同一 MessageUsage 便可跨 Provider 展示。

测试 mock 必须按端点原始口径构造，再检查归一结果。例如原 prompt=1000、
缓存读=800、写=100，则 input=100。直接在 mock 中给已经扣好的 prompt，会产生假保护。

## 3. 目录估价不是账单

pi 的 cost.total 可来自端点实报，也可由目录单价乘用量估算；totalFromProvider 标明来源。
目录是版本快照，可能不反映汇率、分时价、折扣、转发网关价格，不能宣称和账单精确一致。
当任意一轮由目录估算，多轮总和也只能叫估价，totalCostFromProvider 取 AND。
UI 对估价加 ≈；小于显示下限已有 `<`，无需叠两种不精确标记。

目录同 id 模型被用户编辑后仍须继承 cost；全新自定义模型无可验证价格则为 0，
UI 隐藏无价项。具体 merge 原理见 [凭据与模型目录](凭据与模型目录.md)。
这避免统计模块为了补偿覆盖层丢字段，再维护第二份价格表。

## 4. 上下文占用与累计计费不能相加使用

窗口指示器问“下一轮大约要带多少上下文”，回答统计行问“本次回答累计花了多少”。
前者采用末轮上下文 usage/压缩回落估算，后者累计全部轮次；把累计 input 当窗口分子，
长工具循环会虚假爆表。分母是所选 `(provider,model)` 的 contextWindow 元数据，
不是服务端实时发现值，自定义窗口填错也会直接改变预算认知。

pi `utils/estimate.js` 提供 estimateContextTokens/estimateMessageTokens/estimateTextTokens，
其字符粗估与 `simple-options.js` 的 max_tokens clamp 使用同系规则。
Cogent 的估算转录整形与真实请求组装近似同源，并非精确 tokenizer；图片、中文和
不同 provider 实际计数仍有误差。“与预算同源”不能写成“对端点 token 零误差”。

总量优先取已有轮终实报，新增尾部用估算；压缩后以 tokensAfter 回落。
三段明细按 systemPrompt/toolDefs/messages 拆分，再按实报总量比例对账。
系统提示在 pi 中是状态而非普通树消息，估算时要合成当前 system 文本和 tool 声明；
惰性会话只能回落自拼提示词，精度边界必须承认。

## 5. 明细、存储与事件顺序

```text
owner: pi（每轮 usage 与转录）
turn_end → Host 累计本 run，并发布本轮 context.updated
agent_settled → 当前上下文估算 → 终态分段/聚合 Usage
历史回查 → 从 pi 树重投影 usage → 按需补末条上下文明细
owner: renderer（展示，不维护第二份账本）
```

usage 已在 pi JSONL，历史回查直接投影；contextEstimate 是 Host 的展示估算，
不硬塞进 pi Usage 真源，事件与历史路径分别从同一估算函数获得。
只在事件路径挂明细会导致重启后消失；把投影的 timestamp 造为 Date.now 也会让
历史耗时和时间漂移。投影层应保留源事实，不在读取时偷偷更新事实。

模型 durationMs 是各轮请求耗时，工具耗时另算；两者都不同于用户回合墙钟。
不要从“头条显示工作多久”倒推 API 持续时长。运行中 usage 只在端点报告后可用，
不能用逐字输出速率伪造实时计费。

## 6. 对照与取舍

| 参照 | 统计归属与启示 |
| --- | --- |
| pi | Usage 是 AssistantMessage 属性，持久化转录保真后历史统计无需另建遥测流 |
| 作者此前 LangChain 项目 | AIMessage.usage_metadata 与 response_metadata 分别保存归一和原始值；同样需要明确聚合层次 |
| Claude Code / Codex CLI（原产品观察） | 会话账本更适合回答任务总成本；不能从 CLI 汇总呈现推断所有端点都回账单金额 |
| 聊天客户端 | 每条回答统计更易解释局部花费；Cogent 选择消息级多轮合计，未另建会话计费资产 |

独立 usage 事件会增加按 messageId 归位与终态替换的竞态，附在终态消息可自然接续历史。
覆盖率或显示字段数量不构成采集目标；只报告有来源、能解释的数值。

## 7. Cogent 落点

`src/host/runtime/session.ts` 的 projectUsage/累加/estimateContext 负责归一和投影；
`src/host/runtime/compaction.ts` 提供估算整形与真实压缩预警比率；
`src/renderer/src/features/home/MessageRow.tsx` 与 `ContextIndicator.tsx` 分别展示
回答统计和窗口预算，协议类型在 `src/protocol/types.ts`。压缩原理见
[上下文压缩](上下文压缩.md)，不在统计笔记重述触发算法。
