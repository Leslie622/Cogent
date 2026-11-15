/**
 * 交互座工具定义（阶段 4c，docs/计划/交互座实现.md）—— Host 特有工具
 * （todo_write / ask_user / submit_plan 等）的 pi customTools 注入件。
 *
 * 装配链：本文件只造 ToolDefinition（schema + 行为闭包经 bridge 回调），
 * session.ts 的 buildPiSession 构造实例并传入 factory 的 customTools 透传
 * createAgentSession（agent-session.ts:276）。挂起/状态/持久语义全部住在
 * session.ts（ApprovalBridge 同款手法 —— 本文件不持有会话状态）。
 *
 * 两条边界纪律：
 * - 工具名必须同时进 factory 的 tools 白名单（customTools 同样过
 *   `_isAllowedTool` 过滤，agent-session.ts:3679 —— 不列名 = 注册不激活）；
 * - tool-meta 里 kind='read'（会话内交互，无文件/进程副作用）——审批链
 *   直接放行（plan 档也可用：清单维护/澄清提问正是 plan 工作流的组成）。
 */
import { Type } from 'typebox'
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { TodoItem } from '../../protocol'

// ———— todo_write（4c-1）————

/**
 * 桥：todo 落笔 → 会话状态。工具侧只管 schema 与结果格式化，状态更新/
 * 持久化/北向事件都是 SessionManager 的事（bridge 实现在 buildPiSession）。
 * 返回可异步：后续批次的挂起类工具（ask_user/submit_plan）同缝复用。
 */
export interface TodoBridge {
  updateTodos(todos: TodoItem[]): void | Promise<void>
}

const TODO_STATUS_LABEL: Record<TodoItem['status'], string> = {
  pending: '待办',
  in_progress: '进行中',
  completed: '已完成'
}
const TODO_PRIORITY_LABEL: Record<TodoItem['priority'], string> = {
  high: '高',
  medium: '中',
  low: '低'
}

/** 单行条目：`[状态][优先级] 内容`（结果文本与 cogent_todos 段共用形状） */
function todoLine(item: TodoItem, index: number): string {
  return `${index + 1}. [${TODO_STATUS_LABEL[item.status]}][${TODO_PRIORITY_LABEL[item.priority]}] ${item.content}`
}

function todoCounts(todos: TodoItem[]): string {
  const by = (s: TodoItem['status']) => todos.filter((t) => t.status === s).length
  return `共 ${todos.length} 项：${by('in_progress')} 进行中 / ${by('pending')} 待办 / ${by('completed')} 已完成`
}

/**
 * 工具结果文本（模型 facing）：全量清单 + 计数。转录回放即状态恢复的
 * 数据源 —— 恢复会话的模型从历史里就能看到最后清单（双通道之一，
 * 另一条是 cogent_todos 段）。
 */
export function formatTodoResult(todos: TodoItem[]): string {
  if (todos.length === 0) return '任务清单已清空。'
  return `任务清单已更新（${todoCounts(todos)}）：\n${todos.map(todoLine).join('\n')}`
}

/**
 * cogent_todos 段文本（每回合活算；空清单 = null = 撤段）。
 * 模型可能在长对话/压缩后忘记清单 —— 段是权威状态的常驻提醒
 * （zcode todo_reminder 对应物，diff 净变更不堆积）。
 */
export function todosSectionText(todos: TodoItem[]): string | null {
  if (todos.length === 0) return null
  return (
    '# 任务清单（当前权威状态）\n' +
    '以下是你此前用 todo_write 记录的任务清单，按它推进；状态变化时用 todo_write 提交全量更新：\n' +
    todos.map(todoLine).join('\n')
  )
}

const TODO_DESCRIPTION =
  '维护本会话的任务清单。每次调用提交完整清单（全量替换，不是增量 patch）：新增任务、' +
  '开始做某项时置 in_progress、做完置 completed，一次调用可同时改多项。' +
  '尽量保持只有一项 in_progress；全部完成时提交空数组清空清单。' +
  '清单对你和用户都可见，用它跟踪多步骤任务的进度。'

