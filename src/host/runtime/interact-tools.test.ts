/**
 * interact-tools 单测（交互座 4c-1/4c-2）：todo_write 与 ask_user 的纯函数面
 * —— 结果文本格式化、段文本、参数摘要、跨字段校验。工具执行链（桥回调 /
 * customTools 注入 / 段活算 / 挂起三路收尾）由集成测试钉。
 */
import { describe, expect, it } from 'vitest'
import type { TodoItem } from '../../protocol'
import {
  createAskTool,
  createTodoTool,
  formatAskResult,
  formatTodoResult,
  summarizeTodoWriteArgs,
  todosSectionText,
  validateAskQuestions,
  type AskAnswers,
  type AskQuestion
} from './interact-tools'

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

// ———— ask_user（4c-2）————

const QUESTIONS: AskQuestion[] = [
  {
    question: '用哪个数据库？',
    header: '存储',
    options: [
      { label: 'SQLite', description: '单文件零运维' },
      { label: 'PostgreSQL', description: '生产级' }
    ]
  },
  {
    question: '要哪些附加模块？',
    options: [{ label: '审计日志' }, { label: '导入导出' }, { label: '多语言' }],
    multiSelect: true
  }
]

describe('validateAskQuestions（跨字段校验）', () => {
  it('合法问题集通过', () => {
    expect(validateAskQuestions(QUESTIONS)).toBeUndefined()
  })

  it('重复问题文本拒绝', () => {
    const dup: AskQuestion[] = [
      { question: '同一个问题', options: [{ label: 'A' }, { label: 'B' }] },
      { question: '同一个问题', options: [{ label: 'C' }, { label: 'D' }] }
    ]
    expect(validateAskQuestions(dup)).toContain('唯一')
  })

  it('选项 label 重复拒绝', () => {
    const dup: AskQuestion[] = [
      { question: '问题', options: [{ label: 'A' }, { label: 'A' }] }
    ]
    expect(validateAskQuestions(dup)).toContain('不得重复')
  })

  it('自带「其他」选项拒绝', () => {
    const other: AskQuestion[] = [
      { question: '问题', options: [{ label: 'A' }, { label: '其他' }] }
    ]
    expect(validateAskQuestions(other)).toContain('其他')
  })
})

describe('formatAskResult（答案三态文本）', () => {
  it('全答：问=答 对（多选数组「；」连接）', () => {
    const answers: AskAnswers = ['SQLite', ['审计日志', '导入导出']]
    const text = formatAskResult(QUESTIONS, answers)
    expect(text).toContain('用户已回答你的问题')
    expect(text).toContain('"用哪个数据库？"="SQLite"')
    expect(text).toContain('"要哪些附加模块？"="审计日志；导入导出"')
  })

  it('部分跳过：明示跳过数', () => {
    const text = formatAskResult(QUESTIONS, ['SQLite', ''])
    expect(text).toContain('跳过 1 个')
    expect(text).toContain('"用哪个数据库？"="SQLite"')
  })

  it('全跳过：自行判断文案', () => {
    expect(formatAskResult(QUESTIONS, ['', ''])).toContain('未作答')
  })

  it('取消：基于已有信息继续', () => {
    expect(formatAskResult(QUESTIONS, [], true)).toContain('取消了回答')
  })
})

describe('createAskTool（工具实例）', () => {
  it('非法问题集 → isError 结果（模型自查修正）', async () => {
    const tool = createAskTool({ ask: () => new Promise(() => undefined) })
    const result = await tool.execute(
      'call-1',
      { questions: [{ question: 'q', options: [{ label: '其他' }, { label: 'B' }] }] },
      undefined,
      undefined,
      {} as never
    )
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('其他')
  })

  it('合法问题集 → 挂起桥等作答，答案进结果文本', async () => {
    let release: (value: { answers: AskAnswers; cancelled?: boolean }) => void = () => undefined
    const tool = createAskTool({
      ask: () =>
        new Promise((resolve) => {
          release = resolve
        })
    })
    const pending = tool.execute('call-2', { questions: QUESTIONS }, undefined, undefined, {} as never)
    release({ answers: ['PostgreSQL', ['审计日志']] })
    const result = await pending
    expect(result.isError).toBeUndefined()
    expect((result.content[0] as { text: string }).text).toContain('"PostgreSQL"')
  })
})
