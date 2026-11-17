/**
 * MCP 配置的纯序列化/解析（自 McpSection 拆出，2026-11-17 会话状态重构 P6）：
 * 表单文本态 ↔ def 的换算、生态形状 JSON 的导入解析与导出序列化。
 * 全部纯函数无 React —— McpServerDialog（表单↔JSON 双模式）与 McpSection
 * （导入弹窗）共用；值域校验在引擎 mcp.sync 入口，这里只做结构提取。
 */
import type { McpExposure, McpServerDef } from '@/env.d'

// ———— 表单文本态的序列化（数组/记录 ↔ 多行文本，带空格参数无需引号转义） ——

export const linesOf = (arr: string[] | undefined): string => (arr ?? []).join('\n')

export const parseLines = (text: string): string[] =>
  text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)

export const entriesOf = (record: Record<string, string> | undefined, sep: string): string =>
  Object.entries(record ?? {}).map(([k, v]) => `${k}${sep}${v}`).join('\n')

export const parseEntries = (text: string, sep: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const line of parseLines(text)) {
    const at = line.indexOf(sep)
    if (at <= 0) continue // 无分隔符的行静默丢弃（表单占位文案已给格式样例）
    out[line.slice(0, at).trim()] = line.slice(at + sep.length).trim()
  }
  return out
}

const isStringRecord = (value: unknown): value is Record<string, string> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) &&
  Object.values(value).every((v) => typeof v === 'string')

/** 普通对象判定（值未知；server 条目必须是它） */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * 导入载荷 → defs（renderer 侧结构提取；值域校验在引擎 mcp.sync 入口）。
 * 接受两种形状：`{ "mcpServers": { … } }`（生态通用形状，剪贴板互拷）或直接
 * `{ "名字": { command/url… } }` 的 map。缺 command/url 的条目记名报错。
 */
export function parseImport(text: string): { defs: McpServerDef[]; errors: string[] } {
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed)) {
    throw new Error('导入内容需要是 JSON 对象（{"mcpServers": { … }}）')
  }
  const map = isRecord(parsed.mcpServers) ? parsed.mcpServers : parsed
  const defs: McpServerDef[] = []
  const errors: string[] = []
  for (const [name, raw] of Object.entries(map)) {
    if (name.trim().length === 0) {
      // 空键直接拒绝：序列化半填表单会出现 ""，落到通用缺字段文案会变成
      // 悬空引号开头的一串（"… 缺少 …"），单独给明确的键名提示
      errors.push('服务器名称不能为空（JSON 键）')
      continue
    }
    if (!isRecord(raw)) {
      errors.push(`"${name}" 不是对象`)
      continue
    }
    const cfg = raw
    const shared = {
      ...(typeof cfg.description === 'string' && { description: cfg.description }),
      ...(cfg.enabled !== undefined && { enabled: cfg.enabled === true }),
      ...(typeof cfg.exposure === 'string' && { exposure: cfg.exposure as McpExposure }),
      ...(typeof cfg.timeout === 'number' && { timeout: cfg.timeout })
    }
    if (typeof cfg.url === 'string' && cfg.url.length > 0) {
      defs.push({ name, type: 'http', url: cfg.url, ...(isStringRecord(cfg.headers) && { headers: cfg.headers }), ...shared })
    } else if (typeof cfg.command === 'string' && cfg.command.length > 0) {
      defs.push({
        name,
        type: 'stdio',
        command: cfg.command,
        ...(Array.isArray(cfg.args) && { args: cfg.args as string[] }),
        ...(isStringRecord(cfg.env) && { env: cfg.env }),
        ...shared
      })
    } else {
      errors.push(`"${name}" 缺少 command 或 url`)
    }
  }
  return { defs, errors }
}

/**
 * def → JSON 模式文本（zcode 表单/JSON 双模式对齐）：单条生态互拷形状
 * `{ "名字": { …条目… } }`；type 由 command/url 推断（parseImport 同款），
 * 不写入 —— 与 pi / Claude Desktop 等的 mcpServers 形状一致。
 */
export const defToJsonText = (def: McpServerDef): string => {
  const { name, type: _type, ...entry } = def
  return JSON.stringify({ [name]: entry }, null, 2)
}

/** JSON 模式起手模板（空表单切入时给样例，直接改 / 粘贴覆盖） */
export const JSON_TEMPLATE =
  '{\n  "filesystem": {\n    "command": "npx",\n    "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]\n  }\n}'
