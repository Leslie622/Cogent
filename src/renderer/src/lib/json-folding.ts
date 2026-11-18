/** JSON 折叠按容器深度投影，语法树仅提供位置；不解析数值，也不改写留存文本。 */
import { jsonLanguage } from '@codemirror/lang-json'

export function getJsonFoldRanges(content: string, expandedDepth: number): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = []
  // 采集尾标是说明文字，不能让容错解析器把其中的方括号当成新的 JSON 数组。
  const truncatedAt = content.indexOf('\n…[已截断，原始 ')
  const source = truncatedAt === -1 ? content : content.slice(0, truncatedAt)
  jsonLanguage.parser.parse(source).iterate({
    enter(node) {
      if (node.name !== 'Object' && node.name !== 'Array') return
      let depth = 1
      for (let parent = node.node.parent; parent !== null; parent = parent.parent) {
        if (parent.name === 'Object' || parent.name === 'Array') depth += 1
      }
      // 截断块的未闭合容器仍展开，里面已经闭合的子节点照常可折叠。
      const closing = node.name === 'Object' ? '}' : ']'
      if (depth > expandedDepth && node.node.lastChild?.name === closing && node.to - node.from > 2) {
        ranges.push({ from: node.from + 1, to: node.to - 1 })
        return false
      }
    },
  })
  return ranges
}
