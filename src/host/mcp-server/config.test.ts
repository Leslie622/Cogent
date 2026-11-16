/**
 * 对外 MCP 凭据文件解析单测：形状校验边界（持久化读取，约定.md §1.1 ——
 * 坏数据返回 null 引导修复，不炸进程）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { accessFilePath, readAccess } from './config'

const dirs: string[] = []

function withAccessFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cogent-mcp-config-'))
  dirs.push(dir)
  const file = join(dir, 'mcp-access.json')
  writeFileSync(file, content, 'utf-8')
  process.env.COGENT_MCP_ACCESS_FILE = file
  return file
}

afterEach(() => {
  delete process.env.COGENT_MCP_ACCESS_FILE
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('readAccess：凭据文件形状校验', () => {
  it('合法凭据原样读出', () => {
    withAccessFile(JSON.stringify({ port: 8123, token: 'v1.abc.def', scope: 'write' }))
    expect(readAccess()).toEqual({ port: 8123, token: 'v1.abc.def', scope: 'write' })
  })

  it('文件缺失 → null（引导开启，不是崩溃）', () => {
    process.env.COGENT_MCP_ACCESS_FILE = join(tmpdir(), 'cogent-mcp-不存在.json')
    expect(readAccess()).toBeNull()
  })

  it('损坏 JSON / 形状不对 / scope 越界 → null', () => {
    withAccessFile('{oops')
    expect(readAccess()).toBeNull()
    withAccessFile(JSON.stringify({ port: '8123', token: 'x', scope: 'write' }))
    expect(readAccess()).toBeNull()
    withAccessFile(JSON.stringify({ port: 0, token: 'x', scope: 'readonly' }))
    expect(readAccess()).toBeNull()
    withAccessFile(JSON.stringify({ port: 8123, token: 'x', scope: 'admin' }))
    expect(readAccess()).toBeNull()
    withAccessFile(JSON.stringify({ port: 8123, scope: 'readonly' }))
    expect(readAccess()).toBeNull()
  })

  it('accessFilePath：env 覆写优先，缺省落 COGENT_HOME 根', () => {
    process.env.COGENT_MCP_ACCESS_FILE = '/tmp/x.json'
    expect(accessFilePath()).toBe('/tmp/x.json')
    delete process.env.COGENT_MCP_ACCESS_FILE
    process.env.COGENT_HOME = '/tmp/cogent-home'
    expect(accessFilePath()).toBe(join('/tmp/cogent-home', 'mcp-access.json'))
    delete process.env.COGENT_HOME
  })
})