const TODO_PARAMS = Type.Object({
  todos: Type.Array(
    Type.Object({
      content: Type.String({ description: '任务简述（一行）' }),
      status: Type.Union([Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed')]),
      priority: Type.Union([Type.Literal('high'), Type.Literal('medium'), Type.Literal('low')])
    }),
    { description: '完整任务清单（全量替换当前清单）' }
  )
})

/**
 * todo_write 工具实例（bridge 闭包捕获会话；schema 校验由 pi 工具管线负责）。
 * defineTool 包装是 pi 官方姿势：经数组（customTools）传递时保住参数推断、
 * 类型不放宽到 unknown（extensions/types.ts:705-712 注释原话）
 */
export function createTodoTool(bridge: TodoBridge): ToolDefinition {
  return defineTool({
    name: 'todo_write',
    label: '任务清单',
    description: TODO_DESCRIPTION,
    parameters: TODO_PARAMS,
    execute: async (_callId, params) => {
      await bridge.updateTodos(params.todos)
      return {
        content: [{ type: 'text', text: formatTodoResult(params.todos) }],
        details: { todos: params.todos }
      }
    }
  })
}

/** tool-meta 的参数摘要：todo_write(todos 数组) → 计数一行（与 summarizeArgs 同契约：展示用宽松形状） */
export function summarizeTodoWriteArgs(args: unknown): string {
  const todos = typeof args === 'object' && args !== null ? (args as { todos?: unknown }).todos : undefined
  if (!Array.isArray(todos)) return 'todo_write()'
  return `todo_write(${todoCounts(todos as TodoItem[])})`
}

// ———— ask_user（4c-2）————

/** ask_user 的问题/选项形状（schema Static 的手工镜像，协议层共用） */
export interface AskOption {
  label: string
  description?: string
}
export interface AskQuestion {
  question: string
  header?: string
  options: AskOption[]
  multiSelect?: boolean
}
/** 每问答案：字符串（单选/自由输入）；多选 = 数组；空串 = 跳过未答 */
export type AskAnswers = Array<string | string[]>

/**
 * 桥：ask_user 挂起 → 宿主作答。session.ts 登记 pendingQuestions + 发
 * question.asked 事件，Promise 悬到 question.respond / abort / 会话收尾
 *（pendingApprovals 同款三路收尾）。
 */
export interface AskBridge {
  ask(questions: AskQuestion[], signal: AbortSignal | undefined): Promise<{ answers: AskAnswers; cancelled?: boolean }>
}

/**
 * schema 之外的跨字段校验（TypeBox 表达不了唯一性）：问题文本唯一、选项
 * label 唯一、不得自带「其他/Other」（面板自动提供自由输入，zcode 72-89
 * 同款）。违规文案直接给模型（isError 结果，模型自查修正后重调）。
 */
export function validateAskQuestions(questions: AskQuestion[]): string | undefined {
  const seenQuestions = new Set<string>()
  for (const q of questions) {
    if (seenQuestions.has(q.question)) return `问题文本必须唯一，重复了：「${q.question}」。`
    seenQuestions.add(q.question)
    const labels = new Set<string>()
    for (const option of q.options) {
      if (labels.has(option.label)) return `同问题的选项 label 不得重复：「${q.question}」的「${option.label}」。`
      labels.add(option.label)
      if (option.label === '其他' || option.label === 'Other') {
        return `不要提供「其他」选项（「${q.question}」）—— 面板会自动附带自由输入。`
      }
    }
  }
  return undefined
}

/**
 * 答案 → 模型 facing 结果文本（zcode handlers:131-158 三态风格）：
 * 取消 / 全跳过 / 部分跳过 / 全答。多选数组以「；」连接。
 */
export function formatAskResult(questions: AskQuestion[], answers: AskAnswers, cancelled?: boolean): string {
  if (cancelled === true) return '用户取消了回答。请基于已有信息继续，或在回复中说明仍需要哪些输入。'
  const pairs: string[] = []
  let skipped = 0
  questions.forEach((q, i) => {
    const answer = answers[i] ?? ''
    const text = Array.isArray(answer) ? answer.join('；') : answer
    if (text.trim() === '') {
      skipped++
      return
    }
    pairs.push(`"${q.question}"="${text}"`)
  })
  if (pairs.length === 0) return '用户未作答（跳过了全部问题）。请自行判断并继续。'
  const prefix = skipped > 0 ? `用户回答了部分问题（跳过 ${skipped} 个）：` : '用户已回答你的问题：'
  return `${prefix}${pairs.join('；')}。`
}

const ASK_DESCRIPTION =
  '当你被用户的决策卡住、无法合理继续时，向用户提出结构化问题（每问 2-4 个选项）。' +
  '只问真正需要人拍板的事；一次性问全（最多 4 问），不要连环追问。' +
  '选项不带「其他」—— 用户总能自由输入。非阻塞问题改在回复正文里问。'

const ASK_PARAMS = Type.Object({
  questions: Type.Array(
    Type.Object({
      question: Type.String({ description: '问题全文' }),
      header: Type.Optional(Type.String({ description: '问题短标签（≤12 字符）', maxLength: 12 })),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: '选项标签（1-5 个词）' }),
          description: Type.Optional(Type.String({ description: '选项说明（一句话）' }))
        }),
        { minItems: 2, maxItems: 4, description: '2-4 个选项' }
      ),
      multiSelect: Type.Optional(Type.Boolean({ description: '多选（缺省单选）' }))
    }),
    { minItems: 1, maxItems: 4, description: '1-4 个问题' }
  )
})

