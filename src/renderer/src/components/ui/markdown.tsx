/**
 * Markdown 渲染（对话内容）：Streamdown 封装 —— 组件
 * registry 没有 markdown 件（registry 逐名核实过），按 约定.md §3 手写成
 * 可复用组件，同 reasoning.tsx（手写 AI Elements pattern）的先例。
 * 为什么是 Streamdown 而不是裸 react-markdown：流式而生 —— remend 修复未闭合
 * 块（代码围栏流到一半就按代码块渲染，不闪纯文本）、块级 memo 扛住 chat store
 * 每批发布的重渲染（历史消息另由 MessageRow 的 memo 挡在重解析之外）。
 * 插件：@streamdown/code = Shiki 高亮（语言按需懒加载，与 @lobehub/ui 共享同一
 * 份 shiki 传递依赖，主题 github-light/dark）；@streamdown/cjk = CJK 友好解析
 * （加粗/删除线紧贴中文标点不失效）。math/mermaid 插件不装（后续件按需）。
 * 偏离包默认的四处，各有明确理由：
 * ① 链接重写：点击 preventDefault 后改道 window.open —— 主进程只挂了
 *    setWindowOpenHandler 守卫，裸 <a> 的窗口内导航（will-navigate）
 *    没人拦，会把应用窗口带到外链，window.open 恰好走该守卫转系统浏览器。
 *    默认的外链确认弹窗（linkSafety）一并关掉：桌面惯例直接开系统浏览器。
 *    颜色/字重/下划线不在组件里定（原 chrome-accent 硬编码已随对话内容主题化
 *    退役，见 决定.md），归 lib/theme/ 的基础样式与宿主适配按令牌接管；
 * ② lineNumbers 默认关（外观设置「显示代码行号」驱动；默认值沿用主流
 *    聊天产品惯例——ChatGPT/Claude 代码块无行号）；
 *    shikiTheme 显式传 [github-light, github-dark] 双元组：亮暗两套同时
 *    渲染、CSS 随 html.dark 切换显示（Streamdown 原生双主题机制）；
 * ③ animated 关：块入场动画主流均无，克制；
 * ④ 流式逐词淡入：每个真实 Block 实例分别保存进度与插件，追加到 Streamdown
 *    传入的 rehype 管线末尾；消息只共享排期时钟。同文段落也有独立身份，
 *    具体接法见 docs/技术笔记/流式呈现动效.md。
 * md-body 作用域隔离主题；Themd 基准和用户最高优先层见 docs/技术笔记/对话内容主题.md。
 */
import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Block, Streamdown, defaultComponents, defaultRehypePlugins, defaultRemarkPlugins, parseMarkdownIntoBlocks, type BlockProps, type Components } from 'streamdown'
import { code } from '@streamdown/code'
import { cjk } from '@streamdown/cjk'
import {
  commitStreamingReveal,
  commitStreamingRevealBlock,
  createStreamingRevealBlockState,
  createStreamingRevealPlugin,
  createStreamingRevealState,
  isIncrementalRevealSource,
  prepareStreamingRevealBlocks,
  type StreamingRevealPacing,
  type StreamingRevealState,
} from '@/components/ui/stream-reveal'
import { useAppearanceStore } from '@/stores/appearance'
import { callouts } from '@/lib/theme/callouts'
import { decodeFileEnvelope, decodeFileLink, fileLinksPlugin } from '@/lib/file-links'
import { FileLink, FileLinkContext, FileLinkNestingContext } from '@/features/home/files/FileLink'
import { FileImage } from '@/features/home/files/FileImage'

const plugins = { code, cjk }
/** 原生完整安全管线后追加可信提示块适配；静态路径不经过 BlockComponent。 */
const themedRehypePlugins = [...Object.values(defaultRehypePlugins), callouts]
const linkSafety = { enabled: false }
/** Shiki 双主题：亮暗两套同时渲染，CSS 随 html.dark 切显示（元组序 = [亮, 暗]） */
const shikiTheme: [string, string] = ['github-light', 'github-dark']

const StreamingRevealContext = createContext<StreamingRevealState | null>(null)

