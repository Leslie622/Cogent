/** 本轮改动列表 UI 组件、store 事件与工作区 diff 标签打开测试。 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileLinkContext } from '@/features/home/files/FileLink'
import { TurnChangesBar } from '@/features/home/files/TurnChangesBar'
import DiffPreview from '@/features/home/files/DiffPreview'
import { useChatStore } from '@/stores/chat'
import { emptyBucket } from '@/stores/chat/store'
import { bindEngineEvents } from '@/stores/chat/events'
import { useWorkspaceStore } from '@/stores/workspace'
import type { EngineEvent } from '@/env.d'
import type { TurnChangesSummary, TurnFileDiff } from '@shared/changes'

vi.mock('@pierre/diffs/react', () => ({
  Virtualizer: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="pierre-virtualizer" className={className}>{children}</div>
  ),
  MultiFileDiff: ({ oldFile, newFile, options }: {
    oldFile: { name: string; contents: string }
    newFile: { name: string; contents: string }
    options: { diffStyle?: string }
  }) => (
    <div data-testid="pierre-multifile-diff" data-diff-style={options.diffStyle}>
      <span>{oldFile.contents}</span>
      <span>{newFile.contents}</span>
    </div>
  )
}))

vi.mock('@/stores/appearance', () => ({
  useIsDarkMode: () => false,
  useAppearanceStore: (selector: (s: { showLineNumbers: boolean; codeWrap: boolean; hoverSlide: boolean }) => unknown) =>
    selector({ showLineNumbers: true, codeWrap: false, hoverSlide: true })
}))

const sampleSummary: TurnChangesSummary = {
  version: 1,
  sessionId: 's1',
  turnId: 't1',
  revision: 1,
  state: 'ready',
  coverage: 'complete',
  totalAdded: 5,
  totalDeleted: 2,
  incompleteCount: 1,
  warnings: [],
  outcome: 'completed',
  items: [
    {
      changeId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      path: 'src/app.ts',
      absolutePath: 'C:/ws/src/app.ts',
      kind: 'modified',
      added: 5,
      deleted: 2,
      source: 'tool'
    },
    {
      changeId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
      path: 'assets/logo.png',
      absolutePath: 'C:/ws/assets/logo.png',
      kind: 'added',
      added: null,
      deleted: null,
      binary: true,
      source: 'workspace'
    }
  ]
}

describe('TurnChangesBar & DiffPreview', () => {
  let listeners: Array<(event: EngineEvent) => void> = []
  let engineRequestMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    listeners = []
    engineRequestMock = vi.fn()
    vi.stubGlobal('cogent', {
      engineRequest: engineRequestMock,
      onEngineEvent: (cb: (event: EngineEvent) => void) => {
        listeners.push(cb)
        return () => { listeners = listeners.filter((x) => x !== cb) }
      }
    })
    useWorkspaceStore.getState().reset()
    useChatStore.setState({
      sessions: [],
      activeSessionId: 's1',
      bySession: {
        s1: { ...emptyBucket(), changes: { t1: sampleSummary } }
      }
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('TurnChangesBar 展示净统计、展开文件列表、点击打开右侧 diff 标签', () => {
    render(
      <FileLinkContext.Provider value={{ sessionId: 's1', turnId: 't1', refs: [] }}>
        <TurnChangesBar />
      </FileLinkContext.Provider>
    )

    const trigger = screen.getByRole('button', { name: /2 个文件已更改/ })
    expect(within(trigger).getByText('2 个文件已更改')).toBeInTheDocument()
    expect(within(trigger).getByText('+5')).toBeInTheDocument()
    expect(within(trigger).getByText('-2')).toBeInTheDocument()
    expect(within(trigger).getByText('1 项未统计')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '查看差异' })).toBeNull()
    expect(screen.getByText('src/app.ts')).not.toBeVisible()

    // 展开文件条目
    fireEvent.click(trigger)
    expect(screen.getByText('src/app.ts')).toBeVisible()
    expect(screen.getByText('assets/logo.png')).toBeVisible()
    expect(screen.getByText('—')).toBeVisible()
    expect(screen.getByRole('button', { name: /^src\/app\.ts\s*修改/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^assets\/logo\.png\s*新增/ })).toBeInTheDocument()

    // 点击条目在工作区打开 diff 标签并去重
    fireEvent.click(screen.getByRole('button', { name: /^src\/app\.ts/ }))
    const scope = useWorkspaceStore.getState().scopes.s1
    expect(scope.collapsed).toBe(false)
    expect(scope.tabs).toHaveLength(1)
    expect(scope.tabs[0]).toMatchObject({ kind: 'diff', changeId: 'aaaaaaaaaaaaaaaaaaaaaaaa', path: 'src/app.ts' })

    fireEvent.click(screen.getByRole('button', { name: /^src\/app\.ts/ }))
    expect(useWorkspaceStore.getState().scopes.s1.tabs).toHaveLength(1)
  })

  it('DiffPreview 加载冻结对比并支持统一/双栏切换及二进制降级', async () => {
    const textDiff: TurnFileDiff = {
      sessionId: 's1',
      turnId: 't1',
      revision: 1,
      changeId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      path: 'src/app.ts',
      absolutePath: 'C:/ws/src/app.ts',
      kind: 'modified',
      added: 1,
      deleted: 1,
      status: 'text',
      beforeExists: true,
      afterExists: true,
      beforeText: 'const a = 1',
      afterText: 'const a = 2'
    }
    engineRequestMock.mockResolvedValueOnce(textDiff)

    useWorkspaceStore.getState().openDiff({
      sessionId: 's1',
      turnId: 't1',
      changeId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      path: 'src/app.ts',
      absolutePath: 'C:/ws/src/app.ts',
      revision: 1
    })
    const tab = useWorkspaceStore.getState().scopes.s1.tabs[0]
    if (tab.kind !== 'diff') throw new Error('expected diff tab')

    render(<DiffPreview tab={tab} active />)
    await waitFor(() => expect(screen.getByTestId('pierre-multifile-diff')).toBeInTheDocument())
    expect(screen.getByTestId('pierre-multifile-diff')).toHaveAttribute('data-diff-style', 'unified')

    // 视图切换两钮之间的悬停滑动：胶囊居首、组容器 relative isolate、两钮都是行，
    // 当前档保留自己的底色类（悬停不改底色，胶囊不停上去）
    const toggle = screen.getByRole('group', { name: '差异视图模式' })
    expect(toggle).toHaveClass('relative', 'isolate')
    expect(toggle.firstElementChild).toHaveClass('hover-slide-pill')
    expect(toggle.querySelectorAll('[data-hover-slide]')).toHaveLength(2)
    expect(screen.getByRole('button', { name: '统一视图' })).toHaveAttribute('data-hover-slide')
    expect(screen.getByRole('button', { name: '统一视图' })).toHaveClass('bg-muted', 'hover:bg-muted')

    fireEvent.click(screen.getByRole('button', { name: '双栏对照' }))
    expect(screen.getByTestId('pierre-multifile-diff')).toHaveAttribute('data-diff-style', 'split')

    fireEvent.click(screen.getByRole('button', { name: /原文件/ }))
    expect(useWorkspaceStore.getState().scopes.s1.tabs.some((t) => t.kind === 'file')).toBe(true)
  })

  it('DiffPreview 非文本超大文件隐藏视图切换并展示紧凑大小比较', async () => {
    const oversizedDiff: TurnFileDiff = {
      sessionId: 's1',
      turnId: 't1',
      revision: 1,
      changeId: 'cccccccccccccccccccccccc',
      path: 'assets/big.bin',
      absolutePath: 'C:/ws/assets/big.bin',
      kind: 'added',
      added: null,
      deleted: null,
      status: 'oversized',
      beforeExists: false,
      afterExists: true,
      afterSize: 22_020_096
    }
    engineRequestMock.mockResolvedValueOnce(oversizedDiff)

    useWorkspaceStore.getState().openDiff({
      sessionId: 's1',
      turnId: 't1',
      changeId: 'cccccccccccccccccccccccc',
      path: 'assets/big.bin',
      absolutePath: 'C:/ws/assets/big.bin',
      revision: 1
    })
    const tab = useWorkspaceStore.getState().scopes.s1.tabs[0]
    if (tab.kind !== 'diff') throw new Error('expected diff tab')

    render(<DiffPreview tab={tab} active />)
    await waitFor(() => expect(screen.getByText('超出单文件大小上限')).toBeInTheDocument())
    expect(screen.queryByRole('group', { name: '差异视图模式' })).toBeNull()
    expect(screen.getByText('不存在')).toBeInTheDocument()
    expect(screen.getByText('21.0 MiB')).toBeInTheDocument()
  })

  it('events.ts 按 revision 单调合并 changes.updated 并记录 changes.error', () => {
    const unbind = bindEngineEvents()
    listeners.forEach((cb) => cb({ method: 'changes.updated', params: { ...sampleSummary, revision: 3 } }))
    expect(useChatStore.getState().bySession.s1?.changes.t1?.revision).toBe(3)

    // 乱序旧 revision 不覆盖
    listeners.forEach((cb) => cb({ method: 'changes.updated', params: { ...sampleSummary, revision: 2 } }))
    expect(useChatStore.getState().bySession.s1?.changes.t1?.revision).toBe(3)

    listeners.forEach((cb) => cb({ method: 'changes.error', params: { sessionId: 's1', turnId: 't2', message: '权限不足' } }))
    expect(useChatStore.getState().bySession.s1?.changeErrors.t2).toBe('权限不足')
    unbind()
  })
})
