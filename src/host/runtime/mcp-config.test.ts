/**
 * mcp-config.ts 单元测试（docs/模块/测试.md）—— store 的纯逻辑面：
 * 校验装载（损坏文件/非法条目诊断）、user+project 合并快照、sync 全量写、
 * applyPatch 默认值语义。与 tests/integration/mcp.test.ts 的黑盒端到端
 * （真实装配 createMcpExtension + mock stdio server）互补。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { McpConfigStore } from './mcp-config'

const roots: string[] = []

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const newRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cogent-mcp-config-'))
  roots.push(dir)
  return dir
}

/** 建一个带项目级 mcp.json 的工作区，返回 cwd */
const wsWithProjectFile = (root: string, mcpServers: Record<string, unknown>): string => {
  const ws = join(root, 'ws')
  mkdirSync(join(ws, '.cogent'), { recursive: true })
  writeFileSync(join(ws, '.cogent', 'mcp.json'), JSON.stringify({ mcpServers }))
  return ws
}

const stdioDef = {
  name: 'fs',
  type: 'stdio' as const,
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
  exposure: 'direct' as const
}

describe('McpConfigStore', () => {
  it('sync → list 往返：摘要字段与缺省（enabled=true）', () => {
    const store = new McpConfigStore(newRoot())
    const n = store.sync([stdioDef, { name: 'docs', type: 'http', url: 'https://example.com/mcp', enabled: false }])
    expect(n).toBe(2)
    const { servers, errors } = store.list()
    expect(errors).toEqual([])
    expect(servers).toEqual([
      { name: 'fs', type: 'stdio', detail: 'npx -y @modelcontextprotocol/server-filesystem .', enabled: true, exposure: 'direct' },
      { name: 'docs', type: 'http', detail: 'https://example.com/mcp', enabled: false, exposure: 'codemode' }
    ])
  })

  it('sync 非法输入整包拒绝（不半写）：非法名字 / 缺 url / 重复名 / 命名空间撞名', () => {
    const store = new McpConfigStore(newRoot())
    // 非法字符名（pi-mcp 名字规则：字母数字_-）
    expect(() => store.sync([{ name: 'bad name!', type: 'stdio', command: 'npx' }])).toThrow(/bad name/)
    // http 定义缺 url（协议收窄前的形状，校验器兜底）
    expect(() => store.sync([{ name: 'ok', type: 'http' } as never])).toThrow(/url/)
    // 重复名
    expect(() => store.sync([stdioDef, stdioDef])).toThrow(/重复/)
    // 只差 -/_ 的两个名字共享工具命名空间（mcp__f_s；fs 与 f-s 不冲突）
    expect(() => store.sync([{ ...stdioDef, name: 'f-s' }, { ...stdioDef, name: 'f_s' }])).toThrow(/命名空间/)
    // 整包失败 = 文件不落（fail-fast，不半写）
    expect(store.list().servers).toEqual([])
  })

  it('snapshot：user 定义 + 项目 override 合并（override 标记与生效配置）', () => {
    const root = newRoot()
    const store = new McpConfigStore(root)
    store.sync([{ ...stdioDef, exposure: 'direct' }])
    const ws = wsWithProjectFile(root, { fs: { enabled: false } })
    const snap = store.snapshot(ws)
    expect(snap.errors).toEqual([])
    const entry = snap.servers.find((s) => s.name === 'fs')
    expect(entry?.config.enabled).toBe(false)
    expect(entry?.config.exposure).toBe('direct') // override 只动 enabled，exposure 继承
    expect(entry?.override).toBe(join(ws, '.cogent', 'mcp.json'))
    expect(entry?.scope).toBe('global')
  })

  it('snapshot：项目级越权条目全部拒绝并诊断（定义 server / 未知名 / override 越键）', () => {
    const root = newRoot()
    const store = new McpConfigStore(root)
    store.sync([stdioDef])
    const ws = wsWithProjectFile(root, {
      sneaky: { command: 'npx', args: ['evil'] }, // 项目级定义新 server —— 信任门
      ghost: { enabled: false }, // 无对应 user 定义
      fs: { enabled: false, description: '越键' } // override 只许 enabled/exposure/toolExposure
    })
    const snap = store.snapshot(ws)
    expect(snap.servers.map((s) => s.name)).toEqual(['fs']) // 三条全部拒绝，fs 原样
    expect(snap.errors).toHaveLength(3)
    expect(snap.errors.join('\n')).toMatch(/只能覆盖/)
  })

  it('applyPatch：定义文件删默认键 / override 文件保留显式值（pi updateMcpServerConfig 语义）', () => {
    const root = newRoot()
    const store = new McpConfigStore(root)
    store.sync([stdioDef])
    const ws = wsWithProjectFile(root, { fs: { enabled: true } })

    const [entry] = store.snapshot(ws).servers
    // 关闭（条目带 override → 写 override 文件）
    store.applyPatch(entry, { enabled: false })
    const userDoc = JSON.parse(readFileSync(join(root, 'mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> }
    const projectDoc = JSON.parse(readFileSync(join(ws, '.cogent', 'mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> }
    expect(userDoc.mcpServers.fs).toEqual({ type: 'stdio', command: 'npx', args: stdioDef.args, exposure: 'direct' })
    expect(projectDoc.mcpServers.fs).toEqual({ enabled: false })

    // 定义文件的 enable=true 是默认值 → 删键；override 文件的 true 非默认 → 保留显式
    const [offEntry] = store.snapshot(ws).servers
    store.applyPatch(offEntry, { enabled: true })
    const projectDoc2 = JSON.parse(readFileSync(join(ws, '.cogent', 'mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> }
    expect(projectDoc2.mcpServers.fs).toEqual({ enabled: true })
  })

  it('损坏文件诊断不炸：list 带回 errors', () => {
    const root = newRoot()
    const store = new McpConfigStore(root)
    writeFileSync(join(root, 'mcp.json'), '{broken json')
    const { servers, errors } = store.list()
    expect(servers).toEqual([])
    expect(errors[0]).toMatch(/broken|Unexpected|expected/i)
  })
})
