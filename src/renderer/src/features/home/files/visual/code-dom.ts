/** Pierre 的公开行属性与原文本坐标间的桥；不改 token DOM，避免破坏虚拟行缓存。 */
import { codeLineAt, type CodeDocument, type CodeMatch, type CodeSelection } from './code-text'

function lineElement(root: ShadowRoot, index: number): HTMLElement | null {
  return root.querySelector(`[data-line][data-line-index="${index}"]`)
}

function textPoint(line: HTMLElement, column: number): { node: Node; offset: number } {
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode(), remaining = column
  while (node !== null) {
    const length = node.textContent!.length
    if (remaining <= length) return { node, offset: remaining }
    remaining -= length
    node = walker.nextNode()
  }
  return { node: line, offset: line.childNodes.length }
}

export function codePoint(root: ShadowRoot, source: CodeDocument, offset: number): { node: Node; offset: number } | null {
  const index = codeLineAt(source, offset), line = lineElement(root, index)
  return line === null ? null : textPoint(line, Math.min(offset, source.lines[index].to) - source.lines[index].from)
}

function pointOffset(root: ShadowRoot, source: CodeDocument, node: Node, offset: number): number | null {
  const parent = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
  const line = parent?.closest<HTMLElement>('[data-line][data-line-index]')
  if (line == null || !root.contains(line)) return null
  const index = Number(line.dataset.lineIndex), range = document.createRange()
  range.selectNodeContents(line)
  range.setEnd(node, offset)
  return Math.min(source.lines[index].to, source.lines[index].from + range.toString().length)
}

export function readCodeSelection(root: ShadowRoot, source: CodeDocument): CodeSelection | null {
  const selection = window.getSelection()
  if (selection === null) return null
  let anchor = selection.anchorNode, head = selection.focusNode
  let anchorOffset = selection.anchorOffset, headOffset = selection.focusOffset
  // Chromium 的普通 anchor/focus 可能重定向到 host；ComposedRanges 才给出 Shadow 内端点。
  if (anchor === null || head === null || !root.contains(anchor) || !root.contains(head)) {
    const browserSelection: { getComposedRanges?: (options: { shadowRoots: ShadowRoot[] }) => StaticRange[]; direction?: string } = selection
    const composed = browserSelection.getComposedRanges?.({ shadowRoots: [root] })
    if (composed === undefined || composed.length === 0) return null
    const range = composed[0], backward = browserSelection.direction === 'backward'
    anchor = backward ? range.endContainer : range.startContainer
    head = backward ? range.startContainer : range.endContainer
    anchorOffset = backward ? range.endOffset : range.startOffset
    headOffset = backward ? range.startOffset : range.endOffset
  }
  const from = pointOffset(root, source, anchor, anchorOffset), to = pointOffset(root, source, head, headOffset)
  return from === null || to === null ? null : { anchor: from, head: to }
}

export function applyCodeSelection(root: ShadowRoot, source: CodeDocument, value: CodeSelection): boolean {
  const anchor = codePoint(root, source, value.anchor), head = codePoint(root, source, value.head)
  if (anchor === null || head === null) return false
  window.getSelection()!.setBaseAndExtent(anchor.node, anchor.offset, head.node, head.offset)
  return true
}

export function visibleCodeRanges(root: ShadowRoot, source: CodeDocument, matches: CodeMatch[]): Range[] {
  const ranges: Range[] = []
  for (const line of root.querySelectorAll<HTMLElement>('[data-line][data-line-index]')) {
    const index = Number(line.dataset.lineIndex), bounds = source.lines[index]
    for (const match of matches) {
      if (match.to <= bounds.from || match.from >= bounds.to) continue
      const start = textPoint(line, Math.max(match.from, bounds.from) - bounds.from)
      const end = textPoint(line, Math.min(match.to, bounds.to) - bounds.from)
      const range = document.createRange()
      range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset)
      ranges.push(range)
    }
  }
  return ranges
}

export function updateCodeHighlights(name: string, ranges: Range[]): void {
  const browser: { Highlight?: new (...ranges: Range[]) => unknown } = globalThis
  const registry = (globalThis.CSS as { highlights?: Map<string, unknown> } | undefined)?.highlights
  if (registry === undefined || browser.Highlight === undefined) return
  if (ranges.length === 0) registry.delete(name)
  else registry.set(name, new browser.Highlight(...ranges))
}

export function clearCodeHighlights(...names: string[]): void {
  const registry = (globalThis.CSS as { highlights?: Map<string, unknown> } | undefined)?.highlights
  names.forEach(name => registry?.delete(name))
}
