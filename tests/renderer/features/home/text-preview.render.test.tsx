/** 文件链接的定位必须到达 Pierre Shadow 行内的原生选择端点，而不只检查状态文案。 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { File as PierreFile, FileContents, FileOptions } from '@pierre/diffs'
import type { ReactNode } from 'react'
import { parseFileTarget } from '@shared/file-target'
import TextPreview from '@/features/home/files/TextPreview'

vi.mock('@/stores/appearance', () => ({ useIsDarkMode: () => false }))
vi.mock('@pierre/diffs/react', async () => {
  const React = await import('react')
  return {
    Virtualizer: ({ children }: { children: ReactNode }) => <div><div>{children}</div></div>,
    File: ({ file, options }: { file: FileContents; options: FileOptions<undefined> }) => {
      const host = React.useRef<HTMLDivElement>(null)
      React.useLayoutEffect(() => {
        const node = host.current!, root = node.shadowRoot ?? node.attachShadow({ mode: 'open' })
        if (root.children.length === 0) file.contents.split(/(?<=\n)/).forEach((text, index) => {
          const row = document.createElement('div')
          row.dataset.line = String(index + 1); row.dataset.lineIndex = String(index); row.textContent = text
          root.append(row)
        })
        options.onPostRender!(node, { top: 0, getLineHeight: () => 20, reconcileHeights: () => {} } as unknown as PierreFile)
      })
      return <div ref={host} />
    }
  }
})

let selection: { anchorNode: Node | null; anchorOffset: number; focusNode: Node | null; focusOffset: number; setBaseAndExtent: (anchor: Node, anchorOffset: number, focus: Node, focusOffset: number) => void }
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  selection = { anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0, setBaseAndExtent: (anchorNode, anchorOffset, focusNode, focusOffset) => {
    Object.assign(selection, { anchorNode, anchorOffset, focusNode, focusOffset })
  } }
  vi.spyOn(window, 'getSelection').mockImplementation(() => selection as unknown as Selection)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('当前文本预览定位', () => {
  it.each(['./测试.txt:2:3', './测试.txt#L2C3', './测试.txt#L2:C3', './测试.txt#L2:3'])('%s 实际定位第 2 行第 3 列', target => {
    render(<TextPreview text={'第一行\nABCDEFG\n第三行'} name="测试.txt" location={parseFileTarget(target)!.location} />)
    const line = selection.focusNode!.parentElement!
    expect(line.dataset.line).toBe('2')
    expect(selection.focusOffset + 1).toBe(3)
    expect(selection.focusNode!.textContent![selection.focusOffset]).toBe('C')
    expect(screen.getByRole('status')).toHaveTextContent('已定位：第 2 行，第 3 列')
  })
  it('行范围原生选中对应原文，越界列明确提示且不伪造定位', () => {
    const view = render(<TextPreview text={'第一行\nABCDEFG\n第三行'} name="测试.txt" location={{ line: 2, endLine: 3 }} />)
    const range = document.createRange()
    range.setStart(selection.anchorNode!, selection.anchorOffset); range.setEnd(selection.focusNode!, selection.focusOffset)
    expect(range.toString()).toBe('ABCDEFG\n第三行')
    view.rerender(<TextPreview text={'第一行\nABCDEFG\n第三行'} name="测试.txt" location={{ line: 2, column: 99 }} />)
    expect(screen.getByRole('status')).toHaveTextContent('列号超出当前行范围')
    expect(screen.queryByText(/已定位/)).not.toBeInTheDocument()
  })
})
