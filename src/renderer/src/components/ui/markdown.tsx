/**
 * Markdown 渲染（助手消息正文，路线空位 4）：Streamdown 封装 —— base-luma
 * registry 没有 markdown 件（registry 逐名核实过），按 约定.md §3 手写成
 * 可复用组件，同 reasoning.tsx（手写 AI Elements pattern）的先例。
 * 为什么是 Streamdown 而不是裸 react-markdown：流式而生 —— remend 修复未闭合
 * 块（代码围栏流到一半就按代码块渲染，不闪纯文本）、块级 memo 扛住 chat store
 * 每 delta 的全量重渲染（历史消息另由 MessageRow 的 memo 挡在重解析之外）。
 * 插件：@streamdown/code = Shiki 高亮（语言按需懒加载，与 @lobehub/ui 共享同一
 * 份 shiki 传递依赖，主题 github-light/dark）；@streamdown/cjk = CJK 友好解析
 * （加粗/删除线紧贴中文标点不失效）。math/mermaid 插件不装（后续件按需）。
 * 偏离包默认的三处，各有明确理由：
 * ① 链接重写：点击 preventDefault 后改道 window.open —— 主进程只挂了
 *    setWindowOpenHandler 守卫，裸 <a> 的窗口内导航（will-navigate）
 *    没人拦，会把应用窗口带到外链，window.open 恰好走该守卫转系统浏览器。
 *    默认的外链确认弹窗（linkSafety）一并关掉：桌面惯例直接开系统浏览器。
 *    颜色/字重/下划线不在组件里定（原 chrome-accent 硬编码已随正文主题化
 *    退役，见 决定.md），归 globals.css「聊天正文主题」消费表按令牌接管；
 * ② lineNumbers 关：主流聊天产品（ChatGPT/Claude）代码块不显示行号；
 * ③ animated 关：块入场动画主流均无，克制；
 * ④ 流式逐词淡入：streaming 时在默认 rehype 管线末尾追加 stream-reveal 插件
 *    （自研，zcode streaming-markdown-reveal 移植 —— Streamdown 内置动画的
 *    stagger 无封顶且不能自适应调速，故不用它，详见 stream-reveal.ts 文件头）。
 * md-body 作用域类：正文主题层（globals.css 末尾「聊天正文主题」段）的挂载点，
 * 来自 Themd 主题包（路线 A 静态应用）——层内说明见彼处。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Streamdown, defaultComponents, defaultRehypePlugins, type Components } from 'streamdown'
import { code } from '@streamdown/code'
import { cjk } from '@streamdown/cjk'
import {
  commitStreamingReveal,
  createStreamingRevealPlugin,
  createStreamingRevealState,
  isIncrementalRevealSource,
} from '@/components/ui/stream-reveal'

/** 元素级覆盖：铺在包的 defaultComponents 之上，只动链接（理由见文件头 ①）。
    node 解构丢弃是解污染 —— 不剥掉会把 hast 节点对象 spread 到 DOM 属性上 */
const components: Components = {
  ...defaultComponents,
  a: ({ node, children, href, ...props }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="wrap-anywhere appearance-none text-left"
      onClick={(event) => {
        event.preventDefault()
        window.open(href)
      }}
      {...props}
    >
      {children}
    </a>
  ),
}

/** 助手消息的 Markdown 正文。streaming = 流式占位消息（未闭合块修复生效；
    逐词淡入插件只在 streaming 时挂，见文件头 ④）；字号/行高在容器层定基调
    （text-sm 对话流正文口径），块级元素由包默认接管 */