/** 流式中代码块/表格追加行的 mount-only 淡入目标（globals.css「逐词浮现」段
 *  同款选择器，双处同步）：行身份 = 行索引 key + 增量高亮前缀稳定，旧行元素
 *  保留不重播、新行新挂载才淡入。终态收尾等待也认它们的 opacity —— 纯代码/
 *  表格消息没有 data-reveal，不等的话收尾立即切 static 会切断仍在播的行淡入
 *  （Block 树被换、行元素重挂）。合同钉在 md-line-transition.render.test.tsx。 */
const REVEAL_LINE_SELECTOR = "[data-streamdown='code-block-body'] code > span, table tr"

/** 段间排期接力（会话级，Provider 挂在对话消息流 HomeChat ChatMessages）：
 *  封段后的新正文段以旧段排期尾为初始时钟，首拍不早于前段末拍的淡入结束
 *  —— 快工具后两段渐显不倒序并存（机制见 stream-reveal.ts）。
 *  无 Provider 的独立渲染（单测/孤立 Markdown）行为不变。 */
export const RevealPacingContext = createContext<StreamingRevealPacing | null>(null)

/** 身份跟随 Streamdown 的真实块实例；默认 Block 继续负责解析、清洗及组件复用。 */
const StreamingRevealBlock = memo(function StreamingRevealBlock(props: BlockProps) {
  const message = useContext(StreamingRevealContext)!
  const [block] = useState(createStreamingRevealBlockState)
  const revealPlugin = useMemo(() => createStreamingRevealPlugin(message, block), [message, block])
  const rehypePlugins = useMemo(
    // 原生 Streamdown 给 Block 的已生效管线包含默认清洗和内部处理，不能在此重建。
    () => [...props.rehypePlugins!, revealPlugin],
    [props.rehypePlugins, revealPlugin]
  )
  useEffect(() => { commitStreamingRevealBlock(block) })
  return <Block {...props} rehypePlugins={rehypePlugins} />
})

/** 元素级覆盖：保留 defaultComponents，文件/网页/脚注分别委托，本地图片按 ID 读取。
    node 解构丢弃是解污染 —— 不剥掉会把 hast 节点对象 spread 到 DOM 属性上 */
const components: Components = {
  ...defaultComponents,
  img: function MarkdownImage({ src, alt, node, ...props }) {
    const scope = useContext(FileLinkContext)
    const target = decodeFileLink(typeof src === 'string' ? src : undefined)
    if (target !== undefined) return <FileImage target={target} alt={alt ?? '本地图片'} />
    if (scope?.preview) return <span>{alt ?? '外部图片'}（外部资源未自动加载）</span>
    return <defaultComponents.img src={src} alt={alt} {...props} />
  },
  a: function MarkdownLink({ node, children, href, title, ...props }) {
    const file = decodeFileEnvelope(href)
    if (file?.imageAlt !== undefined) return <FileImage target={file.target} alt={file.imageAlt} />
    if (file !== undefined) return <FileLink target={file.target} title={title}>{children}</FileLink>
    if (href?.startsWith('#') && !href.startsWith('#cogent-file:')) return <a href={href} {...props} onClick={(event) => { event.preventDefault(); document.getElementById(href.slice(1))?.scrollIntoView() }}>{children}</a>
    if (href === undefined || !/^(?:https?:\/\/|\/\/)/i.test(href)) return <span>{children}</span>
    return (
    <FileLinkNestingContext.Provider value><a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="wrap-anywhere appearance-none text-left"
      onClick={(event) => {
        event.preventDefault()
        window.open(href.startsWith('//') ? `https:${href}` : href)
      }}
      {...props}
    >
      {children}
    </a></FileLinkNestingContext.Provider>
    )
  },
}

/** streaming只表示业务仍在输出；终态的既有Block树短暂保留到真实过渡结束，再恢复原生static语义。
 * 字号/行高由主题基础样式消费，收尾设计见docs/技术笔记/流式呈现动效.md。 */
