/**
 * 对外 MCP Server 集成测试（阶段 5a，D9）—— 走真链路：
 * 构建产物 out/main/mcp.js（stdio MCP）× out/main/host.js（HTTP 门）×
 * 真实 SDK Client（StdioClientTransport）。场景：
 *
 *  T1 tools/list：write 凭据 = 只读 6 + 写组 8；readonly 凭据 = 写组零注册
 *  T2 cogent_status / cogent_session_create：默认 plan 档（planEnabled 兜 true）
 *  T3 cogent_session_submit + waitMs：受理 → WS 等 run.completed → finalText
 *  T4 审批经 MCP 面：ask 档写工具 → approval.request（引擎事件）→
 *     cogent_inspect_entries 见 approval.asked（审计对对外可见）→
 *     cogent_approval_respond 允许 → 工具完成 + 二轮终答
 *
 * 凭据链照生产形状手工搭（测试代替 main）：stdio capability.issue →
 * /auth/exchange → mcp-access.json（mcp-server 每调用重读）。
 */
import { createServer, type Server } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { bundledNodeBin, resolveEngineNodeBin } from '../../src/electron/main/host/runtime'
import { check, chunk, type EngineHandle, initEngine, makeTempDir, removeDir, sse, startEngine } from './harness'

const SSE_PORT = 18_961
const HTTP_PORT = 18_962
const home = makeTempDir('cogent-ext-mcp-home-')
const ws = makeTempDir('cogent-ext-mcp-ws-')

// ———— mock 端点：按请求顺序弹动作（T3 一条终答；T4 写工具 + 允许后终答） ————

type Action = { type: 'toolCall'; callId: string } | { type: 'text'; text: string }
const ACTIONS: Action[] = [
  { type: 'text', text: 'MCP final answer' }, // T3
  { type: 'toolCall', callId: 'm1' }, // T4 一轮（挂起 → MCP 允许）
  { type: 'text', text: 'T4 done' } // T4 二轮
]
let actionIndex = 0
const server: Server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const action = ACTIONS[actionIndex++] ?? { type: 'text', text: 'fallback' }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    if (action.type === 'toolCall') {
      res.write(
        sse(
          chunk({
            tool_calls: [
              { index: 0, id: action.callId, type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'mcp-me.txt', content: 'x' }) } }
            ]
          })
        )
      )
      res.write(sse(chunk({}, 'tool_calls')))
    } else {
      res.write(sse(chunk({ content: action.text })))
      res.write(sse(chunk({}, 'stop', { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })))
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

// ———— 引擎 + MCP 客户端 ————

const engine: EngineHandle = startEngine(home, { COGENT_HTTP_RPC: '1', COGENT_HTTP_PORT: String(HTTP_PORT) })

const PROVIDERS = [{ id: 'custom/mock', name: 'Mock', baseUrl: `http://127.0.0.1:${SSE_PORT}/v1`, models: ['mock'] }]

/** 测试代替 main 铸凭据：stdio 签票 → exchange → 写 access 文件 */
async function mintAccess(scope: 'readonly' | 'write', file: string): Promise<void> {
  const issued = await engine.send<{ ticket: string }>('capability.issue', { scope })
  if (issued.result?.ticket === undefined) throw new Error('capability.issue 失败')
  const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/auth/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticket: issued.result.ticket })
  })
  if (!res.ok) throw new Error(`exchange 失败 HTTP ${res.status}`)
  const exchanged = (await res.json()) as { token: string }
  writeFileSync(file, JSON.stringify({ port: HTTP_PORT, token: exchanged.token, scope }, null, 2))
}

/** 起 MCP 客户端（spawn out/main/mcp.js，凭据文件按 scope 分开） */
async function mcpClient(accessFile: string): Promise<Client> {
  const bundled = bundledNodeBin(join(process.cwd(), 'resources'), process.platform, process.arch)
  const node = resolveEngineNodeBin(process.env, bundled !== null ? bundled : null, process.execPath)
  const transport = new StdioClientTransport({
    command: node,
    args: [join(process.cwd(), 'out/main/mcp.js')],
    env: { ...process.env, COGENT_HOME: home, COGENT_MCP_ACCESS_FILE: accessFile }
  })
  const client = new Client({ name: 'ext-mcp-test', version: '0.0.1' })
  await client.connect(transport)
  return client
}

/** callTool 结果的 text 位 JSON.parse（工具面约定：单 text content） */
async function callJson(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args })
  const text = (result.content as Array<{ type: string; text?: string }> | undefined)?.find((c) => c.type === 'text')?.text
  if (result.isError) throw new Error(`${name} 返回错误: ${text}`)
  return JSON.parse(text ?? 'null')
}

