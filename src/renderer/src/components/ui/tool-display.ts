/**
 * 工具行展示层纯函数（docs/模块/消息呈现.md）：
 * 工具卡头行从引擎的原始 summary（`read(src/index.ts)` 单行，见
 * host/runtime/tool-meta.ts summarizeArgs）改读「类别词 + 主文案」结构，
 * zcode ToolLayout 同款（图标 + kindLabel + primaryText + diffCount + 状态词）。
 * 摘要是引擎生成的确定性文本（值截断 60 字符、字符串不带引号），这里只做
 * 剥壳不做再截断；解析失败（历史异形转录）整段回退原文，不猜。
 */

/** 工具卡四态（ToolCard 的 status prop 同源） */
export type ToolDisplayStatus = 'running' | 'ok' | 'error' | 'blocked'

/**
 * 类别词表：进行形（running）/ 完成形（ok/error/blocked —— 失败的「已写入」
 * 指"写入这个动作发生了"，失败语义由行尾状态词独立承担，zcode 图 2 同构）。
 * 未知名（盘上旧转录的历史名）落到「正在执行/已执行」兜底档。
 */
const KIND_LABELS: Record<string, [string, string]> = {
  read: ['正在读取', '已读取'],
  read_attachment: ['正在读取附件', '已读取附件'],
  write: ['正在写入', '已写入'],
  edit: ['正在编辑', '已编辑'],
  grep: ['正在搜索', '已搜索'],
  find: ['正在搜索', '已搜索'],
  ls: ['正在列出', '已列出'],
  bash: ['正在执行', '执行命令'],
  powershell: ['正在执行', '执行命令'],
  todo_write: ['更新待办', '待办清单'],
  ask_user: ['正在询问', '已询问'],
  enter_plan: ['进入计划', '进入计划'],
  submit_plan: ['提交方案', '提交方案'],
  list_mcp_resources: ['正在读取', '已读取资源'],
  list_mcp_resource_templates: ['正在读取', '已读取资源'],
  read_mcp_resource: ['正在读取', '已读取资源']
}

/** 类别词条查找：mcp__ 前缀统一「调用」档；未知名 undefined（兜底档在调用方） */
function kindEntry(name: string): readonly [string, string] | undefined {
  if (name.startsWith('mcp__')) return ['正在调用', '已调用']
  return Object.hasOwn(KIND_LABELS, name) ? KIND_LABELS[name] : undefined
}

/** 类别词：running → 进行形，其余 → 完成形 */
export function toolKindLabel(name: string, status: ToolDisplayStatus): string {
  const entry = kindEntry(name)
  if (entry === undefined) return status === 'running' ? '正在执行' : '已执行'
  return status === 'running' ? entry[0] : entry[1]
}

/**
 * MCP 工具的主文案：`mcp__image_search__search_image(query)` 的调用侧显示
 * server.tool 名（zcode 图 1「MCP Server Analyze image」形态）——裸工具名
 * 对用户没有信息量，server 归属才是识别线索。
 */
export function mcpDisplayName(name: string): string | undefined {
  if (!name.startsWith('mcp__')) return undefined
  return name.slice('mcp__'.length).replace('__', '.')
}

/** summary 剥壳：`read(src/index.ts)` → `src/index.ts`；括号不配对返回原文 */
export function parseToolSummary(name: string, summary: string): string {
  const prefix = `${name}(`
  if (!summary.startsWith(prefix) || !summary.endsWith(')')) return summary
  return summary.slice(prefix.length, -1)
}

/**
 * ask_user 的主文案。三形状全覆盖：
 * - 引擎新摘要 `ask_user(2 个问题)`（summarizeAskUserArgs，非 JSON）→ 内文
 *   原样透传；
 * - 旧转录完整 JSON `ask_user([{...},...])` → 解析数组长 →「N 个问题」；
 * - 旧转录截断 JSON（summarizeArgs 60 字符截断，解析必失败）→ 数
 *   `"question":` 字段出现次数（截断安全的下限），至少 1。
 * 壳剥离不要求闭合括号（截断形态无尾括号）。
 */
export function askUserSummary(summary: string): string {
  let inner = summary.startsWith('ask_user(') ? summary.slice('ask_user('.length) : summary
  if (inner.endsWith(')')) inner = inner.slice(0, -1)
  inner = inner.trim()
  if (inner === '') return '1 个问题'
  if (!inner.startsWith('[') && !inner.startsWith('{')) return inner
  let parsed: unknown
  try {
    parsed = JSON.parse(inner)
  } catch {
    parsed = undefined
  }
  if (Array.isArray(parsed)) {
    return `${parsed.length} 个问题`
  }
  const hits = inner.match(/"question"\s*:/g)?.length ?? 0
  return `${Math.max(hits, 1)} 个问题`
}

/**
 * edit/write 的 diff 尾标计数：带行号 diff 的 +/- 行数（+++ / --- 文件头不算）。
 * 无增删行（纯上下文）返回 undefined —— 尾标整枚不显示，不出「+0 -0」。
 */
export function diffCount(diff: string): { added: number; removed: number } | undefined {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++
    else if (line.startsWith('-') && !line.startsWith('---')) removed++
  }
  return added + removed > 0 ? { added, removed } : undefined
}
