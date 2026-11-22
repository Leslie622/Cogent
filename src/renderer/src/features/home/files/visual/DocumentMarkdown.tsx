/** 文档独立懒包启用数学与图表；聊天的流式管线与首屏依赖不承担这些解析器。 */
import { createMathPlugin } from '@streamdown/math'
import { createMermaidPlugin } from '@streamdown/mermaid'
import 'katex/dist/katex.min.css'
import { Markdown } from '@/components/ui/markdown'

const documentPlugins = {
  math: createMathPlugin({ singleDollarTextMath: true }),
  mermaid: createMermaidPlugin({ config: { securityLevel: 'strict' } })
}

export default function DocumentMarkdown({ content }: { content: string }) {
  return <Markdown content={content} documentPlugins={documentPlugins} />
}
