/** MCP 配置解析回归：单遍展开、环境隔离和连接参数保持原定义。 */
import { describe, expect, it } from 'vitest'
import type { McpServerDef } from '../../../src/protocol'
import { dependsOnProject, expandMcpValue, resolveMcpEnvironment, sanitizeMcpHostEnvironment } from '../../../src/host/runtime/mcp-env'

describe('MCP configuration environment', () => {
  it('展开环境别名与项目根，默认值为空/缺失语义与 shell 一致', () => {
    const context = { projectDir: '/project', env: { NAME: 'value', EMPTY: '' } }
    expect(expandMcpValue('${NAME}/${env:NAME}/${workspaceFolder}/${COGENT_PROJECT_DIR}', context))
      .toBe('value/value//project//project')
    expect(expandMcpValue('${EMPTY:-empty}/${MISSING:-fallback}', context)).toBe('empty/fallback')
    expect(expandMcpValue('${EMPTY}', context)).toBe('')
  })

  it('替换值和默认值不递归展开，避免密钥内容成为二次模板', () => {
    expect(expandMcpValue('${VALUE}/${OTHER}/${MISSING:-${VALUE}}', {
      env: { VALUE: '${OTHER}', OTHER: '${VALUE}' }
    })).toBe('${OTHER}/${VALUE}/${VALUE}')
  })

  it('缺失环境、移除的密钥语法与缺项目上下文及未闭合语法在建连前明确失败', () => {
    expect(() => expandMcpValue('${MISSING}', { env: {} })).toThrow('MCP_MISSING_ENV:MISSING')
    expect(() => expandMcpValue('${secret:missing}', { env: {} })).toThrow('请改用 ${env:ENV_VAR}')
    expect(() => expandMcpValue('${workspaceFolder}', {})).toThrow('MCP_MISSING_PROJECT')
    expect(() => expandMcpValue('${unterminated', {})).toThrow('MCP_INVALID_TEMPLATE')
    expect(() => expandMcpValue('${input:password}', {})).toThrow('MCP_INVALID_TEMPLATE')
  })

  it('清洗敏感宿主环境，显式声明值可以重注入，且不修改原配置', () => {
    const definition: McpServerDef = { name: 'local', type: 'stdio', command: '${COMMAND}', args: ['${workspaceFolder}'], env: { SERVER_TOKEN: '${env:SERVER_KEY}' }, cwd: '.' }
    const actual = resolveMcpEnvironment(definition, { projectDir: '/workspace', env: {
      COMMAND: 'node', SERVER_KEY: 'explicit-server-key', PATH: '/bin', MODEL_API_KEY: 'hidden', OTHER_SECRET: 'hidden', ACCESS_TOKEN: 'hidden', password: 'hidden', PRIVATE_KEY: 'hidden'
    } })
    expect(actual).toMatchObject({ command: 'node', args: ['/workspace'], env: { COMMAND: 'node', SERVER_KEY: 'explicit-server-key', PATH: '/bin', SERVER_TOKEN: 'explicit-server-key' } })
    if (actual.type !== 'stdio') throw new Error('stdio expected')
    expect(actual.env).not.toHaveProperty('MODEL_API_KEY')
    expect(actual.env).not.toHaveProperty('OTHER_SECRET')
    expect(actual.env).not.toHaveProperty('ACCESS_TOKEN')
    expect(actual.env).not.toHaveProperty('password')
    expect(actual.env).not.toHaveProperty('PRIVATE_KEY')
    expect(definition.command).toBe('${COMMAND}')
    expect(definition.env).toEqual({ SERVER_TOKEN: '${env:SERVER_KEY}' })
    expect(sanitizeMcpHostEnvironment({ API_KEY: 'explicit-opt-out' }, false)).toEqual({ API_KEY: 'explicit-opt-out' })
    expect(sanitizeMcpHostEnvironment({ AWS_ACCESS_KEY_ID: 'identifier', AWS_SECRET_ACCESS_KEY: 'secret', GOOGLE_APPLICATION_CREDENTIALS: 'credentials.json', SESSION_COOKIE: 'session', PATH: '/bin' })).toEqual({ PATH: '/bin' })
  })

  it('HTTP/SSE 展开地址、headers 与 OAuth secret，拒绝解析后的危险协议', () => {
    const definition: McpServerDef = { name: 'remote', type: 'sse', url: '${BASE}/sse', headers: { Authorization: 'Bearer ${env:SERVER_KEY}' }, oauth: { clientSecret: '${env:SERVER_KEY}' } }
    expect(resolveMcpEnvironment(definition, { env: { BASE: 'https://example.com', SERVER_KEY: 'token' } }))
      .toMatchObject({ url: 'https://example.com/sse', headers: { Authorization: 'Bearer token' }, oauth: { clientSecret: 'token' } })
    expect(() => resolveMcpEnvironment(definition, { env: { BASE: 'file:///private', SERVER_KEY: 'token' } })).toThrow('MCP_INVALID_URL')
  })

  it('项目依赖检测覆盖各连接字段与相对 cwd', () => {
    expect(dependsOnProject({ name: 'a', type: 'stdio', command: 'node', cwd: '.' })).toBe(true)
    expect(dependsOnProject({ name: 'a', type: 'stdio', command: 'node', args: ['${COGENT_PROJECT_DIR}'] })).toBe(true)
    expect(dependsOnProject({ name: 'a', type: 'http', url: 'https://example.com', headers: { Project: '${workspaceFolder}' } })).toBe(true)
    expect(dependsOnProject({ name: 'a', type: 'stdio', command: 'node' })).toBe(false)
  })
})
