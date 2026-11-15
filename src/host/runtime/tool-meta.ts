/**
 * 工具名策略 + 静态元数据表（Cogent 侧投影）。
 *
 * pi 的 AgentTool 不带"风险类别"（内置 8 工具均未设 annotations，D8 勘误：
 * ToolAnnotations 作审批分级输入的上游前提不成立）——ToolKind 是 Cogent 的
 * 产品语义 + 协议兼容投影（tool.* 事件与 ToolCallRecord 都带 kind），本表是
 * 唯一 kind 源。静态表而非活工具实例的原因：历史回查投影（toChatMessages）
 * 在未装配内核的惰性会话上也要用（那时没有工具实例可查）。
 *
 * 命名映射：v1 旧转录的 glob → pi find；bash 在 Windows 由
 * powershell 替代（D6：无 Git Bash 的 win 机不再依赖系统 bash）。
 * glob 名保留为历史条目 —— v1 旧转录里有它的 toolCall 块。
 */
import { platform } from 'node:os'
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createPowerShellTool,
  createReadTool,
  createWriteTool
} from '@earendil-works/pi-coding-agent'
import { interactToolDeclarations, summarizeTodoWriteArgs } from './interact-tools'
import type { ToolKind } from '../../protocol'

/** 当前平台的 shell 工具名（allowlist 与元数据表共用） */
export const SHELL_TOOL_NAME = platform() === 'win32' ? 'powershell' : 'bash'

/**
 * 会话工具集（pi 内置 8 选 7）：createAgentSession 的 tools allowlist ——
 * 显式列表替换 pi 默认（read/bash/edit/write），保证平台差异只体现在
 * shell 一项上，其余六件跨平台同形。
 */
export const COGENT_TOOL_NAMES: string[] = [
  'read',
  SHELL_TOOL_NAME,
  'edit',
  'write',
  'grep',
  'find',
  'ls'
]

/**
 * MCP 工具的 allowlist 追加项（阶段 4a）：pi 的 `tools` 显式列表会过滤
 * 扩展注册的工具 —— 未列名的 direct MCP 工具注册但不激活（agent-session.js
 * `_isActivatable`：allowlist 不匹配的 mcp__ 名只有非 direct 档才可激活）。
 * `mcp__*` 通配放行全部 server 工具；资源三件（pi extensions/mcp/resources
 * 按带资源 server 的 exposure 注册）单独列名 —— 它们不带 mcp__ 前缀。
 */
export const MCP_TOOL_ALLOWLIST: string[] = [
  'mcp__*',
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource'
]

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
 * 静态元数据表：工具名 → { kind, 摘要 }。kind 与摘要不随会话变化。
 * 历史条目（glob）只为旧转录投影服务，不在 COGENT_TOOL_NAMES 里。
 */
const TOOL_METAS: Record<string, { kind: ToolKind; summarize: (args: unknown) => string }> = {
  read: { kind: 'read', summarize: (a) => summarizeArgs('read', a) },
  grep: { kind: 'read', summarize: (a) => summarizeArgs('grep', a) },
  find: { kind: 'read', summarize: (a) => summarizeArgs('find', a) },
  ls: { kind: 'read', summarize: (a) => summarizeArgs('ls', a) },
  write: { kind: 'write', summarize: (a) => summarizeArgs('write', a) },
  edit: { kind: 'edit', summarize: (a) => summarizeArgs('edit', a) },
  bash: { kind: 'exec', summarize: (a) => summarizeArgs('bash', a) },
  powershell: { kind: 'exec', summarize: (a) => summarizeArgs('powershell', a) },
  // MCP 资源三件（pi extensions/mcp/resources.ts，带资源的 server 连上时按其
  // exposure 注册）：只读拉取 server 资源，read 档放行
  list_mcp_resources: { kind: 'read', summarize: (a) => summarizeArgs('list_mcp_resources', a) },
  list_mcp_resource_templates: { kind: 'read', summarize: (a) => summarizeArgs('list_mcp_resource_templates', a) },
  read_mcp_resource: { kind: 'read', summarize: (a) => summarizeArgs('read_mcp_resource', a) },
  // 交互座（4c）：会话内交互工具，无文件/进程副作用 → read 档（审批链放行，
  // plan 档可用 —— 清单维护正是 plan 工作流的组成；挂起交互的"审批"是
  // 工具自身的面板，不走工具执行审批）
  todo_write: { kind: 'read', summarize: summarizeTodoWriteArgs },
  // 历史名（v1 旧转录）：glob，kind 同只读
  glob: { kind: 'read', summarize: (a) => summarizeArgs('glob', a) }
}

/** 工具名 → 元数据；未知名字（盘上旧转录的历史名）返回 undefined，调用方按只读兜底。
    MCP 工具（mcp__<server>__<tool>，阶段 4a）不在静态表 —— 名字运行时才知道，
    前缀判别后投影 exec 档（D8 审批链：默认 ask，autonomous 下仍逐次询问 ——
    未经用户配置的第三方工具保守起步，见 docs/计划/MCP座实现.md §3.3）。
    annotations 分级（readOnlyHint→低风险，zcode 手法）实施时验证结果：pi 的
    beforeToolCall 载荷（pi-agent-core types.ts BeforeToolCallContext）只有
    assistantMessage/toolCall/args/context，不带工具定义 —— 拿不到 annotations，
    首版统一 exec 档，降级映射列后续（工具注册表查询钩子）。 */
export function toolMeta(name: string): { kind: ToolKind; summarize: (args: unknown) => string } | undefined {
  if (name.startsWith('mcp__')) {
    return { kind: 'exec', summarize: (a) => summarizeArgs(name, a) }
  }
  return TOOL_METAS[name]
}

/**
 * 重建会话工具集的模型侧声明（name/description/parameters）—— 供上下文明细
 * 的 toolDefs 段估算：pi 的工具 schema 不进会话树，估算时按同一构造
 * 函数现建（确定性：同版本同 schema），与请求里 toolsAdded 的形状同源。
 * 声明对象不嵌 cwd（cwd 只进执行闭包），无需传根。
 */
export function toolDeclarations(): Array<{ name: string; description: string; parameters: unknown }> {
  const tools =
    platform() === 'win32'
      ? [createReadTool(''), createPowerShellTool(''), createEditTool(''), createWriteTool(''), createGrepTool(''), createFindTool(''), createLsTool('')]
      : [createReadTool(''), createBashTool(''), createEditTool(''), createWriteTool(''), createGrepTool(''), createFindTool(''), createLsTool('')]
  return [
    ...tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
    ...interactToolDeclarations()
  ]
}
