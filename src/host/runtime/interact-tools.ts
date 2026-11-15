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

// ———— 声明镜像（token 估算用，与请求里 toolsAdded 同源）————

/** 交互座工具的模型侧声明（tool-meta.toolDeclarations 消费；schema 确定性同源） */
export function interactToolDeclarations(): Array<{ name: string; description: string; parameters: unknown }> {
  return [{ name: 'todo_write', description: TODO_DESCRIPTION, parameters: TODO_PARAMS }]
}
