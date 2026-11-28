/**
 * mcp-config.ts 单元测试（docs/模块/测试.md）—— store 的纯逻辑面：
 * 校验装载（损坏文件/非法条目诊断）、user+project 合并快照、sync 全量写、
 * applyPatch 默认值语义。与 tests/integration/mcp.test.ts 的黑盒端到端
 * （真实装配 createMcpExtension + mock stdio server）互补。
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpConfigStore } from '../../../src/host/runtime/mcp-config'

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
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
    expect(servers).toMatchObject([
      {
        name: 'fs',
        type: 'stdio',
        detail: 'npx -y @modelcontextprotocol/server-filesystem .',
        enabled: true,
        exposure: 'direct',
        // def = 编辑表单回填源：盘上原值（enabled 缺省 true 不落 def 字段）
        def: { name: 'fs', type: 'stdio', command: 'npx', args: stdioDef.args, exposure: 'direct' }
      },
      {
        name: 'docs',
        type: 'http',
        detail: 'https://example.com/mcp',
        enabled: false,
        exposure: 'deferred',
        def: { name: 'docs', type: 'http', url: 'https://example.com/mcp', enabled: false }
      }
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
    expect(snap.errors).toHaveLength(2)
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

  it('list(cwd) 合并视图：生效值 + overrideApplied/override 原样；def 仍用户级原值', () => {
    const root = newRoot()
    const store = new McpConfigStore(root)
    store.sync([stdioDef])
    const ws = wsWithProjectFile(root, { fs: { enabled: false } })
    const user = store.list()
    expect(user.servers[0].overrideApplied).toBeUndefined() // 用户级视图无标记
    const merged = store.list(ws)
    const s = merged.servers[0]
    expect(s.enabled).toBe(false) // 生效值（override 后）
    expect(s.exposure).toBe('direct')
    expect(s.overrideApplied).toBe(true)
    expect(s.override).toEqual({ enabled: false })
    expect(s.def.enabled).toBeUndefined() // def = 用户级原值（enabled 缺省 true）
  })

  it('override 写入/清除：全量替换语义（空 patch = 删除条目回落用户级）', () => {
    const root = newRoot()
    const store = new McpConfigStore(root)
    store.sync([stdioDef])
    const ws = join(root, 'ws')
    // 写 override（关 + 改档）
    store.override(ws, 'fs', { enabled: false, exposure: 'hidden' })
    const doc1 = JSON.parse(readFileSync(join(ws, '.cogent', 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>
    }
    expect(doc1.mcpServers.fs).toEqual({ enabled: false, exposure: 'hidden' })
    expect(store.list(ws).servers[0].enabled).toBe(false)
    expect(store.list(ws).servers[0].exposure).toBe('hidden')
    // 清除（空 patch）→ 回落用户级
    store.override(ws, 'fs', {})
    const doc2 = JSON.parse(readFileSync(join(ws, '.cogent', 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>
    }
    expect(doc2.mcpServers).toEqual({})
    expect(store.list(ws).servers[0].enabled).toBe(true)
    expect(store.list(ws).servers[0].overrideApplied).toBeUndefined()
    // 无用户级定义的名字不可覆盖（信任门）
    expect(() => store.override(ws, 'ghost', { enabled: false })).toThrow(/没有名为/)
  })

  it('无损往返：SSE、OAuth、单工具档与未知字段保留，缺省/旧 codemode 均有效为 deferred', () => {
    const root = newRoot()
    const store = new McpConfigStore(root)
    writeFileSync(join(root, 'mcp.json'), JSON.stringify({ vendorSetting: true, mcpServers: {
      remote: { type: 'sse', url: 'https://example.com/sse', oauth: { clientId: 'public', clientSecret: '${env:CLIENT_SECRET}', clientRegistration: 'dcr' }, toolExposure: { query: 'direct', write: 'hidden' }, vendorExtension: { mode: 'custom' } },
      legacy: { command: 'node', exposure: 'codemode', cwd: '.', sanitizeHostEnv: false, timeout: 12 }
    } }))
    const before = store.list()
    expect(before.errors).toEqual([])
    expect(before.servers.map((server) => server.exposure)).toEqual(['deferred', 'deferred'])
    expect(before.servers[0].def).toMatchObject({ type: 'sse', oauth: { clientSecret: '${env:CLIENT_SECRET}' }, extraFields: { vendorExtension: { mode: 'custom' } } })
    store.sync(before.servers.map((server) => server.def))
    const document = JSON.parse(readFileSync(join(root, 'mcp.json'), 'utf8')) as { vendorSetting: boolean; mcpServers: Record<string, unknown> }
    expect(document.vendorSetting).toBe(true)
    expect(document.mcpServers.remote).toMatchObject({ type: 'sse', vendorExtension: { mode: 'custom' }, toolExposure: { query: 'direct', write: 'hidden' } })
    expect(store.list().servers.map((server) => server.def)).toEqual(before.servers.map((server) => server.def))
  })

  it('项目两文件优先级、定义信任与跨项目失效：未受信项目定义遮住同名用户定义', () => {
    const root = newRoot()
    const store = new McpConfigStore(root)
    store.sync([{ name: 'same', type: 'stdio', command: 'user-command' }])
    const ws = wsWithProjectFile(root, { same: { command: 'cogent-command', env: { TOKEN: '${env:PROJECT_TOKEN}' } } })
    writeFileSync(join(ws, '.mcp.json'), JSON.stringify({ mcpServers: { same: { command: 'standard-command' }, secondary: { url: 'https://example.com/mcp' } } }))
    const unresolved = store.resolve(ws, 'one')
    expect(unresolved.servers.find((entry) => entry.name === 'same')).toMatchObject({ trusted: false, origin: 'project-cogent', config: { command: 'cogent-command' } })
    const pending = unresolved.pendingTrustFiles.find((file) => file.filePath.endsWith(join('.cogent', 'mcp.json')))
    if (pending === undefined) throw new Error('pending project configuration expected')
    expect(pending.servers[0]).toMatchObject({ envKeys: ['TOKEN'] })
    expect(JSON.stringify(pending)).not.toContain('${env:PROJECT_TOKEN}')
    // 被高优先级文件遮住的 standard same 不再提示用户审阅。
    expect(unresolved.pendingTrustFiles.find((file) => file.filePath.endsWith('.mcp.json'))?.servers.map((server) => server.name)).toEqual(['secondary'])
    store.trust.decide({ projectId: 'one', cwd: ws, filePath: pending.filePath, sha256: pending.sha256, decision: 'trust' })
    expect(store.resolve(ws, 'one').servers.find((entry) => entry.name === 'same')?.trusted).toBe(true)
    expect(store.resolve(ws, 'two').servers.find((entry) => entry.name === 'same')?.trusted).toBe(false)
    expect(store.resolve(ws).servers.find((entry) => entry.name === 'same')?.trusted).toBe(false)
    writeFileSync(join(ws, '.cogent', 'mcp.json'), JSON.stringify({ mcpServers: { same: { command: 'changed-command' } } }))
    expect(store.resolve(ws, 'one').servers.find((entry) => entry.name === 'same')?.trusted).toBe(false)
  })

  it('工作目录就是配置目录的上一级（默认主目录会话）：同一文件只按用户级读一次，不变成未受信的项目定义', () => {
    const ws = join(newRoot(), 'ws')
    const root = join(ws, '.cogent')
    mkdirSync(root, { recursive: true })
    const store = new McpConfigStore(root)
    store.sync([stdioDef])
    const userFile = realpathSync(join(root, 'mcp.json'))
    const original = readFileSync(userFile, 'utf8')
    const home = store.resolve(ws, 'home')
    expect(home.errors).toEqual([])
    expect(home.pendingTrustFiles).toEqual([])
    expect(home.servers).toHaveLength(1)
    expect(home.servers[0]).toMatchObject({ name: 'fs', origin: 'user', scope: 'global', trusted: true, source: userFile })
    // 路径写法不同（大小写）仍是同一文件
    if (process.platform === 'win32') expect(store.resolve(ws.toUpperCase(), 'home').servers[0]).toMatchObject({ origin: 'user', trusted: true })
    // 没有独立的项目槽位：项目 override 明确拒绝，用户定义原样
    expect(() => store.override(ws, 'fs', { exposure: 'hidden' })).toThrow(/用户级 MCP 配置目录/)
    expect(store.list(ws).servers[0]).toMatchObject({ origin: 'user', exposure: 'direct', trusted: true })
    expect(readFileSync(userFile, 'utf8')).toBe(original)
    // 同一文件的问题只诊断一次
    writeFileSync(userFile, '{broken json')
    expect(store.resolve(ws, 'home').errors).toHaveLength(1)
  })

  it('单工具 override 全量替换并校验值域；非法 sync 不改变已保存的原值', () => {
    const root = newRoot()
    const store = new McpConfigStore(root)
    store.sync([stdioDef])
    const ws = join(root, 'ws')
    store.override(ws, 'fs', { toolExposure: { write: 'hidden' } })
    expect(store.list(ws).servers[0].override).toEqual({ toolExposure: { write: 'hidden' } })
    expect(store.resolve(ws).servers[0].config.toolExposure).toEqual({ write: 'hidden' })
    expect(() => store.override(ws, 'fs', { toolExposure: { write: 'invalid' } } as never)).toThrow('toolExposure')
    const previous = readFileSync(join(root, 'mcp.json'), 'utf8')
    expect(() => store.sync([{ ...stdioDef, toolExposure: { read: 'invalid' } } as never])).toThrow('toolExposure')
    expect(readFileSync(join(root, 'mcp.json'), 'utf8')).toBe(previous)
  })

  it('SSE 与 OAuth 使用同样的边界校验，模板 URL 留到连接时解析', () => {
    const store = new McpConfigStore(newRoot())
    expect(() => store.sync([{ name: 'remote', type: 'sse', url: 'file:///private' }])).toThrow('url')
    expect(() => store.sync([{ name: 'remote', type: 'sse', url: 'https://example.com/sse', oauth: { callbackUrl: 'https://example.com/callback' } }])).toThrow('callbackUrl')
    expect(() => store.sync([{ name: 'remote', type: 'http', url: '${BASE}/mcp' }])).not.toThrow()
    expect(store.list().servers[0].def).toMatchObject({ url: '${BASE}/mcp' })
  })

  it('项目自己的定义原位切换开关、保留扩展并要求新摘要重新信任', () => {
    const root = newRoot()
    const store = new McpConfigStore(root)
    const ws = join(root, 'ws')
    mkdirSync(ws)
    const filePath = join(ws, '.mcp.json')
    writeFileSync(filePath, JSON.stringify({ mcpServers: { local: { command: 'node', vendor: 'keep' } } }))
    const first = store.trust.inspect(filePath)
    store.trust.decide({ projectId: 'one', cwd: ws, ...first, decision: 'trust' })
    expect(store.resolve(ws, 'one').servers[0].trusted).toBe(true)
    store.override(ws, 'local', { enabled: false })
    const changed = store.resolve(ws, 'one')
    expect(changed.servers[0]).toMatchObject({ origin: 'project-file', trusted: false, config: { enabled: false, extraFields: { vendor: 'keep' } } })
    expect(changed.pendingTrustFiles).toHaveLength(1)
    const next = store.trust.inspect(filePath)
    store.trust.decide({ projectId: 'one', cwd: ws, ...next, decision: 'trust' })
    expect(store.resolve(ws, 'one').servers[0]).toMatchObject({ trusted: true, config: { enabled: false } })
    store.override(ws, 'local', { enabled: true })
    expect(store.resolve(ws, 'one').servers[0]).toMatchObject({ trusted: false, config: { enabled: true } })
    const enabled = store.trust.inspect(filePath)
    store.trust.decide({ projectId: 'one', cwd: ws, ...enabled, decision: 'trust' })
    expect(store.resolve(ws, 'one').servers[0]).toMatchObject({ trusted: true, config: { enabled: true } })
    expect(store.list().servers).toEqual([])
  })

  it('读取配置保留静态凭据和非法条目，不自动迁移或改写源文件', () => {
    const root = newRoot()
    const store = new McpConfigStore(root)
    const filePath = join(root, 'mcp.json')
    const broken = { type: 'http', timeout: -1 }
    writeFileSync(filePath, JSON.stringify({ vendorSetting: 'keep', mcpServers: {
      local: { command: 'node', env: { API_KEY: 'plaintext' }, vendor: 'keep' }, broken
    } }))
    const original = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as { vendorSetting: string; mcpServers: Record<string, unknown> }
    expect(parsed).toMatchObject({ vendorSetting: 'keep', mcpServers: { local: { env: { API_KEY: 'plaintext' }, vendor: 'keep' }, broken } })
    expect(store.list().errors).toHaveLength(1)
    expect(readFileSync(filePath, 'utf8')).toBe(original)
  })
})
