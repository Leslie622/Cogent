/**
 * 会话盘上文档形状与启动恢复校验：v2 只存会话域 summary，v1 保留旧转录等惰性导入。
 * 从 session.ts 拆出以收敛 SessionManager 职责（数据反序列化与版本迁移归本模块）。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { SessionSummary, TodoItem } from '../../protocol'
import type { PlanRecord } from './interact-tools'

/** 盘上文档格式版本（v2 = summary-only；v1 兼容读取，见 asStoredSession） */
export const SESSION_FILE_VERSION = 2
/** 会话集合名（StorageDriver 顶层目录 ~/.cogent/sessions/） */
export const SESSION_COLLECTION = 'sessions'

export interface StoredSession {
  deleted?: true
  autoTitle?: 'ready' | 'attempted'
  piCwd?: string
  version: 1 | 2
  transcript?: AgentMessage[]
  summary: SessionSummary
  /** 任务清单（交互座 4c）：todo_write 的活清单快照；缺省 = 无清单。模型侧另有转录回放兜底 */
  todos?: TodoItem[]
  /** 已批准计划（交互座 4c-3）：cogent_plan 段的数据源；缺省 = 无。新批准覆盖旧值 */
  plan?: PlanRecord
}

export interface ParsedStoredSession {
  summary: SessionSummary
  autoTitle?: 'ready' | 'attempted'
  piCwd?: string
  todos?: TodoItem[]
  plan?: PlanRecord
  legacyTranscript?: AgentMessage[]
}

/**
 * 启动恢复时的盘上数据收窄（信任边界：磁盘旧数据可能被手改/属旧版本格式）。
 * v1 带完整转录 —— 收进 legacyTranscript 等惰性导入 pi 树；v2 只有 summary。
 */
export function asStoredSession(doc: unknown, id: string): ParsedStoredSession {
  if (typeof doc !== 'object' || doc === null) throw new Error(`会话文档形状不合法（sessions/${id}.json）`)
  const d = doc as {
    version?: unknown
    autoTitle?: unknown
    piCwd?: unknown
    summary?: SessionSummary
    todos?: unknown
    plan?: unknown
    transcript?: unknown
  }
  if (d.version !== 2 && d.version !== 1) {
    throw new Error(`会话文档版本不合法（sessions/${id}.json），请手工处理后重启`)
  }
  if (d.piCwd !== undefined && typeof d.piCwd !== 'string') throw new Error(`会话内核 cwd 损坏（sessions/${id}.json）`)
  if (d.autoTitle !== undefined && d.autoTitle !== 'ready' && d.autoTitle !== 'attempted') {
    throw new Error(`会话标题资格损坏（sessions/${id}.json）`)
  }
  if (typeof d.summary?.id !== 'string') {
    throw new Error(`会话文档形状不合法（sessions/${id}.json），请手工处理后重启`)
  }
  if (d.version === 1 && !Array.isArray(d.transcript)) {
    throw new Error(`会话文档转录形状不合法（sessions/${id}.json），请手工处理后重启`)
  }
  if (d.todos !== undefined && !Array.isArray(d.todos)) {
    throw new Error(`会话文档任务清单形状不合法（sessions/${id}.json），请手工处理后重启`)
  }
  if (d.plan !== undefined && (typeof d.plan !== 'object' || typeof (d.plan as PlanRecord).plan !== 'string')) {
    throw new Error(`会话文档计划形状不合法（sessions/${id}.json），请手工处理后重启`)
  }
  // v2 盘 plan 档迁移（正交开关 v3）：plan 曾是档位联合值，原档已被覆盖无从
  // 考据 → 回 ask 缺省 + 开关开（行为保真：只读约束不丢）。
  const summary = { ...d.summary }
  if ((d.summary.permissionMode as string) === 'plan') {
    summary.permissionMode = 'ask'
    summary.planEnabled = true
  }
  return {
    summary,
    ...(d.autoTitle !== undefined && { autoTitle: d.autoTitle }),
    ...(d.piCwd !== undefined && { piCwd: d.piCwd }),
    ...(d.todos !== undefined && { todos: d.todos as TodoItem[] }),
    ...(d.plan !== undefined && { plan: d.plan as PlanRecord }),
    ...(d.version === 1 && { legacyTranscript: d.transcript as AgentMessage[] })
  }
}
