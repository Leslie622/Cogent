/**
 * 通用变量映射与模板替换引擎（docs/计划/技能座升级实现.md §3.3）——
 * 为技能正文展开、未来插件配置与受控 sink 提供统一的表驱动变量替换。
 *
 * 安全纪律（对照 zcode adapters/plugins/mcp.ts:402-463 与 im-2.0 command-tool.js:24-29）：
 * - 正文 / Prompt 场景必须传 `allowSensitive: false`，绝不将 Token/API Key 替换进正文；
 * - 单遍正则替换，防止路径或参数值中的 `$` 触发二次递归展开；
 * - 未定义变量原样保留，绝不破坏 Markdown 代码块中的 Shell `${HOME}` 或 JS 模板字面量。
 */

export interface TemplateVarContext {
  /** 当前技能所在目录绝对路径 */
  skillDir?: string
  /** 当前工作区主根绝对路径 */
  projectDir?: string
  /** 当前会话 ID */
  sessionId?: string
  /** 显式调用或 skill 工具传入的完整参数字符串 */
  arguments?: string
  /** 已拆分的位置参数（缺省时由 arguments 自动按引号/空白拆分） */
  positionalArgs?: readonly string[]
  /** 预留：插件根目录（未来插件座接入） */
  pluginRoot?: string
  /** 预留：插件数据目录（未来插件座接入） */
  pluginData?: string
  /** 预留：自定义非机密变量（如平台基址） */
  extra?: Readonly<Record<string, string>>
  /** 仅允许在 allowSensitive: true 的敏感 sink 中解析，正文场景严禁开放 */
  secrets?: Readonly<Record<string, string>>
}

export interface ExpandTemplateOptions {
  /** 正文 / Prompt 场景强制为 false；仅受控敏感 sink 允许为 true */
  allowSensitive: boolean
  /** 正文未包含 $ARGUMENTS/$N 且 arguments 非空时，自动追加到末尾（默认 true） */
  appendUnusedArguments?: boolean
}

/** 按 Shell 风格空白与单/双引号切分位置参数（供 $1..$9 与 $ARGUMENTS[N] 使用） */
export function splitArguments(raw: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let hasToken = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (quote !== null) {
      if (ch === '\\' && quote === '"' && i + 1 < raw.length) {
        current += raw[++i]
        continue
      }
      if (ch === quote) {
        quote = null
        continue
      }
      current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      hasToken = true
      continue
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        args.push(current)
        current = ''
        hasToken = false
      }
      continue
    }
    current += ch
    hasToken = true
  }
  if (hasToken) args.push(current)
  return args
}

/** 构建单次替换使用的命名变量表（含 Claude Code / Cogent 生态别名） */
function buildNamedVarMap(ctx: TemplateVarContext, allowSensitive: boolean): Map<string, string> {
  const map = new Map<string, string>()
  const set = (key: string, value: string | undefined): void => {
    if (value !== undefined) map.set(key, value)
  }
  set('COGENT_SKILL_DIR', ctx.skillDir)
  set('CLAUDE_SKILL_DIR', ctx.skillDir)
  set('COGENT_PROJECT_DIR', ctx.projectDir)
  set('CLAUDE_PROJECT_DIR', ctx.projectDir)
  set('COGENT_SESSION_ID', ctx.sessionId)
  set('CLAUDE_SESSION_ID', ctx.sessionId)
  set('COGENT_PLUGIN_ROOT', ctx.pluginRoot)
  set('CLAUDE_PLUGIN_ROOT', ctx.pluginRoot)
  set('COGENT_PLUGIN_DATA', ctx.pluginData)
  set('CLAUDE_PLUGIN_DATA', ctx.pluginData)
  if (ctx.extra !== undefined) {
    for (const [k, v] of Object.entries(ctx.extra)) {
      if (k.length > 0) map.set(k, v)
    }
  }
  if (allowSensitive && ctx.secrets !== undefined) {
    for (const [k, v] of Object.entries(ctx.secrets)) {
      if (k.length > 0) map.set(k, v)
    }
  }
  return map
}

/**
 * 单遍匹配：
 * - `${VAR_NAME}`（命名变量，允许字母/数字/下划线/点号）
 * - `$ARGUMENTS[N]` / `$ARGUMENTS`（全量或索引位置参数，0-based）
 * - `$1`..`$9`（1-based 位置参数，前面不得紧跟字母/数字/下划线/$，后面不得紧跟字母/数字/下划线）
 */
const TEMPLATE_TOKEN =
  /\$\{([A-Za-z_][A-Za-z0-9_.]*)\}|(?<![A-Za-z0-9_$])\$(?:ARGUMENTS(?:\[(\d+)\])?|([1-9]))(?![A-Za-z0-9_])/g

/**
 * 对文本执行单遍模板变量替换。
 * 命名变量未在上下文定义时原样保留；`$ARGUMENTS` / `$N` 仅在调用方提供了
 * `arguments` 或 `positionalArgs` 时展开，否则原样保留（避免破坏示例代码）。
 */
export function expandTemplateVars(
  text: string,
  ctx: TemplateVarContext,
  options: ExpandTemplateOptions
): string {
  const named = buildNamedVarMap(ctx, options.allowSensitive)
  const rawArgs = ctx.arguments?.trim() ?? ''
  const hasArgsInput = ctx.arguments !== undefined || ctx.positionalArgs !== undefined
  const positional = ctx.positionalArgs ?? (rawArgs.length > 0 ? splitArguments(rawArgs) : [])
  const state = { consumedArguments: false }

  const replaced = text.replace(TEMPLATE_TOKEN, (match, varName?: string, argBracketIdx?: string, posIdx?: string) => {
    if (varName !== undefined) {
      const value = named.get(varName)
      return value !== undefined ? value : match
    }
    if (!hasArgsInput) return match
    state.consumedArguments = true
    if (argBracketIdx !== undefined) {
      const index = Number.parseInt(argBracketIdx, 10)
      return positional[index] ?? ''
    }
    if (posIdx !== undefined) {
      const index = Number.parseInt(posIdx, 10) - 1
      return positional[index] ?? ''
    }
    return rawArgs
  })

  if (!state.consumedArguments && rawArgs.length > 0 && options.appendUnusedArguments !== false) {
    return `${replaced}\n\n<arguments>\n${rawArgs}\n</arguments>`
  }
  return replaced
}
