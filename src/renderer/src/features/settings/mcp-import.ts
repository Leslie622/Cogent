/**
 * MCP 配置的纯序列化/解析（自 McpSection 拆出，2026-11-17 会话状态重构 P6）：
 * 表单文本态 ↔ def 的换算、生态形状 JSON 的导入解析与导出序列化。
 * 全部纯函数无 React —— McpServerDialog（表单↔JSON 双模式）与 McpSection
 * （导入弹窗）共用；值域校验在引擎 mcp.sync 入口，这里只做结构提取。
 */
import type { McpExposure, McpServerDef } from '@shared/mcp'

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
    if (at <= 0) throw new Error(`每行需要“名称${sep}值”：${line}`)
    const name = line.slice(0, at).trim()
    if (Object.hasOwn(out, name)) throw new Error(`重复的字段名称：${name}`)
    Object.defineProperty(out, name, { value: line.slice(at + sep.length).trim(), enumerable: true })
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
export function parseImport(text: string): { defs: McpServerDef[]; errors: string[]; warnings?: string[] } {
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed)) {
    throw new Error('导入内容需要是 JSON 对象（{"mcpServers": { … }}）')
  }
  const map = isRecord(parsed.mcpServers) ? parsed.mcpServers : isRecord(parsed.servers) ? parsed.servers : isRecord(parsed.mcp) ? parsed.mcp : parsed
  const defs: McpServerDef[] = []
  const errors: string[] = []
  const warnings: string[] = []
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
    const cfg = { ...raw }
    const localConfig = cfg.type === 'local'
    if (cfg.type === 'local') {
      if (!Array.isArray(cfg.command) || !cfg.command.every((arg) => typeof arg === 'string') || cfg.command.length === 0) {
        errors.push(`"${name}" 的本地 command 需要非空字符串数组`)
        continue
      }
      cfg.args = cfg.command.slice(1)
      cfg.command = cfg.command[0]
      cfg.env = cfg.environment
      cfg.type = 'stdio'
    } else if (cfg.type === 'remote') cfg.type = 'http'
    const replaceVariables = (value: string): string => value
      .replace(/(?<!\$)\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, variable: string) => '${' + variable + '}')
      .replace(/\$\{input:([A-Za-z0-9_.-]+)\}/g, (_match, variable: string) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
          warnings.push(`${name}：请将输入变量 ${variable} 替换为 \${env:YOUR_TOKEN} 并配置对应环境变量`)
          return '${input:' + variable + '}'
        }
        warnings.push(`${name}：输入变量 ${variable} 已改为环境变量引用，请先配置环境变量 ${variable}`)
        return '${env:' + variable + '}'
      })
    for (const field of ['command', 'url', 'cwd'] as const) if (typeof cfg[field] === 'string') cfg[field] = replaceVariables(cfg[field])
    for (const field of ['env', 'headers'] as const) if (isStringRecord(cfg[field])) cfg[field] = Object.fromEntries(Object.entries(cfg[field]).map(([key, value]) => [key, replaceVariables(value)]))
    if (Array.isArray(cfg.args) && cfg.args.every((value) => typeof value === 'string')) cfg.args = cfg.args.map((value: string) => replaceVariables(value))
    const fail = (message: string): void => { errors.push(`"${name}" ${message}`) }
    if (cfg.type !== undefined && (typeof cfg.type !== 'string' || !['stdio', 'http', 'streamable-http', 'sse'].includes(cfg.type))) { fail('包含不支持的传输类型'); continue }
    if ((cfg.type === 'stdio' && cfg.url !== undefined) || ((cfg.type === 'http' || cfg.type === 'sse' || cfg.type === 'streamable-http') && cfg.command !== undefined)) { fail('传输类型与 command / url 不一致'); continue }
    if (cfg.description !== undefined && typeof cfg.description !== 'string') { fail('description 需要字符串'); continue }
    if (cfg.args !== undefined && (!Array.isArray(cfg.args) || !cfg.args.every((value) => typeof value === 'string'))) { fail('args 需要字符串数组'); continue }
    if ((cfg.env !== undefined && !isStringRecord(cfg.env)) || (cfg.headers !== undefined && !isStringRecord(cfg.headers))) { fail('env / headers 的值必须是字符串'); continue }
    if (cfg.enabled !== undefined && typeof cfg.enabled !== 'boolean') { fail('enabled 需要布尔值'); continue }
    if (cfg.exposure !== undefined && (typeof cfg.exposure !== 'string' || !['direct', 'deferred', 'codemode', 'hidden'].includes(cfg.exposure))) { fail('exposure 值无效'); continue }
    if (cfg.toolExposure !== undefined && (!isRecord(cfg.toolExposure) || Object.values(cfg.toolExposure).some((value) => typeof value !== 'string' || !['direct', 'deferred', 'codemode', 'hidden'].includes(value)))) { fail('toolExposure 值无效'); continue }
    if (cfg.timeout !== undefined && (typeof cfg.timeout !== 'number' || !Number.isFinite(cfg.timeout) || cfg.timeout <= 0)) { fail('timeout 需要大于 0 的秒数'); continue }
    if (cfg.sanitizeHostEnv !== undefined && typeof cfg.sanitizeHostEnv !== 'boolean') { fail('sanitizeHostEnv 需要布尔值'); continue }
    if (cfg.cwd !== undefined && typeof cfg.cwd !== 'string') { fail('cwd 需要字符串'); continue }
    if (cfg.oauth !== undefined && !isRecord(cfg.oauth)) { fail('oauth 需要对象'); continue }
    const known = new Set(['type', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'oauth', 'description', 'enabled', 'exposure', 'toolExposure', 'timeout', 'sanitizeHostEnv', ...(localConfig ? ['environment'] : [])])
    const extraFields = Object.fromEntries(Object.entries(cfg).filter(([key]) => !known.has(key)))
    const shared = {
      ...(typeof cfg.description === 'string' && { description: cfg.description }),
      ...(cfg.enabled !== undefined && { enabled: cfg.enabled === true }),
      ...(typeof cfg.exposure === 'string' && { exposure: cfg.exposure as McpExposure }),
      ...(typeof cfg.timeout === 'number' && { timeout: cfg.timeout }),
      ...(isRecord(cfg.toolExposure) && { toolExposure: cfg.toolExposure as Record<string, McpExposure> }),
      ...(Object.keys(extraFields).length > 0 && { extraFields })
    }
    if (typeof cfg.url === 'string' && cfg.url.length > 0) {
      defs.push({ name, type: cfg.type === 'sse' ? 'sse' : 'http', url: cfg.url, ...(isStringRecord(cfg.headers) && { headers: cfg.headers }), ...(isRecord(cfg.oauth) && { oauth: cfg.oauth }), ...shared })
    } else if (typeof cfg.command === 'string' && cfg.command.length > 0) {
      defs.push({
        name,
        type: 'stdio',
        command: cfg.command,
        ...(Array.isArray(cfg.args) && { args: cfg.args }),
        ...(isStringRecord(cfg.env) && { env: cfg.env }),
        ...(typeof cfg.cwd === 'string' && { cwd: cfg.cwd }),
        ...(typeof cfg.sanitizeHostEnv === 'boolean' && { sanitizeHostEnv: cfg.sanitizeHostEnv }),
        ...shared
      })
    } else {
      errors.push(`"${name}" 缺少 command 或 url`)
    }
  }
  return { defs, errors, ...(warnings.length > 0 && { warnings: [...new Set(warnings)] }) }
}

/**
 * def → JSON 模式文本（zcode 表单/JSON 双模式对齐）：单条生态互拷形状
 * `{ "名字": { …条目… } }`；type 由 command/url 推断（parseImport 同款），
 * 不写入 —— 与 pi / Claude Desktop 等的 mcpServers 形状一致。
 */
export const defToJsonText = (def: McpServerDef): string => {
  const { name, type, extraFields, ...entry } = def
  return JSON.stringify({ [name]: { ...extraFields, ...entry, ...(type === 'sse' && { type }) } }, null, 2)
}

/** JSON 模式起手模板（空表单切入时给样例，直接改 / 粘贴覆盖） */
export const JSON_TEMPLATE =
  '{\n  "filesystem": {\n    "command": "npx",\n    "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]\n  }\n}'
