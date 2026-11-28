/**
 * MCP 座集成测试（阶段 4a-1，docs/模块/MCP座.md）—— 断言对象 =
 * Host 侧接线：mcp.list/sync 协议方法、createMcpExtension 装配（direct
 * 工具声明给模型）、决定 28 审批链对 mcp__* 生效（exec 档 ask）、echo 结果回灌
 * 循环闭合、禁用后新会话工具消失（新会话生效语义）、附件不经 read_attachment 中转
 * （模型带原件路径直接调用 MCP 工具；deferred 时系统提示目录列出工具名）。
 * MCP 客户端本身（连接管理/命名/超时）是 pi-mcp 的，不在此重复断言。
 *
 * mock 双桩：LLM（OpenAI SSE，18950）+ stdio MCP server
 * （mock-mcp-server.mjs，echo 工具）。临时 COGENT_HOME 隔离，user 级
 * mcp.json 经协议 mcp.sync 写入（顺带覆盖协议路径本身）。
 */
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import type { AttachmentRef } from '../../src/shared/attachments'
import type { McpListResult } from '../../src/protocol'
import {
  closeLoopback,
  listenLoopback,
  check,
  chunk,
  type EngineHandle,
  initEngine,
  makeTempDir,
  removeDir,
  sse,
  startEngine
} from './harness'

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

/** 某次请求里指定角色的最近一条消息正文（兼容字符串与内容块数组两种形态）。 */
const requestText = (body: Record<string, unknown> | undefined, role: 'system' | 'user'): string => {
  const messages = (body?.messages ?? []) as Array<{ role?: string; content?: unknown }>
  const content = messages.filter((message) => message.role === role).at(-1)?.content
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.map((block: { text?: string }) => block.text ?? '').join('\n') : ''
}