const toolNames = async (client: Client): Promise<string[]> => (await client.listTools()).tools.map((t) => t.name)

describe('对外 MCP 集成（T1–T4）', () => {
  let writeClient: Client
  let readonlyClient: Client

  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(SSE_PORT, '127.0.0.1', r))
    await initEngine(engine, { client: 'ext-mcp-smoke', port: SSE_PORT, providers: PROVIDERS })
    await mintAccess('write', join(home, 'mcp-access-write.json'))
    await mintAccess('readonly', join(home, 'mcp-access-readonly.json'))
    writeClient = await mcpClient(join(home, 'mcp-access-write.json'))
    readonlyClient = await mcpClient(join(home, 'mcp-access-readonly.json'))
  }, 120_000)

  afterAll(() => {
    void writeClient.close()
    void readonlyClient.close()
    engine.kill()
    server.close()
    for (const dir of [home, ws]) removeDir(dir)
  })

  it('T1 tools/list 按 scope 过滤', async () => {
    const names = await toolNames(writeClient)
    check('1. write 凭据：只读组在', ['cogent_status', 'cogent_inspect_entries'].every((n) => names.includes(n)))
    check('2. write 凭据：写组在（14 工具）', ['cogent_session_submit', 'cogent_approval_respond'].every((n) => names.includes(n)) && names.length === 14)
    const roNames = await toolNames(readonlyClient)
    check('3. readonly 凭据：写组零注册', roNames.length === 6 && !roNames.includes('cogent_session_submit'))
  }, 60_000)

  it('T2 status + 默认 plan 会话', async () => {
    const status = (await callJson(writeClient, 'cogent_status', {})) as { service: string }
    check('4. status 打到 Host', status.service === 'cogent-agent')
    const session = (await callJson(writeClient, 'cogent_session_create', { title: 'mcp-t2' })) as { id: string; planEnabled: boolean }
    check('5. 默认 plan 档（planEnabled 兜 true）', session.planEnabled === true)
  }, 60_000)

  it('T3 submit + waitMs 拿终答', async () => {
    const created = (await callJson(writeClient, 'cogent_session_create', { title: 'mcp-t3' })) as { id: string }
    const result = (await callJson(writeClient, 'cogent_session_submit', {
      sessionId: created.id,
      text: '直接回答',
      model: 'mock',
      waitMs: 60_000
    })) as { accepted: boolean; run: { state: string; finalText?: string } }
    check('6. 受理即回', result.accepted === true)
    check('7. waitMs 等到 completed + finalText', result.run.state === 'completed' && result.run.finalText === 'MCP final answer')
  }, 120_000)

  it('T4 审批经 MCP 面（asked 可见 + 代答 + 终答）', async () => {
    const created = (await callJson(writeClient, 'cogent_session_create', {
      title: 'mcp-t4',
      permissionMode: 'ask',
      cwd: ws
    })) as { id: string; planEnabled: boolean }
    // planEnabled 缺省语义 = 关（host 对 false 不落字段，absent 即 off）
    check('8. 显式 ask = 不兜计划档', created.planEnabled !== true)
    // submit 带 waitMs 但不先 await：挂起是预期中间态，终答在代答之后
    const pending = callJson(writeClient, 'cogent_session_submit', {
      sessionId: created.id,
      text: '写 mcp-me.txt',
      model: 'mock',
      waitMs: 90_000
    })
    const req = await engine.waitEvent('approval.request', (p) => p.sessionId === created.id)
    // 审计对经 MCP 面可见（4d 的 approval.asked 落 inspect 流）
    const inspect = (await callJson(writeClient, 'cogent_inspect_entries', { sessionId: created.id })) as {
      entries: Array<{ kind: string }>
    }
    check('9. approval.asked 对外可见', inspect.entries.some((e) => e.kind === 'approval.asked'))
    // MCP 代答（允许）→ 工具完成 → 二轮终答由 pending 的 waitMs 收到
    const respond = (await callJson(writeClient, 'cogent_approval_respond', {
      requestId: req.params.requestId,
      approved: true
    })) as { ok: boolean }
    check('10. MCP 代答受理', respond.ok === true)
    const done = (await pending) as { run: { state: string; finalText?: string } }
    check('11. 允许后二轮终答', done.run.state === 'completed' && done.run.finalText === 'T4 done')
  }, 180_000)
})
