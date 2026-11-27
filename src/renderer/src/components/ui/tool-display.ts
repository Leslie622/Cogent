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
 * 类别只表达工具用途，不随运行结果改名，避免拒绝写入时仍显示「已写入」。
 * 运行由扫光表达，失败与拒绝由独立状态词表达；旧转录未知名保留通用「工具」。
 */
const KIND_LABELS: Record<string, string> = {
  read: '读取',
  read_attachment: '附件',
  skill: '技能',
  write: '写入',
  edit: '编辑',
  grep: '搜索',
  find: '搜索',
  glob: '搜索',
  ls: '目录',
  bash: '终端',
  powershell: '终端',
  todo_write: '待办',
  ask_user: '提问',
  enter_plan: '计划',
  submit_plan: '计划',
  list_mcp_resources: 'MCP',
  list_mcp_resource_templates: 'MCP',
  read_mcp_resource: 'MCP'
}

/** MCP 工具按来源归类，具体 server.tool 身份由主文案保留。 */
export function toolKindLabel(name: string): string {
  if (name.startsWith('mcp__')) return 'MCP'
  return Object.hasOwn(KIND_LABELS, name) ? KIND_LABELS[name] : '工具'
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
