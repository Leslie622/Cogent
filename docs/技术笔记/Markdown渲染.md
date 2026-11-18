# Markdown 渲染

> 学习主题：流式解析、默认安全管线、CJK 和增量渲染。
> 当前行为见 [消息呈现](../模块/消息呈现.md)，动画原理见 [流式呈现动效](流式呈现动效.md)。

## 1. 为什么不是收到文本就重新解析整条历史

模型输出包含未闭合围栏、强调、引用与表格。流式中途按完整 Markdown 解释，闭合时可能
在普通文本和块结构间切换；高频通知又会放大解析和高亮成本。模型文本还可能含 HTML，
安全清洗与 CJK 标点规则不能因为加动画被悄悄拆掉。

Cogent 的发布入口按会话 30ms 合批；历史消息由 MessageRow memo 保住，活尾由
Streamdown 块级复用。发布节奏、解析缓存与 CSS 动画是三层，各有 owner，不叠多个 timer。

## 2. pi 与其他参照如何处理

pi 内核只产 text/thinking/toolCall，不渲染。其终端消费端
`packages/tui/src/components/markdown.ts` 使用 marked lexer 再遍历为 ANSI，
配主题函数、代码高亮、半截围栏修剪和 CJK 规则。原笔记对 pi-tui 包的缓存观察来自
接入期包源码；后续流畅性调研的 sparse checkout 缺底层 blob，不能把调用
requestRender 当成重新核实了整套缓存或虚拟化。

| 参照 | 原理与适用边界 |
| --- | --- |
| pi CLI | token → ANSI，不是 Web DOM；可借“稳定块不重复工作”，不复制终端布局 |
| Harness | `reference/deepseek-harness/packages/client/ui-primitives/src/markdown/incremental.ts:255-358` 保留两块活尾，`MarkdownText.tsx:69-154,201-213` 冻结前缀并最终全文解析；自写渲染器也要承担脚注/引用的冻结边界语义 |
| zcode | `reference/zcode/packages/ui/src/components/ai-elements/message.tsx:845-1313` 把完整已收文本交给 opacity 层；不能把逐字可见文本当布局驱动 |
| LobeChat / Cherry Studio（原笔记调研） | React 组件树与 Shiki 是共享技术方向；产品版本与内部缓存策略不能仅从使用同一库推断 |
| Streamdown 2.7.1 | remend 修未闭合片段、块级 memo、异步 Shiki 高亮与默认安全管线；Cogent 购买解析能力，自己只加必要 adapter |

## 3. 依赖的三条合同

1. `rehypePlugins` 是覆盖语义。Block adapter 追加插件时继承实际传下的 raw/sanitize/
   harden 管线，不自己仿造默认数组。原始 HTML 始终经过原库清洗。
2. streaming 与 static 是不同解析语义。只关 isAnimating 不等于完成结算，最终必须切
   static 才还原未闭合强调、行内 code 和链接的字面结果。
3. 代码高亮输出是按行结构化 JSX、前缀 grammarState 可复用，新增行可做 mount-only
   淡入。它依赖具体 DOM 合同，升级 Streamdown 时需要相应测试。

依据：`node_modules/streamdown/dist/index.d.ts:590,687-690,716-731` 与
`dist/chunk-7TTQLYRW.js:17-20,40`；高亮依据
`node_modules/@streamdown/code/dist/index.js`。实际分块重整与实例身份的区别见动效笔记。

## 4. CJK、高亮与桌面链接

`@streamdown/cjk` 处理紧贴中文标点的强调/删除线，和 pi 的 marked-cjk-friendly
属于同类解析问题。`@streamdown/code` 用 Shiki，各语言按需懒加载；代码等宽字体随包
带 JetBrains Mono，中文回落鸿蒙。语言 chunk 多不意味着所有语言都在启动路径执行。

链接点击 preventDefault 后交给 window.open，让 Electron 的 setWindowOpenHandler
走系统浏览器。裸 a 窗口内导航不会自动经过这条守卫。链接色、字重和下划线归正文主题
消费表，不在 Markdown 组件硬编码品牌色。默认外链确认弹窗、行号和库内 animated 关闭，
自有 reveal 的必要性与边界在对应笔记解释。

Tailwind v4 自动扫描不进入 node_modules，必须 `@source` Streamdown dist，才能生成
包里使用的工具类；这与导入库的全套样式表不是一回事。额外主题层见
[聊天正文主题](聊天正文主题.md)，不复制一份 CSS 配方。

## 5. Cogent 落点

`src/renderer/src/components/ui/markdown.tsx` 管渲染与 Block adapter；
`features/home/MessageRow.tsx` 管消息级复用；`stores/chat/delta-batcher.ts` 管合批；
`globals.css` 管样式消费。默认清洗、分块重整、节点保留与最终语义由
`tests/renderer/components/ui/` 中的渲染合同测试验证；实际像素和帧率仍需浏览器/真机测量。