/** ask_user 工具实例（挂起在 bridge.ask；signal abort → cancelled 收口） */
export function createAskTool(bridge: AskBridge): ToolDefinition {
  return defineTool({
    name: 'ask_user',
    label: '向用户提问',
    description: ASK_DESCRIPTION,
    parameters: ASK_PARAMS,
    execute: async (_callId, params, signal) => {
      const violation = validateAskQuestions(params.questions)
      if (violation !== undefined) {
        return { content: [{ type: 'text', text: violation }], details: { questions: params.questions }, isError: true }
      }
      const { answers, cancelled } = await bridge.ask(params.questions, signal)
      return {
        content: [{ type: 'text', text: formatAskResult(params.questions, answers, cancelled) }],
        details: { questions: params.questions, answers, ...(cancelled === true && { cancelled: true }) }
      }
    }
  })
}

// ———— plan 闭环（4c-3：enter_plan + submit_plan）————

/** submit_plan 的方案文本上限（zcode PLAN_MODE_MAX_PLAN_CHARS 同值，plan-mode.ts:13） */
export const PLAN_MAX_CHARS = 20_000

/** 已批准计划的会话域记录（StoredSession.plan；cogent_plan 段的数据源） */
export interface PlanRecord {
  plan: string
  /** 批准时刻（Unix 毫秒） */
  approvedAt: number
}

/** 桥：enter_plan 切档（幂等 —— 已在此档直接成功）。返回可异步：与 TodoBridge 同款 */
export interface EnterPlanBridge {
  enterPlan(): void | Promise<void>
}

/** 桥：submit_plan 挂起审批（pendingPlans 同 pendingQuestions 骨架，批准路径
 * 多一步切档 + plan 落账）。verdict 三路 —— approve（含目标档）/ deny（附反馈或无） */
export interface SubmitPlanBridge {
  submitPlan(
    plan: string,
    signal: AbortSignal | undefined
  ): Promise<{ approved: true; switchMode?: string } | { approved: false; message?: string }>
}

/** cogent_plan 段文本（每回合活算；null = 无已批准计划 = 撤段）。
 * 自带"已完成或不再相关则忽略"（zcode plan 文件提醒同款语义，文案封住误导面） */
export function planSectionText(record: PlanRecord): string {
  return (
    '# 已批准的计划\n' +
    '以下计划已经用户批准，按它推进执行：\n\n' +
    record.plan +
    '\n\n若其中的任务已全部完成或计划不再相关，忽略本节。'
  )
}

const ENTER_PLAN_DESCRIPTION =
  '进入 plan（只读）模式：文件写入与命令执行将被拒绝，只能调研（读文件/搜索/列目录）。' +
  '适用于非平凡的多步骤实现任务 —— 先调研并把实现方案整理成计划，再调 submit_plan 请求批准。' +
  '纯问答、小修复、只读调研不需要进 plan。'

const ENTER_PLAN_PARAMS = Type.Object({})

const SUBMIT_PLAN_DESCRIPTION =
  '提交实现计划请求用户批准（只能在 plan 模式下使用）。计划必须完整放在 plan 参数：' +
  '上下文开头、只写推荐方案、点名关键文件、含验证步骤。用户批准后会自动切换到执行模式；' +
  '拒绝时可能附修改意见（按意见修订后重新提交）。不要用普通文本或 ask_user 问"这个方案行吗" —— 那正是本工具的职责。'

