/** 核对实际 CodeMirror selection，而不只检查传入位置或状态文案。 */
import { render, screen } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { parseFileTarget } from '@shared/file-target'
import TextPreview from '@/features/home/files/TextPreview'

describe('当前文本预览定位', () => {
  it.each(['./测试.txt:2:3', './测试.txt#L2C3', './测试.txt#L2:C3', './测试.txt#L2:3'])('%s 实际定位第 2 行第 3 列', (target) => {
    const view = render(<TextPreview text={'第一行\nABCDEFG\n第三行'} name="测试.txt" location={parseFileTarget(target)!.location} />)
    const editor = EditorView.findFromDOM(view.container.querySelector('.cm-editor')!)!
    const position = editor.state.selection.main.head
    const line = editor.state.doc.lineAt(position)
    expect(line.number).toBe(2)
    expect(position - line.from + 1).toBe(3)
    expect(line.text[position - line.from]).toBe('C')
    expect(screen.getByRole('status')).toHaveTextContent('已定位：第 2 行，第 3 列')
  })
  it('行范围选中对应原文，越界列明确提示且不伪造定位', () => {
    const view = render(<TextPreview text={'第一行\nABCDEFG\n第三行'} name="测试.txt" location={{ line: 2, endLine: 3 }} />)
    const editor = EditorView.findFromDOM(view.container.querySelector('.cm-editor')!)!
    const selection = editor.state.selection.main
    expect(editor.state.sliceDoc(selection.from, selection.to)).toBe('ABCDEFG\n第三行')
    view.rerender(<TextPreview text={'第一行\nABCDEFG\n第三行'} name="测试.txt" location={{ line: 2, column: 99 }} />)
    expect(screen.getByRole('status')).toHaveTextContent('列号超出当前行范围')
    expect(screen.queryByText(/已定位/)).not.toBeInTheDocument()
  })
})
