/** 首页与对话的悬停滑动装配：审批 / 计划 / 提问面板的选项行、命令建议面板、项目类型卡、改动列表
 *  文件行、用户消息操作钮。每组一个胶囊在首子位、容器 relative isolate、行带 data-hover-slide、原有
 *  hover 类不动（关掉胶囊即原样）。输入区工具行与截断动作条在 HomeChat 内，见 home-chat.render.test。 */
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyBucket, useChatStore, type PendingApproval, type PendingPlan, type PendingQuestion } from '@/stores/chat'
import { ApprovalPanel } from '@/features/home/ApprovalPanel'
import { PlanPanel } from '@/features/home/PlanPanel'
import { QuestionPanel } from '@/features/home/QuestionPanel'
import { CommandSuggestionPanel } from '@/features/home/composer/CommandSuggestionPanel'
import { ProjectDialog } from '@/features/home/ProjectDialog'
import { FileLinkContext } from '@/features/home/files/FileLink'
import { TurnChangesBar } from '@/features/home/files/TurnChangesBar'
import { MessageRow } from '@/features/home/MessageRow'
import { useProjectStore } from '@/stores/project'
import { useAppearanceStore } from '@/stores/appearance'
import type { TurnChangesSummary } from '@shared/changes'
import type { ComposerSuggestionItem } from '@/features/home/composer/types'

vi.mock('matchMedia', () => vi.fn().mockReturnValue({ matches: false }))
Element.prototype.scrollTo = () => {}

const SID = 's-slide'
const initialState = { ...useChatStore.getState() }
const initialProject = useProjectStore.getState()
beforeEach(() => {
  useChatStore.setState(initialState, true)
  useProjectStore.setState(initialProject, true)
  useAppearanceStore.setState({ hoverSlide: true })
  useChatStore.setState({
    activeSessionId: SID,
    sessions: [],
    bySession: {
      [SID]: {
        ...emptyBucket(),
        pendingApprovals: [{ requestId: 'a1', toolName: 'write_file', toolKind: 'write', summary: 'write(a)' } satisfies PendingApproval],
        pendingPlans: [{ requestId: 'p1', plan: '1. 做事' } satisfies PendingPlan],
        pendingQuestions: [
          {
            requestId: 'q1',
            questions: [{ header: '范围', question: '改哪里？', options: [{ label: '全部' }, { label: '仅入口', description: '只动 index' }], multiSelect: true }]
          } satisfies PendingQuestion
        ]
      }
    }
  })
})

/** 唯一的胶囊及其所在行组 */
function onlyGroup(container: HTMLElement) {
  const pills = container.querySelectorAll('.hover-slide-pill')
  expect(pills).toHaveLength(1)
  const group = pills[0].parentElement
  expect(group).toHaveClass('relative', 'isolate')
  expect(group?.firstElementChild).toBe(pills[0])
  return group as HTMLElement
}

describe('悬停滑动装配（审批 / 计划 / 提问面板）', () => {
  it('ApprovalPanel：三行选项一组；挂载即首行选中（bg-muted），其余行保留 hover:bg-muted/60', () => {
    const { container } = render(<ApprovalPanel />)
    const group = onlyGroup(container)
    const rows = [...group.querySelectorAll<HTMLElement>('[data-hover-slide]')]
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveClass('bg-muted')
    expect(rows[0]).not.toHaveClass('hover:bg-muted/60')
    expect(rows[1]).toHaveClass('hover:bg-muted/60')
    // 行上的过渡读全局时长变量
    expect(rows[1]).toHaveClass('duration-(--hover-transition-duration)')
  })

  it('PlanPanel：两行选项一组，原有 hover 类未动', () => {
    const { container } = render(<PlanPanel />)
    const group = onlyGroup(container)
    const rows = [...group.querySelectorAll<HTMLElement>('[data-hover-slide]')]
    expect(rows).toHaveLength(2)
    expect(rows[1]).toHaveClass('hover:bg-muted/60')
  })

  it('QuestionPanel：选项行 + 「其他」输入行同一组', () => {
    const { container } = render(<QuestionPanel />)
    const group = onlyGroup(container)
    const rows = [...group.querySelectorAll<HTMLElement>('[data-hover-slide]')]
    expect(rows).toHaveLength(3)
    expect(screen.getByPlaceholderText('输入你的回答...').closest('[data-hover-slide]')).toBe(rows[2])
    expect(rows[1]).toHaveClass('hover:bg-muted/75')
  })
})