describe('MCP 座集成（协议方法 + 直连工具 + 审批链 + 禁用生效）', () => {
  beforeAll(async () => {
    const port = await listenLoopback(server)
    await initEngine(engine, {
      client: 'mcp-smoke',
      providers: [{ id: 'custom/mock', name: 'Mock', baseUrl: `http://127.0.0.1:${port}/v1`, models: ['mock'] }]
    })
  }, 60_000)

  afterAll(async () => {
    await engine.stop()
    await closeLoopback(server)
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
    // 审批挂起 = ask 默认档对 mcp__* 生效（决定 28 链路零新增）；MCP 首连 + LLM
    // 首轮在前面，放宽到 30s
    const appr = await engine.waitEvent('approval.request', (p) => p.sessionId === s2, 30_000)
    check(
      '4. ask 档只读 MCP 仍审批（toolName/kind read）',
      appr.params.toolName === 'mcp__mock__echo' && appr.params.kind === 'read',
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
    // tool.started 的 kind 与 annotations 审批分级同口径。
    const started = engine.events.find((e) => e.method === 'tool.started' && e.params.sessionId === s2)
    check('8. tool.started kind=read（annotations 分级）', started?.params.kind === 'read')

    // ———— S3 禁用 → 新会话工具消失（配置变更新会话生效） ————
    await engine.send('mcp.sync', { servers: [{ ...mockDef, enabled: false }] })
    const s3 = await newSession()
    await submitAndDone(s3, 'S3 禁用探测')
    const r3 = JSON.stringify(requestBodies[2] ?? {})
    check('9. 禁用后新会话：工具未声明给模型', !r3.includes('mcp__mock__echo'), r3.slice(0, 160))

    // 附件内容不再经 read_attachment 中转：模型对着工具目录自己选工具，带原件路径直接调用。
    await engine.send('mcp.sync', { servers: [mockDef] })
    const video = join(ws, 'video.mp4'); writeFileSync(video, 'test-video-fixture')
    const imported = await engine.send<AttachmentRef>('attachments.importPath', { path: video })
    expect(imported.error).toBeUndefined()
    const objectPath = join(home, 'attachments', 'v1', 'objects', `${imported.result!.sha256}.mp4`)
    const s4 = await newSession()
    const before4 = requestBodies.length
    ACTIONS.push({ type: 'toolCall', callId: 'vision-call', tool: 'mcp__mock__analyse_attachment', args: { path: objectPath, question: '车辆何时移动' } }, text('视频回答'))
    const pureSend = await engine.send('agent.submit', { sessionId: s4, text: '', model: 'mock', attachmentIds: [imported.result!.id] })
    expect(pureSend.result?.accepted).toBe(true)
    const directApproval = await engine.waitEvent('approval.request', (p) => p.sessionId === s4, 30_000)
    const first4 = requestText(requestBodies[before4], 'user')
    const block4 = first4.slice(first4.indexOf('<attachments>'), first4.indexOf('<attachments>') + 420)
    check(
      '10. 附件块只陈述发送状态并带原件路径，不指向任何工具',
      first4.includes('"content":"未随消息发送"') && first4.includes(JSON.stringify(objectPath).slice(1, -1)) && !first4.includes('read_attachment'),
      block4
    )
    check('11. 模型直接调用识图工具仍走审批', directApproval.params.toolName === 'mcp__mock__analyse_attachment', JSON.stringify(directApproval.params))
    await engine.send('approval.respond', { requestId: directApproval.params.requestId, approved: true })
    const vision = await engine.waitEvent('tool.completed', (p) => p.sessionId === s4 && p.callId === 'vision-call', 30_000)
    expect(vision.params.isError).toBe(false)
    await engine.waitEvent('run.completed', (p) => p.sessionId === s4, 30_000)
    expect(JSON.stringify(requestBodies.at(-1))).toContain('车辆开始移动')
    const history = await engine.send('session.messages', { sessionId: s4 })
    expect(history.result?.messages?.find((message) => message.role === 'user')).toMatchObject({ content: '', attachments: [imported.result] })

    // read_attachment 自己不再中转：视频如实报错，背后也不会调用 MCP 工具。
    const approvalsOf = (sessionId: string): number => engine.events.filter((e) => e.method === 'approval.request' && e.params.sessionId === sessionId).length
    const approvalsBefore = approvalsOf(s4)
    ACTIONS.push({ type: 'toolCall', callId: 'read-refuse', tool: 'read_attachment', args: { id: imported.result!.id } }, text('无法提取文字'))
    await engine.send('agent.submit', { sessionId: s4, text: '读一下这个附件', model: 'mock' })
    const refused = await engine.waitEvent('tool.completed', (p) => p.sessionId === s4 && p.callId === 'read-refuse', 30_000)
    await engine.waitEvent('run.completed', (p) => p.sessionId === s4, 30_000)
    check('12. read_attachment 对视频如实报错，只说自己的边界', refused.params.isError === true && String(refused.params.summary ?? '').includes('只提取文字'), String(refused.params.summary))
    check('13. read_attachment 报错不触发任何 MCP 审批（没有嵌套调用）', approvalsOf(s4) === approvalsBefore, `${approvalsBefore} → ${approvalsOf(s4)}`)

    for (const decision of ['deny', 'abort']) {
      const sid = await newSession()
      ACTIONS.push({ type: 'toolCall', callId: `vision-${decision}`, tool: 'mcp__mock__analyse_attachment', args: { path: objectPath, question: '车辆何时移动' } })
      if (decision === 'deny') ACTIONS.push(text('分析被拒绝'))
      await engine.send('agent.submit', { sessionId: sid, text: '分析附件', model: 'mock', attachmentIds: [imported.result!.id] })
      const pending = await engine.waitEvent('approval.request', (p) => p.sessionId === sid, 30_000)
      if (decision === 'deny') {
        await engine.send('approval.respond', { requestId: pending.params.requestId, approved: false })
        const failed = await engine.waitEvent('tool.completed', (p) => p.sessionId === sid && p.callId === `vision-${decision}`, 30_000)
        expect(failed.params.isError).toBe(true)
        await engine.waitEvent('run.completed', (p) => p.sessionId === sid, 30_000)
      } else {
        await engine.send('agent.abort', { sessionId: sid })
        const stopped = await engine.waitEvent('run.failed', (p) => p.sessionId === sid, 30_000)
        expect(stopped.params.reason).toBe('aborted')
      }
    }

    // ———— S5 deferred：系统提示的目录列出工具名，模型按名字搜索后带路径直接调用 ————
    await engine.send('mcp.sync', { servers: [{ ...mockDef, exposure: 'deferred' }] })
    const s5 = await newSession()
    const before5 = requestBodies.length
    ACTIONS.push(
      { type: 'toolCall', callId: 'search-5', tool: 'tool_search', args: { query: 'mock analyse_attachment' } },
      { type: 'toolCall', callId: 'vision-5', tool: 'mcp__mock__analyse_attachment', args: { path: objectPath, question: '车辆何时移动' } },
      text('S5 done')
    )
    await engine.send('agent.submit', { sessionId: s5, text: 'S5 识图', model: 'mock', attachmentIds: [imported.result!.id] })
    const search5 = await engine.waitEvent('tool.completed', (p) => p.sessionId === s5 && p.callId === 'search-5', 30_000)
    const first5 = requestText(requestBodies[before5], 'system')
    const tools5 = JSON.stringify(((requestBodies[before5]?.tools ?? []) as Array<{ function?: { name?: string } }>).map((item) => item.function?.name))
    const catalog5 = first5.slice(first5.indexOf('Available MCP servers'), first5.indexOf('Available MCP servers') + 240)
    check(
      '14. deferred：首轮不声明 MCP 工具，但系统提示的目录列出工具名',
      first5.includes('  - analyse_attachment:') && first5.includes('mock echo server') && !tools5.includes('mcp__mock__analyse_attachment') && tools5.includes('tool_search'),
      catalog5
    )
    check('15. 按目录里的名字搜索能加载工具', search5.params.isError === false && String(search5.params.summary ?? '').includes('mcp__mock__analyse_attachment'), String(search5.params.summary))
    const approval5 = await engine.waitEvent('approval.request', (p) => p.sessionId === s5, 30_000)
    expect(approval5.params.toolName).toBe('mcp__mock__analyse_attachment')
    await engine.send('approval.respond', { requestId: approval5.params.requestId, approved: true })
    const vision5 = await engine.waitEvent('tool.completed', (p) => p.sessionId === s5 && p.callId === 'vision-5', 30_000)
    expect(vision5.params.isError).toBe(false)
    await engine.waitEvent('run.completed', (p) => p.sessionId === s5, 30_000)
  }, 240_000)
})
