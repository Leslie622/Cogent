/**
 * MCP 座集成测试（阶段 4a-1，docs/模块/MCP座.md）—— 断言对象 =
 * Host 侧接线：mcp.list/sync 协议方法、createMcpExtension 装配（direct
 * 工具声明给模型）、D8 审批链对 mcp__* 生效（exec 档 ask）、echo 结果回灌
 * 循环闭合、禁用后新会话工具消失（新会话生效语义）。
 * MCP 客户端本身（连接管理/命名/超时）是 pi-mcp 的，不在此重复断言。
 *
 * mock 双桩：LLM（OpenAI SSE，18950）+ stdio MCP server
 * （mock-mcp-server.mjs，echo 工具）。临时 COGENT_HOME 隔离，user 级
 * mcp.json 经协议 mcp.sync 写入（顺带覆盖协议路径本身）。
 */
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import type { McpListResult } from '../../src/protocol'
import {
  check,
  chunk,
  type EngineHandle,
  initEngine,
  makeTempDir,
  removeDir,
  sse,
  startEngine
} from './harness'

const PORT = 18_950
const home = makeTempDir('cogent-mcp-home-')
const ws = makeTempDir('cogent-mcp-ws-')
const MOCK_MCP = join(process.cwd(), 'tests', 'integration', 'mock-mcp-server.mjs')

/** user 级 server 定义（mcp.sync 载荷）：node 直启 mock stdio server */
const mockDef = {
  name: 'mock',
  type: 'stdio' as const,
  command: process.execPath,
  args: [MOCK_MCP],
  description: 'mock echo server',
  exposure: 'direct' as const
}

// ———— mock LLM：动作队列（请求序 = 动作序，串行驱动确定） ————

type Action =
  | { type: 'text'; text: string }
  | { type: 'toolCall'; callId: string; tool: string; args: Record<string, unknown> }
const text = (t: string): Action => ({ type: 'text', text: t })
const ACTIONS: Action[] = [
  { type: 'toolCall', callId: 'm1', tool: 'mcp__mock__echo', args: { text: 'hello-mcp' } }, // S2 一轮
  text('S2 done'), // S2 二轮
  text('S3 probe') // S3（禁用后新会话）
]
let actionIndex = 0
/** LLM 请求体留存（断言工具声明/结果回灌） */
const requestBodies: Array<Record<string, unknown>> = []

const server: Server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    requestBodies.push(JSON.parse(body) as Record<string, unknown>)
    const action = ACTIONS[actionIndex++] ?? text('fallback')
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    if (action.type === 'toolCall') {
      res.write(
        sse(
          chunk({
            tool_calls: [
              { index: 0, id: action.callId, type: 'function', function: { name: action.tool, arguments: JSON.stringify(action.args) } }
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

// ———— 引擎驱动 ————

const engine: EngineHandle = startEngine(home)

const newSession = async (): Promise<string> => {
  const r = await engine.send('session.create', { cwd: ws })
  if (r.result?.id === undefined) throw new Error(`session.create 失败: ${JSON.stringify(r.error ?? r.result)}`)
  return r.result.id
}

const submitAndDone = async (sessionId: string, label: string): Promise<void> => {
  await engine.send('agent.submit', { sessionId, text: label, model: 'mock' })
  await engine.waitEvent('run.completed', (p) => p.sessionId === sessionId, 30_000)
}

describe('MCP 座集成（协议方法 + 直连工具 + 审批链 + 禁用生效）', () => {
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r))
    await initEngine(engine, {
      client: 'mcp-smoke',
      port: PORT,
      providers: [{ id: 'custom/mock', name: 'Mock', baseUrl: `http://127.0.0.1:${PORT}/v1`, models: ['mock'] }]
    })
  }, 60_000)

  afterAll(() => {
    engine.kill()
    server.close()
    for (const dir of [home, ws]) removeDir(dir)
  })

  it('场景流一条到底', async () => {
    // ———— S1 协议方法往返 ————
    const sync = await engine.send('mcp.sync', { servers: [mockDef] })
    check('1. mcp.sync 全量写（synced=1）', sync.result?.synced === 1, JSON.stringify(sync.error ?? sync.result))
    const list = await engine.send<McpListResult>('mcp.list', {})
    const summary = list.result?.servers[0]
    check(
      '2. mcp.list 摘要（name/type/detail/enabled/exposure）',
      list.result?.servers.length === 1 &&
        summary?.name === 'mock' &&
        summary.type === 'stdio' &&
        summary.detail === `${process.execPath} ${MOCK_MCP}` &&
        summary.enabled === true &&
        summary.exposure === 'direct' &&
        summary.description === 'mock echo server',
      JSON.stringify(summary)
    )
    // 非法载荷 → InvalidParams 错误帧（名字字符规则在 store 的 pi-mcp 校验器）
    const bad = await engine.send('mcp.sync', { servers: [{ name: 'bad name!', type: 'stdio', command: 'npx' }] })
    check('3. 非法定义显式拒绝（-32602）', bad.error?.code === -32602, JSON.stringify(bad.error))

    // ———— S2 直连工具 + 审批链 + 回灌 ————
    const s2 = await newSession()
    await engine.send('agent.submit', { sessionId: s2, text: 'S2 调 echo', model: 'mock' })
    // 审批挂起 = ask 默认档对 mcp__* 生效（D8 链路零新增）；MCP 首连 + LLM
    // 首轮在前面，放宽到 30s
    const appr = await engine.waitEvent('approval.request', (p) => p.sessionId === s2, 30_000)
    check(
      '4. 审批链生效（toolName/kind exec）',
      appr.params.toolName === 'mcp__mock__echo' && appr.params.kind === 'exec',
      JSON.stringify(appr.params)
    )
    // approval.request 已到 ⇒ 一轮请求已记录：direct 工具已声明给模型
    const r0 = JSON.stringify(requestBodies[0] ?? {})
    check('5. direct 工具声明进一轮请求 tools', r0.includes('mcp__mock__echo'))
    await engine.send('approval.respond', { requestId: appr.params.requestId, approved: true })
    const toolEnd = await engine.waitEvent('tool.completed', (p) => p.sessionId === s2 && p.callId === 'm1', 30_000)
    check(
      '6. echo 执行成功（mock server 往返）',
      toolEnd.params.isError === false && (toolEnd.params.summary ?? '').includes('echo: hello-mcp'),
      JSON.stringify(toolEnd.params.summary)
    )
    await engine.waitEvent('run.completed', (p) => p.sessionId === s2, 30_000)
    const r1 = JSON.stringify(requestBodies[1] ?? {})
    check('7. 工具结果回灌二轮（循环闭合）', r1.includes('echo: hello-mcp'))
    // tool.started 的 kind 投影同口径（exec）
    const started = engine.events.find((e) => e.method === 'tool.started' && e.params.sessionId === s2)
    check('8. tool.started kind=exec（元数据表前缀投影）', started?.params.kind === 'exec')

    // ———— S3 禁用 → 新会话工具消失（配置变更新会话生效） ————
    await engine.send('mcp.sync', { servers: [{ ...mockDef, enabled: false }] })
    const s3 = await newSession()
    await submitAndDone(s3, 'S3 禁用探测')
    const r3 = JSON.stringify(requestBodies[2] ?? {})
    check('9. 禁用后新会话：工具未声明给模型', !r3.includes('mcp__mock__echo'), r3.slice(0, 160))
  }, 180_000)
})
