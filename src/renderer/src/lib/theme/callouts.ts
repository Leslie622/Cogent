/** 默认清洗之后只把固定 GFM 提示块标记变为可信结构；不新增 HTML 解析或放宽清洗。 */
import type { Element, Root } from 'hast'

const titles = { NOTE: '提示', TIP: '建议', IMPORTANT: '重要', WARNING: '警告', CAUTION: '注意' } as const

export function callouts() {
  return (tree: Root) => {
    const visit = (parent: Root | Element) => {
      for (const node of parent.children) {
        if (node.type !== 'element') continue
        if (node.tagName === 'blockquote') {
          const paragraph = node.children.find((child) => child.type === 'element' && child.tagName === 'p')
          const first = paragraph?.type === 'element' ? paragraph.children[0] : undefined
          const match = first?.type === 'text' ? /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\r?\n|$)/.exec(first.value) : null
          if (match !== null && first?.type === 'text') {
            const kind = match[1] as keyof typeof titles
            first.value = first.value.slice(match[0].length)
            node.tagName = 'div'
            node.properties = { className: ['themd-callout', `themd-callout-${kind.toLowerCase()}`] }
            node.children.unshift({ type: 'element', tagName: 'div', properties: { className: ['themd-callout-title'] }, children: [{ type: 'text', value: titles[kind] }] })
          }
        }
        visit(node)
      }
    }
    visit(tree)
  }
}
