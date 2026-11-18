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

  it('可选字段按类型过滤透传（description/enabled/exposure/timeout；headers 非全串忽略）', () => {
    const { defs } = parseImport(
      '{"a": {"url": "https://x", "description": "d", "enabled": true, "exposure": "hidden", "timeout": 5, "headers": {"A": 1}}}'
    )
    expect(defs[0]).toEqual({
      name: 'a', type: 'http', url: 'https://x', description: 'd', enabled: true, exposure: 'hidden', timeout: 5
    })
  })
})

describe('表单文本序列化', () => {
  it('parseLines 逐行 trim 并滤空行', () => {
    expect(parseLines(' a \n\n b \n')).toEqual(['a', 'b'])
  })

  it('parseEntries 按首个分隔符切（值里可含分隔符）；无分隔符行丢弃', () => {
    expect(parseEntries('K=a=b\n坏行', '=')).toEqual({ K: 'a=b' })
    expect(entriesOf({ K: 'v' }, ':')).toBe('K:v')
  })

  it('defToJsonText 输出生态互拷形状（名字做键、type 不写入）', () => {
    const text = defToJsonText({ name: 'fs', type: 'stdio', command: 'npx' })
    expect(JSON.parse(text)).toEqual({ fs: { command: 'npx' } })
  })
})
