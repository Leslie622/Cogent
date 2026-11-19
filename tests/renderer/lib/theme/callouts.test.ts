/** 固定提示块标记转换与普通引用边界；解析安全仍由原生管线负责。 */
import { expect, it } from 'vitest'
import type { Root } from 'hast'
import { callouts } from '@/lib/theme/callouts'

it.each(['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'])('%s 提示块保留正文并加入固定标题', (kind) => {
  const tree: Root = { type: 'root', children: [{ type: 'element', tagName: 'blockquote', properties: {}, children: [{ type: 'element', tagName: 'p', properties: {}, children: [{ type: 'text', value: `[!${kind}]\n正文` }] }] }] }
  callouts()(tree)
  expect(tree.children[0]).toMatchObject({ tagName: 'div', properties: { className: ['themd-callout', `themd-callout-${kind.toLowerCase()}`] } })
  expect(JSON.stringify(tree)).toContain('正文')
  expect(JSON.stringify(tree)).not.toContain(`[!${kind}]`)
})

it('普通引用、未完成标记和未知类型保持原样', () => {
  for (const text of ['普通引用', '[!NO', '[!HTML]\n<script>']) {
    const tree: Root = { type: 'root', children: [{ type: 'element', tagName: 'blockquote', properties: {}, children: [{ type: 'element', tagName: 'p', properties: {}, children: [{ type: 'text', value: text }] }] }] }
    const before = structuredClone(tree)
    callouts()(tree)
    expect(tree).toEqual(before)
  }
})
