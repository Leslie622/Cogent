/**
 * 输入区命令与技能实体的共享类型定义。
 * 约束：实体通过编辑器原子节点写入 Draft.entities，纯文本不触发任何命令或技能展开。
 */

/** 编辑器与草稿中占位哨兵字符（与 entities 数组按出现序一一对应） */
export const ENTITY_SENTINEL = '\uFFFC'

export type BuiltinCommandName =
  | 'plan'
  | 'new'
  | 'mode'
  | 'rename'
  | 'settings'
  | 'compact'
  | 'continue'
  | 'init'

export type InsertedCommandName = 'compact' | 'continue' | 'init'

export type ComposerEntity =
  | {
      id: string
      kind: 'skill'
      name: string
      scope: 'user' | 'project' | 'bundled'
      eco?: boolean
    }
  | {
      id: string
      kind: 'command'
      name: InsertedCommandName
      mode: 'standalone' | 'prompt'
    }

export type TriggerKind = '/' | '$'

export interface ActiveTrigger {
  kind: TriggerKind
  /** 去掉前导触发符后的查询文本 */
  query: string
  /** 触发符在当前文本节点中的起始偏移 */
  start: number
  /** 查询串在当前文本节点中的结束偏移（光标位置） */
  end: number
  /** 触发词所在文本节点的 key；Esc 抑制签名用它区分重新输入的新触发词实例，避免同形签名永久拦截 */
  anchorKey?: string
}

export type SlashCommandExecution =
  /** 选中即执行 UI/会话动作：删除触发词，保留已有正文、技能与附件，不自动发送 */
  | { kind: 'action'; action: 'plan' | 'new' | 'mode-ask' | 'mode-auto' | 'mode-autonomous' | 'rename' | 'settings' }
  /** 只能单独发送的会话控制命令：在输入区插入独占命令实体，提交时走专用控制 RPC */
  | { kind: 'standalone'; name: 'compact' | 'continue'; acceptsArgs: boolean }
  /** 可随正文/技能一起发送的 Prompt 型命令：在输入区插入命令实体，提交时随 agent.submit 展开 */
  | { kind: 'prompt'; name: 'init' }

export interface SlashCommandDef {
  id: string
  /** 展示标签，如 /compact、/mode auto */
  label: string
  /** 简短中文说明 */
  description: string
  /** 模糊搜索关键词（含中英文别名） */
  keywords: readonly string[]
  /** 可选参数提示，仅用于面板展示 */
  argumentHint?: string
  /** 标记是否仅支持单独发送，用于在面板中给出明确徽标 */
  standaloneOnly?: boolean
  execution: SlashCommandExecution
}

export interface ComposerSuggestionItem {
  id: string
  group: 'command' | 'skill'
  label: string
  description: string
  /** 右侧来源或行为徽标（如「项目」「用户」「生态」「仅单独发送」「快捷操作」） */
  badge?: string
  argumentHint?: string
  keywords: readonly string[]
  payload:
    | { kind: 'command'; command: SlashCommandDef }
    | { kind: 'skill'; name: string; scope: 'user' | 'project' | 'bundled'; eco?: boolean }
}

export function isComposerEntity(value: unknown): value is ComposerEntity {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Partial<ComposerEntity>
  if (typeof item.id !== 'string' || item.id.length === 0) return false
  if (item.kind === 'skill') {
    return (
      typeof item.name === 'string' &&
      item.name.length > 0 &&
      (item.scope === 'user' || item.scope === 'project' || item.scope === 'bundled') &&
      (item.eco === undefined || typeof item.eco === 'boolean')
    )
  }
  if (item.kind === 'command') {
    return (
      (item.name === 'compact' || item.name === 'continue' || item.name === 'init') &&
      (item.mode === 'standalone' || item.mode === 'prompt')
    )
  }
  return false
}
