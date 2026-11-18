/**
 * interact-tools 单测（交互座 4c-1/2/3）：todo_write / ask_user / plan 闭环的
 * 纯函数面 —— 结果文本格式化、段文本、参数摘要、跨字段校验、三路裁决文本。
 * 工具执行链（桥回调 / customTools 注入 / 段活算 / 挂起收尾）由集成测试钉。
 */
import { describe, expect, it } from 'vitest'
import type { TodoItem } from '../../../src/protocol'
import {
  createAskTool,
  createEnterPlanTool,
  createSubmitPlanTool,
  createTodoTool,
  formatAskResult,
  formatTodoResult,
  planSectionText,
  summarizeAskUserArgs,
  summarizeTodoWriteArgs,
  todosSectionText,
  validateAskQuestions,
  type AskAnswers,
  type AskQuestion
} from '../../../src/host/runtime/interact-tools'

const ITEMS: TodoItem[] = [
  { content: '实现存储层', status: 'in_progress' },
  { content: '写测试', status: 'pending' },
  { content: '调研', status: 'completed' }
]

describe('formatTodoResult（模型 facing 结果文本）', () => {
  it('全量清单 + 计数', () => {
    const text = formatTodoResult(ITEMS)
    expect(text).toContain('共 3 项：1 进行中 / 1 待办 / 1 已完成')
    expect(text).toContain('1. [进行中] 实现存储层')
    expect(text).toContain('2. [待办] 写测试')
    expect(text).toContain('3. [已完成] 调研')
  })

  it('空清单 = 清空文案', () => {
    expect(formatTodoResult([])).toBe('任务清单已清空。')
  })
})

describe('todosSectionText（cogent_todos 段）', () => {
  it('非空清单 → 权威状态段（含条目行）', () => {
    const section = todosSectionText(ITEMS)
    expect(section).toContain('任务清单（当前权威状态）')
    expect(section).toContain('[进行中] 实现存储层')
  })

  it('未全完成 → 不带清空催促（引导只在全完成态出现）', () => {
    expect(todosSectionText(ITEMS)).not.toContain('清空清单')
  })

  it('全部完成 → 段尾追加空数组清空指令（防清单赖着不消）', () => {
    const allDone = ITEMS.map((t) => ({ ...t, status: 'completed' as const }))
    const section = todosSectionText(allDone)
    expect(section).toContain('清单已全部完成')
    expect(section).toContain('todos: []')
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

describe('summarizeAskUserArgs（tool.completed 摘要，2026-11-16 裸 JSON 呈现修）', () => {
  it('questions 数组 → 问题计数（引擎有全量参数，不受 summarizeArgs 60 字截断）', () => {
    const questions = [{ question: 'q1', options: [{ label: 'a' }] }, { question: 'q2', options: [{ label: 'b' }] }]
    expect(summarizeAskUserArgs({ questions })).toBe('ask_user(2 个问题)')
  })

  it('异形/缺参 → 下限 1（工具被调用即至少问了一问）', () => {
    expect(summarizeAskUserArgs(undefined)).toBe('ask_user(1 个问题)')
    expect(summarizeAskUserArgs({ questions: 'x' })).toBe('ask_user(1 个问题)')
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

// ———— plan 闭环（4c-3）————

const PLAN_TEXT = '## 目标\n实现存储层。\n\n## 步骤\n1. 建 schema\n2. 写迁移'

describe('planSectionText（cogent_plan 段）', () => {
  it('方案全文 + 自忽略尾注（误导面由文案封住）', () => {
    const section = planSectionText({ plan: PLAN_TEXT, approvedAt: 0 })
    expect(section).toContain('已批准的计划')
    expect(section).toContain(PLAN_TEXT)
    expect(section).toContain('不再相关')
  })
})

describe('createEnterPlanTool（工具实例）', () => {
  it('无参开开关 + 结果带工作流指引与档位不变说明', async () => {
    const calls: string[] = []
    const tool = createEnterPlanTool({
      enterPlan: () => {
        calls.push('plan')
      }
    })
    const result = await tool.execute('c1', {}, undefined, undefined, {} as never)
    expect(calls).toEqual(['plan'])
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('计划模式（只读）')
    expect(text).toContain('权限档保持不变')
    expect(text).toContain('submit_plan')
  })
})

describe('createSubmitPlanTool（工具实例三路裁决）', () => {
  it('开关未开 → isError 指引（不挂起）', async () => {
    const tool = createSubmitPlanTool({ submitPlan: () => new Promise(() => undefined) }, () => false)
    const result = await tool.execute('c1', { plan: PLAN_TEXT }, undefined, undefined, {} as never)
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('未开启计划模式')
  })

  it('批准 → 结果含退出计划与档位不变说明 + 方案全文', async () => {
    let release: (v: { approved: true }) => void = () => undefined
    const tool = createSubmitPlanTool(
      {
        submitPlan: () =>
          new Promise((resolve) => {
            release = resolve
          })
      },
      () => true
    )
    const pending = tool.execute('c2', { plan: PLAN_TEXT }, undefined, undefined, {} as never)
    release({ approved: true })
    const result = await pending
    expect(result.isError).toBeUndefined()
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('已批准')
    expect(text).toContain('权限档保持不变')
    expect(text).toContain(PLAN_TEXT)
  })

  it('拒绝无反馈 → isError + terminate 停轮', async () => {
    let release: (v: { approved: false; message?: string }) => void = () => undefined
    const tool = createSubmitPlanTool(
      {
        submitPlan: () =>
          new Promise((resolve) => {
            release = resolve
          })
      },
      () => true
    )
    const pending = tool.execute('c3', { plan: PLAN_TEXT }, undefined, undefined, {} as never)
    release({ approved: false })
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.terminate).toBe(true)
    expect((result.content[0] as { text: string }).text).toBe('用户未批准该计划。')
  })

  it('拒绝带反馈 → 反馈进结果、不停轮（修订重提）', async () => {
    let release: (v: { approved: false; message?: string }) => void = () => undefined
    const tool = createSubmitPlanTool(
      {
        submitPlan: () =>
          new Promise((resolve) => {
            release = resolve
          })
      },
      () => true
    )
    const pending = tool.execute('c4', { plan: PLAN_TEXT }, undefined, undefined, {} as never)
    release({ approved: false, message: '第二步先做测试' })
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.terminate).toBeUndefined()
    expect((result.content[0] as { text: string }).text).toContain('用户指示：第二步先做测试')
  })
})
