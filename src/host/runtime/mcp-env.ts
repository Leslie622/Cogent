/**
 * MCP 连接瞬间的配置展开与子进程环境隔离（docs/计划/MCP座升级实现.md §4.1.2）。
 * 沿用 template-vars 的单遍与敏感 sink 合同；MCP 专用语法不进入技能正文解析器。
 */
import { isAbsolute, resolve } from 'node:path'
import type { McpServerDef } from '../../protocol'

export interface McpEnvironmentContext {
  projectDir?: string
  env?: NodeJS.ProcessEnv
}

/** 配置保护与子进程隔离共用：含 AWS access key、Google credentials 与会话 cookie。 */
export const MCP_SENSITIVE_ENV = /(API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIALS?|PRIVATE_KEY|ACCESS_KEY(?:_ID)?|SESSION_COOKIE)$/i
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** 只扫描原始输入，替换值和默认值即使含 ${...} 也保持字面量。 */
export function expandMcpValue(value: string, context: McpEnvironmentContext): string {
  const environment = context.env ?? process.env
  let output = ''
  let offset = 0
  while (offset < value.length) {
    const start = value.indexOf('${', offset)
    if (start === -1) return output + value.slice(offset)
    output += value.slice(offset, start)
    let end = start + 2
    let depth = 1
    for (; end < value.length; end++) {
      if (value[end] === '$' && value[end + 1] === '{') {
        depth++
        end++
      } else if (value[end] === '}' && --depth === 0) {
        break
      }
    }
    if (depth !== 0) throw new Error('MCP_INVALID_TEMPLATE:unterminated placeholder')
    const token = value.slice(start + 2, end)
    if (token === 'workspaceFolder' || token === 'COGENT_PROJECT_DIR') {
      if (context.projectDir === undefined) throw new Error('MCP_MISSING_PROJECT')
      output += context.projectDir
    } else {
      const expression = token.startsWith('env:') ? token.slice(4) : token
      const defaultIndex = expression.indexOf(':-')
      const name = defaultIndex === -1 ? expression : expression.slice(0, defaultIndex)
      if (!ENV_NAME.test(name)) throw new Error('MCP_INVALID_TEMPLATE: 不支持的变量语法，请改用 ${env:ENV_VAR} 并配置对应环境变量')
      const environmentValue = environment[name]
      if (defaultIndex !== -1 && (environmentValue === undefined || environmentValue === '')) {
        output += expression.slice(defaultIndex + 2)
      } else {
        if (environmentValue === undefined) throw new Error(`MCP_MISSING_ENV:${name}`)
        output += environmentValue
      }
    }
    offset = end + 1
  }
  return output
}

/** 传输层必须使用本函数给出的完整 env，不能在其后重新叠加 process.env。 */
export function sanitizeMcpHostEnvironment(environment: NodeJS.ProcessEnv, sanitize = true): Record<string, string> {
  return Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && (!sanitize || !MCP_SENSITIVE_ENV.test(entry[0]))
  ))
}

/** 只展开连接参数，原定义及其 source/摘要不受影响，返回值不得用于 UI 或日志。 */
export function resolveMcpEnvironment(definition: McpServerDef, context: McpEnvironmentContext): McpServerDef {
  const expand = (value: string): string => expandMcpValue(value, context)
  if (definition.type === 'stdio') {
    const environment = sanitizeMcpHostEnvironment(context.env ?? process.env, definition.sanitizeHostEnv !== false)
    for (const [name, value] of Object.entries(definition.env ?? {})) {
      // Windows 的环境键不区分大小写，先清掉继承的不同拼写，避免 Node 只选中旧键。
      if (process.platform === 'win32') {
        for (const inherited of Object.keys(environment)) {
          if (inherited.toLowerCase() === name.toLowerCase()) delete environment[inherited]
        }
      }
      environment[name] = expand(value)
    }
    const command = expand(definition.command)
    if (command.trim() === '') throw new Error('MCP_INVALID_COMMAND')
    const cwd = definition.cwd === undefined ? undefined : expand(definition.cwd)
    return {
      ...definition,
      command,
      ...(definition.args !== undefined && { args: definition.args.map(expand) }),
      ...(cwd !== undefined && { cwd: isAbsolute(cwd) ? cwd : resolve(context.projectDir ?? process.cwd(), cwd) }),
      env: environment
    }
  }
  const url = expand(definition.url)
  if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) throw new Error('MCP_INVALID_URL')
  return {
    ...definition,
    url,
    ...(definition.headers !== undefined && { headers: Object.fromEntries(Object.entries(definition.headers).map(([name, value]) => [name, expand(value)])) }),
    ...(definition.oauth !== undefined && {
      oauth: {
        ...definition.oauth,
        ...(definition.oauth.clientSecret !== undefined && { clientSecret: expand(definition.oauth.clientSecret) })
      }
    })
  }
}

/** 任意连接字段依赖项目占位符或相对 cwd，便不得全局复用。 */
export function dependsOnProject(definition: McpServerDef): boolean {
  if (definition.type === 'stdio' && definition.cwd !== undefined && !isAbsolute(definition.cwd)) return true
  return /\$\{(?:workspaceFolder|COGENT_PROJECT_DIR)\}/.test(JSON.stringify(definition))
}
