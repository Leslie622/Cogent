/**
 * 工具注册表（路线空位 #2 本体，计划-工具系统与审批.md）。
 *
 * pi 的 AgentTool 只有 name/description/parameters/execute —— 没有"风险类别"。
 * 审批矩阵（ToolKind × permissionMode）是 Cogent 的产品语义，所以在引擎侧
 * 包一层 CogentTool：{ tool, kind, summarize }。summarize 把参数压成一行
 * （工具卡标题 + 审批卡文案共用），转译层与 beforeToolCall 判定都从这里取。
 *
 * 边界纪律（D2）：buildTools(roots) 按会话工作区根现建工具实例（边界在
 * 闭包里），无根会话返回空数组 = 纯聊天（不注册任何工具，模型无从调用）。
 */
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { ToolKind } from '../../protocol'
import { createReadTool } from './read'
import { createGlobTool } from './glob'
import { createGrepTool } from './grep'

/** Cogent 侧工具包装：pi 声明 + 产品语义（风险类别 + 参数摘要） */
export interface CogentTool {
  tool: AgentTool
  kind: ToolKind
  /** 参数 → 一行摘要（如 `read("src/index.ts")`）；UI 卡标题与审批文案共用 */
  summarize: (args: unknown) => string
}

/** JSON.stringify 的摘要素写：参数对象 → `k1, k2=v2` 一行（值截断防长路径刷屏） */
export function summarizeArgs(name: string, args: unknown): string {
  if (typeof args !== 'object' || args === null) return `${name}()`
  const parts = Object.values(args).map((value) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return text.length > 60 ? `${text.slice(0, 60)}…` : text
  })
  return `${name}(${parts.join(', ')})`
}

/**
 * 静态元数据表：工具名 → { kind, 摘要 }。kind 与摘要不随 roots 变化，
 * 独立成表是因为历史回查投影（toChatMessages）在 Agent 未实例化的会话上
 * 也要用（惰性会话只有转录），那时没有活工具实例可查。
 */
const TOOL_METAS: Record<string, { kind: ToolKind; summarize: (args: unknown) => string }> = {
  read: { kind: 'read', summarize: (a) => summarizeArgs('read', a) },
  glob: { kind: 'read', summarize: (a) => summarizeArgs('glob', a) },
  grep: { kind: 'read', summarize: (a) => summarizeArgs('grep', a) }
}

/** 工具名 → 元数据；未注册工具（盘上旧转录里的历史名）返回 undefined */
export function toolMeta(name: string): { kind: ToolKind; summarize: (args: unknown) => string } | undefined {
  return TOOL_METAS[name]
}

/**
 * 按会话工作区根构建工具集。每工具一行：工厂 + kind（与 TOOL_METAS 对齐）。
 * 新增工具 = 加文件 + 工厂行 + TOOL_METAS 行（write/exec 批次见计划 D1）。
 */
export function buildTools(roots: string[]): CogentTool[] {
  if (roots.length === 0) return []
  return [
    { tool: createReadTool(roots), ...TOOL_METAS.read },
    { tool: createGlobTool(roots), ...TOOL_METAS.glob },
    { tool: createGrepTool(roots), ...TOOL_METAS.grep }
  ]
}
