/**
 * mcp-import 纯函数单测（2026-11-17 会话状态重构 P6 随拆出落测）：钉
 * parseImport 的双形状接受（mcpServers 信封 / 裸 map）、坏条目记名报错、
 * 可选字段的类型过滤，与表单序列化的基础行为 —— 这些是弹窗「导入/JSON
 * 模式」共用路径的契约，改解析逻辑先过这里。
 */
import { describe, expect, it } from 'vitest'
import { defToJsonText, entriesOf, parseEntries, parseImport, parseLines } from '@/features/settings/mcp-import'

describe('parseImport', () => {
  it('接受 mcpServers 信封形状（生态互拷）', () => {
    const { defs, errors } = parseImport(
      '{"mcpServers": {"fs": {"command": "npx", "args": ["-y", "x"], "env": {"K": "V"}}}}'
    )
    expect(errors).toEqual([])
    expect(defs).toEqual([
      { name: 'fs', type: 'stdio', command: 'npx', args: ['-y', 'x'], env: { K: 'V' } }
    ])
  })

  it('接受裸 map 形状，http 条目走 url/headers', () => {
    const { defs, errors } = parseImport('{"api": {"url": "https://x.test/mcp", "headers": {"A": "b"}}}')
    expect(errors).toEqual([])
    expect(defs).toEqual([{ name: 'api', type: 'http', url: 'https://x.test/mcp', headers: { A: 'b' } }])
  })

  it('空键与缺 command/url 记名报错，其余条目照常出', () => {
    const { defs, errors } = parseImport('{"": {"command": "x"}, "bad": {}, "ok": {"command": "y"}}')
    expect(errors).toEqual(['服务器名称不能为空（JSON 键）', '"bad" 缺少 command 或 url'])
    expect(defs.map((d) => d.name)).toEqual(['ok'])
  })

  it('非对象条目报错；非对象 JSON 整体抛', () => {
    expect(parseImport('{"x": 1}').errors).toEqual(['"x" 不是对象'])
    expect(() => parseImport('[1]')).toThrow('JSON 对象')
  })

  it('可选字段校验：无效 headers 明确报错，避免导入时静默丢掉认证字段', () => {
    const { defs, errors } = parseImport(
      '{"a": {"url": "https://x", "description": "d", "enabled": true, "exposure": "hidden", "timeout": 5, "headers": {"A": 1}}}'
    )
    expect(defs).toEqual([])
    expect(errors).toEqual(['"a" env / headers 的值必须是字符串'])
  })

  it('VS Code 输入变量改为环境引用，SSE/OAuth 与未知字段往返不丢失', () => {
    const imported = parseImport(JSON.stringify({ servers: { remote: { type: 'sse', url: 'https://example.com/sse', headers: { Authorization: 'Bearer ${input:token}' }, oauth: { clientRegistration: 'dcr' }, toolExposure: { read: 'direct' }, vendor: { enabled: true } } } }))
    expect(imported.errors).toEqual([])
    expect(imported.warnings).toEqual(['remote：输入变量 token 已改为环境变量引用，请先配置环境变量 token'])
    expect(imported.defs[0]).toMatchObject({ type: 'sse', headers: { Authorization: 'Bearer ${env:token}' }, oauth: { clientRegistration: 'dcr' }, extraFields: { vendor: { enabled: true } } })
    const roundTrip = parseImport(defToJsonText(imported.defs[0]))
    expect(roundTrip.defs).toEqual(imported.defs)
  })

  it('无法直接作为环境名的输入变量保留并提示用户修改，避免猜测出错', () => {
    const result = parseImport('{"servers":{"remote":{"url":"https://example.com/mcp","headers":{"Authorization":"Bearer ${input:api-token}"}}}}')
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual(['remote：请将输入变量 api-token 替换为 ${env:YOUR_TOKEN} 并配置对应环境变量'])
    expect(result.defs[0]).toMatchObject({ headers: { Authorization: 'Bearer ${input:api-token}' } })
  })

  it('OpenCode 本地数组命令、environment 和环境引用归一化', () => {
    const result = parseImport(JSON.stringify({ mcp: { local: { type: 'local', command: ['node', 'server.js'], environment: { TOKEN: '{env:MY_TOKEN}' }, enabled: false } } }))
    expect(result.errors).toEqual([])
    expect(result.defs).toEqual([{ name: 'local', type: 'stdio', command: 'node', args: ['server.js'], env: { TOKEN: '${MY_TOKEN}' }, enabled: false }])
  })

  it('stdio 工作目录、宿主隔离标记与超时通过 JSON 往返保留', () => {
    const def = { name: 'local', type: 'stdio' as const, command: 'node', cwd: '${workspaceFolder}', sanitizeHostEnv: false, timeout: 120, toolExposure: { write: 'hidden' as const }, extraFields: { vendor: 1 } }
    expect(parseImport(defToJsonText(def)).defs).toEqual([def])
  })

  it('无效传输匹配和字段类型不会被导入解析器静默改写', () => {
    expect(parseImport('{"bad":{"type":"sse","command":"node"}}').errors).toEqual(['"bad" 传输类型与 command / url 不一致'])
    expect(parseImport('{"bad":{"command":"node","description":123}}').errors).toEqual(['"bad" description 需要字符串'])
    expect(parseImport('{"bad":{"command":"node","enabled":"false"}}').errors).toEqual(['"bad" enabled 需要布尔值'])
  })
})

describe('表单文本序列化', () => {
  it('parseLines 逐行 trim 并滤空行', () => {
    expect(parseLines(' a \n\n b \n')).toEqual(['a', 'b'])
  })

  it('parseEntries 按首个分隔符切（值里可含分隔符）；无分隔符行明确报错', () => {
    expect(parseEntries('K=a=b', '=')).toEqual({ K: 'a=b' })
    expect(() => parseEntries('K=a=b\n坏行', '=')).toThrow('每行需要')
    expect(entriesOf({ K: 'v' }, ':')).toBe('K:v')
  })

  it('defToJsonText 输出生态互拷形状（名字做键、type 不写入）', () => {
    const text = defToJsonText({ name: 'fs', type: 'stdio', command: 'npx' })
    expect(JSON.parse(text)).toEqual({ fs: { command: 'npx' } })
  })
})