export function Markdown({ content, streaming = false }: { content: string; streaming?: boolean }) {
  // 流式 30ms 合帧（固定节拍不是 debounce）：chat store 每 delta 直接 setState
  // （1~2 字/次），而排期器每批至少铺开 15ms → 呈现上限 ≈66 字/s，快模型
  // （100~300 字/s）恒积压 —— delay 中的字 opacity:0 占位不显示，夹在已淡入
  // 字之间即「散架」观感（首版实测）。zcode 的排期参数全部以 30ms 合帧为前提
  // （REVEAL_FIRST_WINDOW_MS=30 即其 flushWindowMs），补上后每批 3~10 字、
  // interval 40ms 顶格分摊，同构。渲染层局部合帧，store 事件流不动；
  // 非流式直通（历史消息零开销），收尾 streaming 翻 false 立即同步终值。
  const [displayContent, setDisplayContent] = useState(content)
  const pendingContent = useRef(content)
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 固定节拍（30ms 起 timer、flush 取最新 ref）：cleanup 清 timer 会退化成
  // debounce —— delta 间隔小于 30ms 时 timer 永远被重置、永不 flush
  useEffect(() => {
    pendingContent.current = content
    if (!streaming) {
      if (flushTimer.current !== null) {
        clearTimeout(flushTimer.current)
        flushTimer.current = null
      }
      setDisplayContent(content)
      return
    }
    if (flushTimer.current === null) {
      flushTimer.current = setTimeout(() => {
        flushTimer.current = null
        setDisplayContent(pendingContent.current)
      }, 30)
    }
  }, [content, streaming])
  useEffect(
    () => () => {
      // 卸载清理必须连同置 null：StrictMode 挂载期会跑一遍「挂载→cleanup→
      // 再挂载」，只 clear 不置 null 的话 ref 挂着死 timer 的 id，再挂载时
      // 合帧 effect 误判「timer 已在」永不再起 —— displayContent 恒停初值，
      // 收尾 streaming=false 直通全部内容即「不流式、一股脑」（真机 CDP
      // fiber 采样实锤：contentLen 持续涨、displayLen 恒 0）
      if (flushTimer.current !== null) {
        clearTimeout(flushTimer.current)
        flushTimer.current = null
      }
    },
    []
  )

  // 逐词淡入（stream-reveal.ts）：state 生命周期 = 本组件 —— 流式占位是单条
  // 消息（id 'streaming'），收尾 streaming 翻 false 切 static 整树重建（span
  // 全部消失），state 随组件退役。streamdown 2.7 的 block 解析在 render 期
  // 同步完成，所以 commit 放本帧渲染后的 effect 即可（zcode 2.5 走
  // startTransition 需落后一帧，2.7 无此间接层）。
  const revealState = useRef(createStreamingRevealState())
  // 插件实例引用必须稳定：Streamdown 的 Block 比较器按引用比 rehypePlugins
  // 数组，换引用会让所有块失效重解析。
  const revealPlugin = useMemo(() => createStreamingRevealPlugin(revealState.current), [])
  const revealPrevious = useRef('')
  // render 期只判定（文本变化时）；文本没变的重渲染（主题等其它 prop）保留
  // 上一次判定，重新判定会把「没有新增」误判成非增量。提交在 effect。
  if (displayContent !== revealPrevious.current) {
    revealState.current.incremental =
      streaming && isIncrementalRevealSource(revealPrevious.current, displayContent)
  }
  useEffect(() => {
    commitStreamingReveal(revealState.current)
    revealPrevious.current = displayContent
  })
  // 覆盖语义：传 rehypePlugins 会替换默认管线（raw/sanitize/harden），必须拼
  // 默认再追加（defaultRehypePlugins 是 Record，展开成数组即包内部的默认序）；
  // undefined = 走包默认。
  const rehypePlugins = useMemo(
    () => (streaming ? [...Object.values(defaultRehypePlugins), revealPlugin] : undefined),
    [streaming, revealPlugin]
  )
  return (
    <Streamdown
      mode={streaming ? 'streaming' : 'static'}
      plugins={{ code, cjk }}
      components={components}
      rehypePlugins={rehypePlugins}
      animated={false}
      lineNumbers={false}
      linkSafety={{ enabled: false }}
      className="md-body text-sm leading-relaxed text-foreground"
    >
      {displayContent}
    </Streamdown>
  )
}
