/**
 * useProjectScope 测试 —— 钉选择器契约：默认跟随活跃会话归属的项目（项目
 * 会话 summary 不带 cwd 也按 projectId 选中，延续 2026-11-15「项目会话
 * 误判未绑定」回归点的口径）、手动挑过即固定不随会话漂移、选中项目被删
 * 回落用户档、下拉选项 = 本机·用户 + 各项目。
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useChatStore } from '@/stores/chat'
import { useProjectStore } from '@/stores/project'
import { useProjectScope } from './use-project-scope'

describe('useProjectScope', () => {
  beforeEach(() => {
    useChatStore.setState({ sessions: [], activeSessionId: null })
    useProjectStore.setState({
      projects: [
        { id: 'p-1', name: 'skill-test-ws', cwds: ['C:/ws/skill-test'], createdAt: 0 },
        { id: 'p-2', name: 'AxChat4', cwds: ['C:/ws/AxChat4', 'C:/ws/AxChat4-sub'], createdAt: 0 }
      ],
      loaded: true
    })
  })

  const session = (over: Partial<{ id: string; cwd?: string; projectId?: string }>) => ({
    id: over.id ?? 's-1',
    title: '会话',
    createdAt: 0,
    updatedAt: 0,
    ...over
  })

  it('无活跃会话 → 默认用户档', () => {
    const { result } = renderHook(() => useProjectScope())
    expect(result.current.scope).toBe('user')
    expect(result.current.projectCwd).toBeUndefined()
  })

  it('默认跟随活跃会话归属的项目（项目会话无 cwd 也选中）', () => {
    useChatStore.setState({ sessions: [session({ projectId: 'p-2' })], activeSessionId: 's-1' })
    const { result } = renderHook(() => useProjectScope())
    expect(result.current.scope).toBe('project')
    expect(result.current.project?.id).toBe('p-2')
    // cwd = 主根 cwds[0]（多根项目取首根）
    expect(result.current.projectCwd).toBe('C:/ws/AxChat4')
  })

  it('手动挑过即固定，不随会话切换漂移', () => {
    useChatStore.setState({ sessions: [session({ projectId: 'p-2' })], activeSessionId: 's-1' })
    const { result } = renderHook(() => useProjectScope())
    act(() => result.current.pick('p-1'))
    // 切到另一项目的会话：选择保持 p-1
    act(() => {
      useChatStore.setState({ sessions: [session({ id: 's-2', projectId: 'p-2' })], activeSessionId: 's-2' })
    })
    expect(result.current.project?.id).toBe('p-1')
    expect(result.current.projectCwd).toBe('C:/ws/skill-test')
  })

  it('选中的项目被删 → 回落用户档（Select 值同步）', () => {
    const { result } = renderHook(() => useProjectScope())
    act(() => result.current.pick('p-1'))
    act(() => {
      useProjectStore.setState((s) => ({ projects: s.projects.filter((p) => p.id !== 'p-1') }))
    })
    expect(result.current.scope).toBe('user')
    expect(result.current.selectValue).toBe('user')
  })

  it('下拉数据：触发器文案「本机 · X」+ 弹层二级分组（本机/项目）', () => {
    const { result } = renderHook(() => useProjectScope())
    expect(result.current.items).toEqual([
      { value: 'user', label: '本机 · 用户' },
      { value: 'p-1', label: '本机 · skill-test-ws' },
      { value: 'p-2', label: '本机 · AxChat4' }
    ])
    expect(result.current.groups).toEqual([
      { label: '本机', items: [{ value: 'user', label: '用户' }] },
      {
        label: '项目',
        items: [
          { value: 'p-1', label: 'skill-test-ws' },
          { value: 'p-2', label: 'AxChat4' }
        ]
      }
    ])
  })
})
