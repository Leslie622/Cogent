/** ComposerLexicalEditor 触发浮层的真实键盘流回归（ESC 关闭后能否再次唤起）。 */
import { act, fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode
} from 'lexical'
import { ComposerLexicalEditor } from '@/features/home/composer/ComposerLexicalEditor'
import type { ComposerEntity } from '@/features/home/composer/types'

const engineRequest = vi.fn<(method: string, params: unknown) => Promise<unknown>>()

const previousCogent = window.cogent
vi.stubGlobal('cogent', {
  ...previousCogent,
  engineRequest: engineRequest.mockImplementation((method) =>
    Promise.resolve(method === 'skills.list' ? { skills: [] } : method === 'mcp.prompts.list' ? { prompts: [] } : method === 'mcp.resources.list' ? { resources: [], resourceTemplates: [] } : [])
  ),
  onEngineEvent: () => () => {}
})

// jsdom 的 Range 没有布局方法，Lexical 提交选区更新时会调用，补零矩形。
const rect = { bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) }
Range.prototype.getBoundingClientRect = () => rect
Range.prototype.getClientRects = () =>
  ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] })

// jsdom 没有 matchMedia / Element.scrollTo；面板键盘导航滚动用到，空转即可
vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }))
Element.prototype.scrollTo = () => {}

interface Props {
  text?: string
  onChange?: (text: string, entities: ComposerEntity[]) => void
}

const mount = async (props: Props = {}): Promise<HTMLElement> => {
  const { container } = render(
    <ComposerLexicalEditor
      draftId="draft-1"
      text={props.text ?? ''}
      entities={[]}
      disabled={false}
      sendShortcut="enter"
      commandContext={{
        isExistingSession: false,
        hasMessages: false,
        running: false,
        compacting: false,
        truncated: false,
        hasWorkspace: false
      }}
      onChange={props.onChange ?? (() => {})}
      onSend={() => {}}
      onExecuteAction={() => {}}
      onPasteFiles={() => {}}
      onPasteError={() => {}}
    />
  )
  // 冲刷水合提交，避免它与首次输入合并成一次 cogent-hydrate 提交
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return container.querySelector('[contenteditable]') as HTMLElement
}

type LexicalEditorish = {
  update: (fn: () => void, opts?: Record<string, unknown>) => void
}

const editorOf = (el: HTMLElement): LexicalEditorish => {
  const editor = (el as HTMLElement & { __lexicalEditor?: LexicalEditorish }).__lexicalEditor
  if (editor === undefined) throw new Error('lexical editor not attached')
  return editor
}

/** 直接把文本写入编辑器并把光标放到末尾（等价于用户逐字输入后的状态）。 */
const typeInto = (el: HTMLElement, text: string): void => {
  act(() => {
    editorOf(el).update(() => {
      const root = $getRoot()
      root.clear()
      const paragraph = $createParagraphNode()
      paragraph.append($createTextNode(text))
      root.append(paragraph)
      const selection = $getSelection()
      const last = paragraph.getLastChild()
      if ($isRangeSelection(selection) && $isTextNode(last)) {
        const offset = last.getTextContentSize()
        selection.setTextNodeRange(last, offset, last, offset)
      } else {
        paragraph.selectEnd()
      }
    })
  })
}

const panel = (): HTMLElement | null => document.querySelector('[data-composer-suggestion-panel]')
const pressEscape = (el: HTMLElement): void => {
  act(() => { fireEvent.keyDown(el, { key: 'Escape', bubbles: true, cancelable: true }) })
}

describe('composer 触发浮层 ESC 后再唤起', () => {
  it('ESC 关闭后清空输入重新输入 / 能再次唤出浮层', async () => {
    const el = await mount()
    el.focus()
    typeInto(el, '/')
    // 初始唤出
    await act(async () => { await Promise.resolve() })
    expect(panel()).not.toBeNull()

    pressEscape(el)
    await act(async () => { await Promise.resolve() })
    expect(panel()).toBeNull()

    // 模拟用户全选删除后重新输入（选中范围删除走 selection 非折叠分支）
    typeInto(el, '')
    typeInto(el, '/')
    await act(async () => { await Promise.resolve() })
    expect(panel()).not.toBeNull()
  })

  it('ESC 关闭后失焦再聚焦，重新输入 / 能再次唤出浮层', async () => {
    const el = await mount()
    el.focus()
    typeInto(el, '/')
    await act(async () => { await Promise.resolve() })
    expect(panel()).not.toBeNull()

    pressEscape(el)
    await act(async () => { await Promise.resolve() })
    expect(panel()).toBeNull()

    // 点击别处（失焦收起）再点回来，重新输入 /
    act(() => { fireEvent.blur(el) })
    el.focus()
    typeInto(el, '/')
    await act(async () => { await Promise.resolve() })
    expect(panel()).not.toBeNull()
  })

  it('ESC 关闭后继续输入查询词能再次唤出浮层', async () => {
    const el = await mount()
    el.focus()
    typeInto(el, '/')
    await act(async () => { await Promise.resolve() })
    expect(panel()).not.toBeNull()

    pressEscape(el)
    await act(async () => { await Promise.resolve() })
    expect(panel()).toBeNull()

    typeInto(el, '/se')
    await act(async () => { await Promise.resolve() })
    expect(panel()).not.toBeNull()
  })
})