describe('悬停滑动装配（命令建议 / 项目类型 / 改动列表 / 消息操作钮）', () => {
  it('CommandSuggestionPanel：行组容器是吸顶头所在的列表流容器，候选行都是行', () => {
    const item = (id: string, group: 'command' | 'skill'): ComposerSuggestionItem => ({
      id,
      group,
      label: id,
      description: '',
      keywords: [],
      payload: group === 'skill' ? { kind: 'skill' as const, name: id, scope: 'user' as const } : {
        kind: 'command' as const,
        command: { id, label: id, description: '', keywords: [], execution: { kind: 'prompt' as const, name: 'init' } }
      }
    })
    const { container } = render(
      <CommandSuggestionPanel triggerKind="/" items={[item('/a', 'command'), item('s1', 'skill')]} selectedIndex={0} selectionSource="pointer" onSelectIndex={() => {}} onPick={() => {}} />
    )
    const group = onlyGroup(container)
    const header = container.querySelector('[data-composer-group-header]') as HTMLElement
    expect(header.parentElement).toBe(group)
    const rows = [...group.querySelectorAll<HTMLElement>('[data-hover-slide]')]
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveAttribute('role', 'option')
    expect(rows[0]).toHaveAttribute('aria-selected', 'true')
    // 高亮底色按 selectedIndex 换类（属性只是语义）：静息底色须读未高亮的同组行
    expect(rows[0]).toHaveClass('bg-foreground/[0.075]')
    expect(rows[1]).toHaveClass('hover:bg-foreground/[0.045]')
  })

  it('ProjectDialog：项目类型卡（可选取的）一组；禁选卡不是行（弹窗在 portal 里，从 role 找）', () => {
    render(<ProjectDialog open onOpenChange={() => {}} />)
    const group = screen.getByRole('radiogroup', { name: '项目类型' })
    expect(group).toHaveClass('relative', 'isolate')
    expect(group.firstElementChild).toHaveClass('hover-slide-pill')
    const rows = [...group.querySelectorAll<HTMLElement>('[data-hover-slide]')]
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row).toHaveAttribute('role', 'radio')
    // 未选卡带 hover:bg-muted/70；已选卡（本地）自带 bg-muted、无 hover 类 → 悬停不改底色，胶囊不停上去
    expect(screen.getByRole('radio', { name: /本地/ })).toHaveClass('bg-muted')
    expect(rows.filter((row) => row.classList.contains('hover:bg-muted/70'))).toHaveLength(rows.length - 1)
    // 禁选卡是 div，不是行
    expect(group.querySelector('[aria-disabled][data-hover-slide]')).toBeNull()
  })

  it('TurnChangesBar：文件行一组，行内「打开原文件」钮不是行；保留 hover:bg-muted/60', () => {
    const summary: TurnChangesSummary = {
      version: 1,
      sessionId: SID,
      turnId: 't1',
      revision: 1,
      state: 'ready',
      coverage: 'complete',
      totalAdded: 1,
      totalDeleted: 0,
      incompleteCount: 0,
      warnings: [],
      items: [
        { changeId: 'a'.repeat(24), path: 'src/a.ts', absolutePath: 'C:/ws/src/a.ts', kind: 'modified', added: 1, deleted: 0, source: 'tool' },
        { changeId: 'b'.repeat(24), path: 'src/b.ts', absolutePath: 'C:/ws/src/b.ts', kind: 'added', added: 1, deleted: 0, source: 'tool' }
      ]
    }
    useChatStore.setState({ bySession: { [SID]: { ...emptyBucket(), changes: { t1: summary } } } })
    const { container } = render(
      <FileLinkContext.Provider value={{ sessionId: SID, turnId: 't1', refs: [] }}>
        <TurnChangesBar />
      </FileLinkContext.Provider>
    )
    const group = onlyGroup(container)
    const rows = [...group.querySelectorAll<HTMLElement>('[data-hover-slide]')]
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveClass('hover:bg-muted/60')
    expect(container.querySelector('[data-change-item] [data-hover-slide]')).toBeNull()
  })

  it('MessageRow（用户消息）：复制 / 编辑两钮一组，时间戳不是行', () => {
    const { container } = render(
      <MessageRow message={{ id: 'm1', role: 'user', content: '你好', timestamp: 0 }} />
    )
    const footer = container.querySelector('[data-slot="message-footer"]') as HTMLElement
    expect(footer).toHaveClass('relative', 'isolate')
    expect(footer.firstElementChild).toHaveClass('hover-slide-pill')
    const rows = [...footer.querySelectorAll<HTMLElement>('[data-hover-slide]')]
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual(['复制', '编辑'])
    expect(rows[0].parentElement).toBe(footer)
  })
})

describe('外观「开启滑动动画」关闭', () => {
  it('各处都不渲染胶囊、不留属性', () => {
    useAppearanceStore.setState({ hoverSlide: false })
    const { container } = render(
      <>
        <ApprovalPanel />
        <PlanPanel />
        <QuestionPanel />
        <MessageRow message={{ id: 'm1', role: 'user', content: '你好', timestamp: 0 }} />
      </>
    )
    expect(container.querySelectorAll('.hover-slide-pill')).toHaveLength(0)
    expect(container.querySelectorAll('[data-pill-over]')).toHaveLength(0)
    // 容器类不因装配而变；行上的 data-hover-slide 只是装配标记（无样式依赖、不挂监听）
    expect(container.querySelector('[data-slot="message-footer"]')).not.toHaveClass('relative', 'isolate')
    useAppearanceStore.setState({ hoverSlide: true })
  })
})