const SUBMIT_PLAN_PARAMS = Type.Object({
  plan: Type.String({ minLength: 1, maxLength: PLAN_MAX_CHARS, description: '完整的实现计划（markdown）' })
})

/** enter_plan 工具实例（无参；切档幂等） */
export function createEnterPlanTool(bridge: EnterPlanBridge): ToolDefinition {
  return defineTool<typeof ENTER_PLAN_PARAMS, Record<string, never>>({
    name: 'enter_plan',
    label: '进入计划模式',
    description: ENTER_PLAN_DESCRIPTION,
    parameters: ENTER_PLAN_PARAMS,
    execute: async () => {
      await bridge.enterPlan()
      return {
        content: [
          {
            type: 'text',
            text:
              '已进入 plan（只读）模式：文件写入与命令执行会被拒绝。' +
              '接下来只调研（读文件/搜索/列目录），完成后调 submit_plan 提交实现计划；' +
              '调研中遇到需要用户拍板的疑点可用 ask_user 澄清。'
          }
        ],
        details: {}
      }
    }
  })
}

/** submit_plan 工具实例（非 plan 档 → isError 指引；挂起审批三路收口） */
export function createSubmitPlanTool(
  bridge: SubmitPlanBridge,
  /** 读活模式（非 plan 档拒绝的判定源；session.summary 活引用） */
  currentMode: () => string
): ToolDefinition {
  return defineTool<
    typeof SUBMIT_PLAN_PARAMS,
    { plan: string; switchMode?: string; approved?: boolean }
  >({
    name: 'submit_plan',
    label: '提交计划',
    description: SUBMIT_PLAN_DESCRIPTION,
    parameters: SUBMIT_PLAN_PARAMS,
    execute: async (_callId, params, signal) => {
      if (currentMode() !== 'plan') {
        return {
          content: [
            {
              type: 'text',
              text:
                '当前不在 plan 模式 —— 本工具仅用于 plan 模式下完成调研后提交实现计划。' +
                '若计划已获批准，直接继续执行即可。'
            }
          ],
          details: { plan: params.plan, approved: false },
          isError: true
        }
      }
      const verdict = await bridge.submitPlan(params.plan, signal)
      if (verdict.approved) {
        const modeLabel: Record<string, string> = {
          ask: '变更前确认（ask）',
          auto: '完全访问（auto）',
          autonomous: '自主模式（autonomous）'
        }
        return {
          content: [
            {
              type: 'text',
              text:
                `用户已批准你的计划，并将会话切换到 ${modeLabel[verdict.switchMode ?? 'ask']} 模式。` +
                '现在开始执行 —— 建议先用 todo_write 把计划拆成任务清单，再逐步实施。\n\n' +
                `## 已批准的计划：\n${params.plan}`
            }
          ],
          details: { plan: params.plan, switchMode: verdict.switchMode, approved: true }
        }
      }
      // 拒绝无反馈 → 停轮（terminate：拒绝代表用户要继续讨论，模型自我重写
      // 计划只会空转 —— zcode stopTurnAfterResult 同判）；带反馈 → 模型修订重提
      const denied = '用户未批准该计划。'
      const message = verdict.message?.trim()
      const noFeedback = message === undefined || message === ''
      return {
        content: [{ type: 'text', text: noFeedback ? denied : `${denied}用户指示：${message}` }],
        details: { plan: params.plan, approved: false },
        isError: true,
        ...(noFeedback && { terminate: true })
      }
    }
  })
}

// ———— 声明镜像（token 估算用，与请求里 toolsAdded 同源）————

/** 交互座工具的模型侧声明（tool-meta.toolDeclarations 消费；schema 确定性同源） */
export function interactToolDeclarations(): Array<{ name: string; description: string; parameters: unknown }> {
  return [
    { name: 'todo_write', description: TODO_DESCRIPTION, parameters: TODO_PARAMS },
    { name: 'ask_user', description: ASK_DESCRIPTION, parameters: ASK_PARAMS },
    { name: 'enter_plan', description: ENTER_PLAN_DESCRIPTION, parameters: ENTER_PLAN_PARAMS },
    { name: 'submit_plan', description: SUBMIT_PLAN_DESCRIPTION, parameters: SUBMIT_PLAN_PARAMS }
  ]
}