export function Markdown({ content, streaming = false }: { content: string; streaming?: boolean }) {
  const fileScope = useContext(FileLinkContext)
  const fileLinks = useMemo(() => fileLinksPlugin(fileScope?.refs), [fileScope?.refs])
  const remarkPlugins = useMemo(() => [...Object.values(defaultRemarkPlugins), fileLinks], [fileLinks])
  // 代码行号（外观设置；默认关，见文件头 ②）
  const showLineNumbers = useAppearanceStore((s) => s.showLineNumbers)
  // 30ms 发布由 renderer 事件入口持有；直接传入的内容不再二次延迟。
  // 消息持有节奏与增量信号，文本进度由真实块持有；内容不再替代块身份。
  // 排期时钟种子取自会话级 pacing（封段接力的下一段不早于前段淡入结束）。
  const pacing = useContext(RevealPacingContext)
  const [revealState] = useState(() => createStreamingRevealState(pacing))
  const revealPrevious = useRef('')
  const root = useRef<HTMLDivElement>(null)
  const [visualStreaming, setVisualStreaming] = useState(streaming)
  // 终态不等待视觉；只有同一正文的既有节点可以短暂保留，权威改写立即走静态解析。
  const sameSource = content === revealPrevious.current || isIncrementalRevealSource(revealPrevious.current, content)
  const renderStreaming = streaming || (visualStreaming && sameSource)
  // render 期只判定（文本变化时）；文本没变的重渲染（主题等其它 prop）保留
  // 上一次判定，重新判定会把「没有新增」误判成非增量。提交在 effect。
  if (!streaming) revealState.incremental = false
  else if (content !== revealPrevious.current) {
    revealState.incremental =
      isIncrementalRevealSource(revealPrevious.current, content)
  }
  useEffect(() => {
    commitStreamingReveal(revealState)
    revealPrevious.current = content
  })
  const parseBlocks = useCallback((source: string) => {
    const blocks = parseMarkdownIntoBlocks(source)
    prepareStreamingRevealBlocks(revealState, blocks)
    return blocks
  }, [revealState])
  useLayoutEffect(() => {
    if (streaming) {
      setVisualStreaming(true)
      return
    }
    if (!renderStreaming || document.hidden) {
      setVisualStreaming(false)
      return
    }
    // 只等本件的渐显过渡，不把扫光、主题色或任意无限动画当成正文尚未完成。
    const transitions = root.current!.getAnimations({ subtree: true }).filter((animation) => {
      if (!(animation instanceof CSSTransition) || animation.playState === 'finished' || animation.playState === 'idle') return false
      const target = (animation.effect as KeyframeEffect | null)?.target
      return target instanceof Element && (
        (animation.transitionProperty === 'opacity' &&
          (target.hasAttribute('data-reveal') || target.matches(REVEAL_LINE_SELECTOR))) ||
        (animation.transitionProperty === 'color' && target.hasAttribute('data-reveal-marker'))
      )
    })
    if (transitions.length === 0) {
      setVisualStreaming(false)
      return
    }
    let current = true
    const onVisibility = () => {
      if (document.hidden) setVisualStreaming(false)
    }
    document.addEventListener('visibilitychange', onVisibility)
    // 取消也是正常收口；卸载、新流或内容换版只撤销本代回调，不打断浏览器仍在播的过渡。
    void Promise.allSettled(transitions.map((animation) => animation.finished)).then(() => {
      if (current) setVisualStreaming(false)
    })
    return () => {
      current = false
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [streaming, content, renderStreaming])
  return (
    // data-md-streaming：行级淡入的作用域标记 —— 流式渲染（含终态视觉收尾
    // 暂留窗口）为 'true'，static/历史/收尾完成后摘除（摘除后旧树即使重挂
    // 也无 scoped 规则 = 零动画、不重播）。CSS 消费见 globals.css 逐词浮现段。
    <div
      ref={root}
      data-slot="markdown-root"
      data-md-streaming={renderStreaming ? 'true' : undefined}
      className="contents"
    >
      <StreamingRevealContext.Provider value={revealState}>
        <Streamdown
          mode={renderStreaming ? 'streaming' : 'static'}
          plugins={plugins}
          rehypePlugins={themedRehypePlugins}
          remarkPlugins={remarkPlugins}
          // Streamdown 的 memo 不比较 remarkPlugins，但会比较 data 属性；用词表身份触发重解析，不换 key 重挂正文。
          data-file-links-version={fileLinks.name}
          isAnimating={streaming}
          components={components}
          BlockComponent={renderStreaming ? StreamingRevealBlock : undefined}
          parseMarkdownIntoBlocksFn={renderStreaming ? parseBlocks : undefined}
          animated={false}
          lineNumbers={showLineNumbers}
          shikiTheme={shikiTheme}
          linkSafety={linkSafety}
          className="md-body space-y-0 text-foreground"
        >
          {content}
        </Streamdown>
      </StreamingRevealContext.Provider>
    </div>
  )
}
