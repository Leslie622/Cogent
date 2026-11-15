/**
 * TodoStrip 组件测试（RTL + jsdom，形状同 turn-group.render.test.tsx）——
 * 钉「无清单会话挂载不触发 useSyncExternalStore 死循环」：
 * 选择器 `?? []` 字面量回退时每次快照都是新数组，React 判定 store 恒变 →
 * Maximum update depth exceeded（2026-11-15 冒烟翻车，修复 = EMPTY_TODOS
 * 模块级常量，约定.md §1.2 反模式 8）。死循环在测试 renderer 同样表现为
 * render 抛错，本件挂载即守。附带一条有清单的正向渲染。
 */
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useChatStore } from '@/stores/chat'
import { TodoStrip } from './TodoStrip'
import type { TodoItem } from '@/env.d'

const SID = 's-todo-strip'
const initialState = { ...useChatStore.getState() }
beforeEach(() => {
  useChatStore.setState(initialState, true)
})

const todo = (content: string, status: TodoItem['status']): TodoItem => ({
  content,
  status,
  priority: 'medium'
})

describe('TodoStrip 挂载稳定性（快照引用回归）', () => {
  it('有活动会话但无清单：挂载即渲染 null，不触发无限重渲染（`?? []` 死循环回归钉）', () => {
    useChatStore.setState({ activeSessionId: SID, todosBySession: {} })
    const { container } = render(<TodoStrip />)
    // 空清单不挂载条本体；修复前此 render 以 Maximum update depth exceeded 抛错
    expect(container).toBeEmptyDOMElement()
  })

  it('无活动会话（新聊天着陆）：同样安全挂载为 null', () => {
    useChatStore.setState({ activeSessionId: null })
    const { container } = render(<TodoStrip />)
    expect(container).toBeEmptyDOMElement()
  })

  it('有清单：渲染标题与条目，完成计数可见', () => {
    useChatStore.setState({
      activeSessionId: SID,
      todosBySession: {
        [SID]: [todo('读参考实现', 'completed'), todo('写回归测试', 'in_progress')]
      }
    })
    render(<TodoStrip />)
    expect(screen.getByText('任务清单')).toBeInTheDocument()
    expect(screen.getByText('1/2')).toBeInTheDocument()
    expect(screen.getByText('读参考实现')).toBeInTheDocument()
    expect(screen.getByText('写回归测试')).toBeInTheDocument()
  })
})
