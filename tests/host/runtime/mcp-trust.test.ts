/** MCP 信任账本回归：摘要失效、项目隔离、文件身份与写失败不发布。 */
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { McpTrustStore } from '../../../src/host/runtime/mcp-trust'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function fixture(): { root: string; cwd: string; filePath: string; store: McpTrustStore } {
  const root = mkdtempSync(join(tmpdir(), 'cogent-mcp-trust-'))
  directories.push(root)
  const cwd = join(root, 'workspace')
  mkdirSync(cwd)
  const filePath = join(cwd, '.mcp.json')
  writeFileSync(filePath, JSON.stringify({ mcpServers: { demo: { command: 'node' } } }))
  return { root, cwd, filePath, store: new McpTrustStore(root) }
}

describe('McpTrustStore', () => {
  it('授权持久化可恢复，同一文件也不得跨项目借用信任', () => {
    const { root, cwd, filePath, store } = fixture()
    const inspected = store.inspect(filePath)
    expect(store.isTrusted('one', inspected.filePath, inspected.sha256, 'demo')).toBe(false)
    store.decide({ projectId: 'one', cwd, ...inspected, decision: 'trust' })
    expect(new McpTrustStore(root).isTrusted('one', inspected.filePath, inspected.sha256, 'demo')).toBe(true)
    expect(store.isTrusted('two', inspected.filePath, inspected.sha256, 'demo')).toBe(false)
    expect(store.isTrusted(undefined, inspected.filePath, inspected.sha256, 'demo')).toBe(false)
    store.decide({ projectId: 'one', cwd, ...inspected, decision: 'reject' })
    expect(store.isTrusted('one', inspected.filePath, inspected.sha256, 'demo')).toBe(false)
  })

  it('文件的任意字节变化使旧授权失效，并拒绝过期审阅摘要', () => {
    const { cwd, filePath, store } = fixture()
    const before = store.inspect(filePath)
    store.decide({ projectId: 'one', cwd, ...before, decision: 'trust' })
    writeFileSync(filePath, `${readFileSync(filePath, 'utf8')}\n`)
    const after = store.inspect(filePath)
    expect(store.isTrusted('one', after.filePath, after.sha256, 'demo')).toBe(false)
    expect(() => store.decide({ projectId: 'one', cwd, ...before, decision: 'trust' })).toThrow('已变更')
  })

  it('来源必须为选定项目主根的两个 MCP 文件之一', () => {
    const { root, cwd, store } = fixture()
    const otherFile = join(root, 'unrelated.json')
    writeFileSync(otherFile, '{}')
    expect(() => store.decide({ projectId: 'one', cwd, ...store.inspect(otherFile), decision: 'trust' })).toThrow('不属于项目')
  })

  it('写盘失败保留旧授权，候选新摘要不发布到内存', () => {
    const { root, cwd, filePath, store } = fixture()
    const old = store.inspect(filePath)
    store.decide({ projectId: 'one', cwd, ...old, decision: 'trust' })
    writeFileSync(filePath, '{"mcpServers":{}}')
    const next = store.inspect(filePath)
    renameSync(join(root, 'mcp-trust.json'), join(root, 'previous.json'))
    mkdirSync(join(root, 'mcp-trust.json'))
    expect(() => store.decide({ projectId: 'one', cwd, ...next, decision: 'trust' })).toThrow()
    expect(store.isTrusted('one', old.filePath, old.sha256, 'demo')).toBe(true)
    expect(store.isTrusted('one', next.filePath, next.sha256, 'demo')).toBe(false)
  })

  it('损坏账本不提供任何信任并保留诊断', () => {
    const { root, filePath, store } = fixture()
    writeFileSync(join(root, 'mcp-trust.json'), '{bad')
    const broken = new McpTrustStore(root)
    const inspected = store.inspect(filePath)
    expect(broken.errors).toHaveLength(1)
    expect(broken.isTrusted('one', inspected.filePath, inspected.sha256, 'demo')).toBe(false)
  })
})
