/**
 * interact-tools 单测（交互座 4c-1）：todo_write 的纯函数面 —— 结果文本
 * 格式化（清单 + 计数 + 清空）、cogent_todos 段文本（空清单 = null 撤段）、
 * 参数摘要。工具执行链（桥回调 / customTools 注入 / 段活算）由集成测试钉。
 */
import { describe, expect, it } from 'vitest'
import type { TodoItem } from '../../protocol'
import { createTodoTool, formatTodoResult, summarizeTodoWriteArgs, todosSectionText } from './interact-tools'

const ITEMS: TodoItem[] = [
  { content: '实现存储层', status: 'in_progress', priority: 'high' },
  { content: '写测试', status: 'pending', priority: 'medium' },
  { content: '调研', status: 'completed', priority: 'low' }
]

describe('formatTodoResult（模型 facing 结果文本）', () => {
  it('全量清单 + 计数', () => {
    const text = formatTodoResult(ITEMS)
    expect(text).toContain('共 3 项：1 进行中 / 1 待办 / 1 已完成')
    expect(text).toContain('1. [进行中][高] 实现存储层')
    expect(text).toContain('2. [待办][中] 写测试')
    expect(text).toContain('3. [已完成][低] 调研')
  })

  it('空清单 = 清空文案', () => {
    expect(formatTodoResult([])).toBe('任务清单已清空。')
  })
})

describe('todosSectionText（cogent_todos 段）', () => {
  it('非空清单 → 权威状态段（含条目行）', () => {
    const section = todosSectionText(ITEMS)
    expect(section).toContain('任务清单（当前权威状态）')
    expect(section).toContain('[进行中][高] 实现存储层')
  })

  it('空清单 → null（撤段语义）', () => {
    expect(todosSectionText([])).toBeNull()
  })
})

describe('summarizeTodoWriteArgs（tool.completed 摘要）', () => {
  it('计数一行', () => {
    expect(summarizeTodoWriteArgs({ todos: ITEMS })).toBe('todo_write(共 3 项：1 进行中 / 1 待办 / 1 已完成)')
  })

  it('非数组形状 → 裸名（与 summarizeArgs 同契约）', () => {
    expect(summarizeTodoWriteArgs(undefined)).toBe('todo_write()')
    expect(summarizeTodoWriteArgs({ todos: 'x' })).toBe('todo_write()')
  })
})

describe('createTodoTool（工具实例）', () => {
  it('execute 走桥并返回格式化结果', async () => {
    const seen: TodoItem[][] = []
    const tool = createTodoTool({
      updateTodos: (todos) => {
        seen.push(todos)
      }
    })
    expect(tool.name).toBe('todo_write')
    const result = await tool.execute('call-1', { todos: ITEMS }, undefined, undefined, {} as never)
    expect(seen).toEqual([ITEMS])
    expect(result.content[0]).toEqual({ type: 'text', text: formatTodoResult(ITEMS) })
    expect(result.isError).toBeUndefined()
  })
})
