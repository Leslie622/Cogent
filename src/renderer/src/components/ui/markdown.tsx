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
 * ① 链接重写：色走 chrome-accent（UI 方针"文内链接专用色"；包默认 text-primary
 *    在本项目 = 近黑，不是品牌蓝）；点击 preventDefault 后改道 window.open ——
 *    主进程只挂了 setWindowOpenHandler 守卫，裸 <a> 的窗口内导航（will-navigate）
 *    没人拦，会把应用窗口带到外链，window.open 恰好走该守卫转系统浏览器。
 *    默认的外链确认弹窗（linkSafety）一并关掉：桌面惯例直接开系统浏览器；
 * ② lineNumbers 关：主流聊天产品（ChatGPT/Claude）代码块不显示行号；
 * ③ animated 关：块入场动画主流均无，克制。
 */
import { Streamdown, defaultComponents, type Components } from 'streamdown'
import { code } from '@streamdown/code'
import { cjk } from '@streamdown/cjk'

/** 元素级覆盖：铺在包的 defaultComponents 之上，只动链接（理由见文件头 ①）。
    node 解构丢弃是解污染 —— 不剥掉会把 hast 节点对象 spread 到 DOM 属性上 */
const components: Components = {
  ...defaultComponents,
  a: ({ node, children, href, ...props }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="wrap-anywhere appearance-none text-left font-medium text-chrome-accent underline"
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

/** 助手消息的 Markdown 正文。streaming = 流式占位消息（未闭合块修复生效）；
    字号/行高在容器层定基调（text-sm 对话流正文口径），块级元素由包默认接管 */
export function Markdown({ content, streaming = false }: { content: string; streaming?: boolean }) {
  return (
    <Streamdown
      mode={streaming ? 'streaming' : 'static'}
      plugins={{ code, cjk }}
      components={components}
      animated={false}
      lineNumbers={false}
      linkSafety={{ enabled: false }}
      className="text-sm leading-relaxed text-foreground"
    >
      {content}
    </Streamdown>
  )
}
