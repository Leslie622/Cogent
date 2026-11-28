/** 资源与提示词经面板变成结构化实体；参数校验、取消和作用域切换保持草稿身份。 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { $createParagraphNode, $createTextNode, $getRoot, type LexicalEditor } from 'lexical'
import { ComposerLexicalEditor, type ComposerLexicalEditorProps } from '@/features/home/composer/ComposerLexicalEditor'
import { prepareComposerSubmission } from '@/features/home/composer/commands'
import { ENTITY_SENTINEL, isComposerEntity, type ComposerEntity } from '@/features/home/composer/types'

const engineRequest = vi.fn<(method: string, params: unknown) => Promise<unknown>>()
const rect = { bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) }
Range.prototype.getBoundingClientRect = () => rect
Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] })
Element.prototype.scrollTo = () => {}

beforeEach(() => {
  engineRequest.mockReset().mockImplementation(method => Promise.resolve(
    method === 'skills.list' ? { skills: [] } : method === 'mcp.resources.list' ? {
      resources: [{ server: 'docs', name: 'guide', uri: 'docs://guide', description: '项目指南' }], resourceTemplates: []
    } : method === 'mcp.prompts.list' ? {
      prompts: [{ server: 'docs', name: 'review', description: '审阅目标', arguments: [
        { name: 'target', description: '要审阅的路径', required: true }, { name: 'style', required: false }
      ] }]
    } : {}
  ))
  vi.stubGlobal('cogent', { ...window.cogent, engineRequest, onEngineEvent: () => () => {} })
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }))
})

function props(overrides: Partial<ComposerLexicalEditorProps> = {}): ComposerLexicalEditorProps {
  return { draftId: 'draft', text: '', entities: [], disabled: false, sendShortcut: 'enter',
    primaryCwd: '/workspace/one', projectId: 'one',
    commandContext: { isExistingSession: false, hasMessages: false, running: false, compacting: false, truncated: false, hasWorkspace: true },
    onChange: () => {}, onSend: () => {}, onExecuteAction: () => {}, onPasteFiles: () => {}, onPasteError: () => {}, ...overrides }
}

async function typeInto(input: HTMLElement, text: string): Promise<void> {
  input.focus()
  await act(async () => {
    const editor = (input as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor
    editor.update(() => {
      const paragraph = $createParagraphNode()
      paragraph.append($createTextNode(text))
      $getRoot().clear().append(paragraph)
      paragraph.selectEnd()
    })
    await Promise.resolve()
  })
}

describe('MCP composer', () => {
  it('@只展示资源，选中后存uri实体并提交可读标签及结构化引用', async () => {
    const onChange = vi.fn<(text: string, entities: ComposerEntity[]) => void>()
    const view = render(<ComposerLexicalEditor {...props({ onChange })} />)
    await act(async () => { await Promise.resolve() })
    const input = view.container.querySelector<HTMLElement>('[contenteditable]')!
    await typeInto(input, '参考 @')
    const option = await screen.findByRole('option', { name: /@docs:guide/ })
    expect(screen.queryByText('/plan')).not.toBeInTheDocument()
    await act(async () => { fireEvent.mouseDown(option); await Promise.resolve() })
    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[1][0]).toMatchObject({ kind: 'mcp-resource', server: 'docs', uri: 'docs://guide' }))
    const [text, entities] = onChange.mock.calls.at(-1)!
    expect(prepareComposerSubmission(text, entities, 0)).toMatchObject({ kind: 'message', text: '参考 @docs:guide', mcpResources: [{ server: 'docs', uri: 'docs://guide' }] })
    expect(engineRequest).toHaveBeenCalledWith('mcp.resources.list', { cwd: '/workspace/one', projectId: 'one' })
  })

  it('/提示词参数必填校验后插入，展开留给Host提交时执行', async () => {
    const onChange = vi.fn<(text: string, entities: ComposerEntity[]) => void>()
    const view = render(<ComposerLexicalEditor {...props({ onChange })} />)
    await act(async () => { await Promise.resolve() })
    await typeInto(view.container.querySelector<HTMLElement>('[contenteditable]')!, '/mcp:docs:review')
    const option = await screen.findByRole('option', { name: /\/mcp:docs:review/ })
    await act(async () => { fireEvent.mouseDown(option); await Promise.resolve() })
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '插入提示词' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('target')
    fireEvent.change(screen.getByLabelText('target（必填）'), { target: { value: 'src/main.ts' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '插入提示词' })); await Promise.resolve() })
    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[1][0]).toMatchObject({ kind: 'mcp-prompt', server: 'docs', name: 'review', arguments: { target: 'src/main.ts' } }))
    const [text, entities] = onChange.mock.calls.at(-1)!
    expect(prepareComposerSubmission(text, entities, 0)).toMatchObject({ text: '/mcp:docs:review', mcpPrompts: [{ server: 'docs', name: 'review', arguments: { target: 'src/main.ts' } }] })
    expect(engineRequest.mock.calls.some(([method]) => method === 'mcp.prompts.get')).toBe(false)
  })

  it('取消参数面板保留原始触发词，不生成实体', async () => {
    const onChange = vi.fn<(text: string, entities: ComposerEntity[]) => void>()
    const view = render(<ComposerLexicalEditor {...props({ onChange })} />)
    await act(async () => { await Promise.resolve() })
    await typeInto(view.container.querySelector<HTMLElement>('[contenteditable]')!, '/mcp:docs:review')
    await act(async () => { fireEvent.mouseDown(screen.getByRole('option', { name: /\/mcp:docs:review/ })); await Promise.resolve() })
    fireEvent.click(await screen.findByRole('button', { name: '取消' }))
    expect(onChange.mock.calls.at(-1)).toEqual(['/mcp:docs:review', []])
  })

  it('切换项目后拒绝旧资源列表的迟到结果', async () => {
    let resolveOld!: (value: unknown) => void
    engineRequest.mockImplementation((method, raw) => {
      if (method !== 'mcp.resources.list') return Promise.resolve({ skills: [] })
      const scope = raw as { projectId: string }
      if (scope.projectId === 'one') return new Promise(resolve => { resolveOld = resolve })
      return Promise.resolve({ resources: [{ server: 'new', name: 'new-guide', uri: 'new://guide' }], resourceTemplates: [] })
    })
    const view = render(<ComposerLexicalEditor {...props()} />)
    await act(async () => { await Promise.resolve() })
    await typeInto(view.container.querySelector<HTMLElement>('[contenteditable]')!, '@')
    view.rerender(<ComposerLexicalEditor {...props({ primaryCwd: '/workspace/two', projectId: 'two' })} />)
    expect(await screen.findByRole('option', { name: /@new:new-guide/ })).toBeInTheDocument()
    await act(async () => { resolveOld({ resources: [{ server: 'old', name: 'old-guide', uri: 'old://guide' }], resourceTemplates: [] }); await Promise.resolve() })
    expect(screen.queryByRole('option', { name: /@old:old-guide/ })).not.toBeInTheDocument()
  })

  it('纯文本不触发MCP引用，草稿实体校验不接受伪造参数形状', () => {
    expect(prepareComposerSubmission('@docs:guide /mcp:docs:review', [], 0)).toEqual({ kind: 'message', text: '@docs:guide /mcp:docs:review', skills: [] })
    expect(isComposerEntity({ id: 'x', kind: 'mcp-prompt', name: 'review', server: 'docs', arguments: ['wrong'] })).toBe(false)
    const resource: ComposerEntity = { id: 'r', kind: 'mcp-resource', name: 'guide', server: 'docs', uri: 'docs://guide' }
    expect(prepareComposerSubmission(ENTITY_SENTINEL, [resource], 0)).toMatchObject({ mcpResources: [{ server: 'docs', uri: 'docs://guide' }] })
  })
})
