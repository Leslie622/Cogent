/**
 * 审批交互升级集成测试 —— 原 tmp/cogent-smoke/approval-upgrade-smoke.mjs
 * 正名迁移（2026-11-11 批次 2.5 第 1 步：respond 扩参 + 规则表 + 权限通告；
 * 断言与场景流原样，载体换 Vitest，D6）。
 *
 * mock SSE（18942）+ 引擎驱动 + 断言三合一，临时 COGENT_HOME 隔离。
 * 场景流一条到底（单 it）。场景（对照 docs/计划/审批交互升级.md 第 1 步）：
 *  S1 拒绝附言：respond(false, message) → 工具 error 含「用户指示」+ 附言回灌二轮
 *  S2 始终允许：respond(true, always) → 落盘 + approvals.json 落规则 → 同根二次写零审批
 *  S3 规则复原：杀引擎重启（同 COGENT_HOME）→ 规则仍在，同根写零审批
 *  S4 无根拒绝：无绑定根会话 always → InvalidParams；普通拒绝可收尾
 *  S5 plan block：permissionMode=plan 物化 → 写工具被拦（零 approval）
 *  S6 通告时效：auto 物化 → 请求 system 含「已授予完全访问」；切 ask 后无残留；
 *              切 plan 后含「plan（只读）」
 *
 * mock 分流：动作按请求顺序弹队列；重启后 actionIndex 接续。
 */
import { createServer, type Server } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { check, chunk, type EngineHandle, initEngine, makeTempDir, removeDir, sse, sleep, startEngine } from './harness'

const PORT = 18_942
const home = makeTempDir('cogent-appr-up-home-')
const ws = makeTempDir('cogent-appr-up-ws-')

// ———— mock 端点：动作队列（write 工具固定；callId 逐次唯一） ————

type Action = { type: 'toolCall'; callId: string; args: Record<string, unknown> } | { type: 'text'; text: string }
const ACTIONS: Action[] = [
  { type: 'toolCall', callId: 'c1', args: { path: 'feedback-me.txt', content: 'x' } }, // S1 一轮（附言拒绝）
  { type: 'text', text: 'S1 done' }, // S1 二轮
  { type: 'toolCall', callId: 'c2', args: { path: 'always-me.txt', content: 'S2' } }, // S2 一轮（always）
  { type: 'text', text: 'S2 done' }, // S2 二轮
  { type: 'toolCall', callId: 'c3', args: { path: 'always-2.txt', content: 'S2b' } }, // S2 同根二次（应零审批）
  { type: 'text', text: 'S2b done' },
  { type: 'toolCall', callId: 'c4', args: { path: 'always-3.txt', content: 'S3' } }, // S3 重启后（应零审批）
  { type: 'text', text: 'S3 done' },
  { type: 'toolCall', callId: 'c5', args: { path: `cogent-smoke-nonce-${process.pid}.txt`, content: 'x' } }, // S4 无根（挂起）
  { type: 'text', text: 'S4 done' }, // S4 拒绝收尾二轮
  { type: 'toolCall', callId: 'c6', args: { path: 'plan-me.txt', content: 'x' } }, // S5 plan（block）
  { type: 'text', text: 'S5 done' },
  { type: 'text', text: 'S6a done' }, // S6a auto 通告（看请求体，无需工具）
  { type: 'text', text: 'S6b done' }, // S6b 切 ask 后（无残留）
  { type: 'text', text: 'S6c done' } // S6c 切 plan 后（通告在）
]
let actionIndex = 0
const requestBodies: Array<Record<string, unknown>> = []

const server: Server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    requestBodies.push(JSON.parse(body) as Record<string, unknown>)
    const action = ACTIONS[actionIndex++] ?? { type: 'text', text: 'fallback' }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    if (action.type === 'toolCall') {
      res.write(
        sse(
          chunk({
            tool_calls: [
              { index: 0, id: action.callId, type: 'function', function: { name: 'write', arguments: JSON.stringify(action.args) } }
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

// ———— 引擎驱动（可重启 —— S3 杀进程重拉验证规则落盘复原） ————

let engine: EngineHandle = startEngine(home)

const newSession = async (params: Record<string, unknown> = {}): Promise<string> => {
  const r = await engine.send('session.create', params)
  if (r.result?.id === undefined) throw new Error(`session.create 失败: ${JSON.stringify(r.error ?? r.result)}`)
  return r.result.id
}

const PROVIDERS = [{ id: 'custom/mock', name: 'Mock', baseUrl: `http://127.0.0.1:${PORT}/v1`, models: ['mock'] }]

describe('审批交互升级集成（S1–S6 场景流，原 approval-upgrade-smoke.mjs，17 项断言）', () => {
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r))
    await initEngine(engine, { client: 'approval-upgrade-smoke', port: PORT, providers: PROVIDERS })
  }, 60_000)

  afterAll(() => {
    engine.kill()
    server.close()
    for (const dir of [home, ws]) removeDir(dir)
  })

  it('场景流一条到底（断言编号沿用开发.md 配方时代的编号）', { timeout: 180_000 }, async () => {
    // ———— S1 拒绝附言 ————
    const s1 = await newSession({ cwd: ws })
    await engine.send('agent.submit', { sessionId: s1, text: '写 feedback-me.txt', model: 'mock' })
    const req1 = await engine.waitEvent('approval.request', (p) => p.sessionId === s1)
    const r1 = await engine.send('approval.respond', {
      requestId: req1.params.requestId,
      approved: false,
      message: '不要写这里，改写到 notes/ 目录下'
    })
    check('1. respond(false, message) 受理', r1.result?.ok === true)
    const toolEnd1 = await engine.waitEvent('tool.completed', (p) => p.sessionId === s1)
    check(
      '2. 工具 error 含「用户指示」+ 附言',
      toolEnd1.params.isError === true && (toolEnd1.params.summary ?? '').includes('用户指示') && (toolEnd1.params.summary ?? '').includes('notes/')
    )
    await engine.waitEvent('run.completed', (p) => p.sessionId === s1)
    const secondRound = requestBodies[requestBodies.length - 1]
    check('3. 附言回灌进二轮请求体（模型可见）', JSON.stringify(secondRound).includes('notes/'))
    check('4. feedback-me.txt 未落盘', !existsSync(join(ws, 'feedback-me.txt')))

    // ———— S2 始终允许此工作区 ————
    const s2 = await newSession({ cwd: ws })
    await engine.send('agent.submit', { sessionId: s2, text: '写 always-me.txt', model: 'mock' })
    const req2 = await engine.waitEvent('approval.request', (p) => p.sessionId === s2)
    const r2 = await engine.send('approval.respond', { requestId: req2.params.requestId, approved: true, always: 'workspace' })
    check('5. respond(true, always) 受理', r2.result?.ok === true)
    await engine.waitEvent('tool.completed', (p) => p.sessionId === s2 && !p.isError)
    check('6. always 语义 = 允许本次（always-me.txt 落盘）', existsSync(join(ws, 'always-me.txt')))
    const rulesDoc = JSON.parse(readFileSync(join(home, 'approvals.json'), 'utf-8')) as {
      rules?: Array<{ kind?: string; roots?: string[] }>
    }
    check('7. approvals.json 落规则（roots 含工作区根 + kind write）', rulesDoc.rules?.some((rule) => rule.kind === 'write' && rule.roots?.includes(ws)) === true)
    await engine.waitEvent('run.completed', (p) => p.sessionId === s2)
    // 同根新会话二次写：规则表放行，零审批
    const s2b = await newSession({ cwd: ws })
    await engine.send('agent.submit', { sessionId: s2b, text: '再写 always-2.txt', model: 'mock' })
    await engine.waitEvent('tool.completed', (p) => p.sessionId === s2b && !p.isError)
    await engine.assertNoEvent('approval.request', (p) => p.sessionId === s2b)
    check('8. 同根二次写零审批直落（always-2.txt）', existsSync(join(ws, 'always-2.txt')))
    await engine.waitEvent('run.completed', (p) => p.sessionId === s2b)

    // ———— S3 规则重启复原 ————
    engine.kill()
    await sleep(300)
    engine = startEngine(home)
    await initEngine(engine, { client: 'approval-upgrade-smoke', port: PORT, providers: PROVIDERS })
    const s3 = await newSession({ cwd: ws })
    await engine.send('agent.submit', { sessionId: s3, text: '重启后再写 always-3.txt', model: 'mock' })
    await engine.waitEvent('tool.completed', (p) => p.sessionId === s3 && !p.isError)
    await engine.assertNoEvent('approval.request', (p) => p.sessionId === s3)
    check('9. 重启后规则仍在（同根写零审批，always-3.txt 落盘）', existsSync(join(ws, 'always-3.txt')))
    await engine.waitEvent('run.completed', (p) => p.sessionId === s3)

    // ———— S4 无根会话 always 拒绝 ————
    const s4 = await newSession({})
    await engine.send('agent.submit', { sessionId: s4, text: '无根会话写文件', model: 'mock' })
    const req4 = await engine.waitEvent('approval.request', (p) => p.sessionId === s4)
    const r4 = await engine.send('approval.respond', { requestId: req4.params.requestId, approved: true, always: 'workspace' })
    check('10. 无根 always → InvalidParams', r4.error?.code === -32602)
    const r4b = await engine.send('approval.respond', { requestId: req4.params.requestId, approved: false })
    check('11. 报错后未消费，普通拒绝可收尾', r4b.result?.ok === true)
    await engine.waitEvent('run.completed', (p) => p.sessionId === s4)
    check('12. nonce 文件未落主目录', !existsSync(join(homedir(), `cogent-smoke-nonce-${process.pid}.txt`)))

    // ———— S5 plan block ————
    const s5 = await engine.send('session.create', { cwd: ws, permissionMode: 'plan' })
    if (s5.result?.id === undefined) throw new Error('plan 会话物化失败')
    check('13. plan 物化（摘要回带）', s5.result.permissionMode === 'plan')
    await engine.send('agent.submit', { sessionId: s5.result.id, text: 'plan 模式写文件', model: 'mock' })
    const toolEnd5 = await engine.waitEvent('tool.completed', (p) => p.sessionId === s5.result?.id)
    await engine.assertNoEvent('approval.request', (p) => p.sessionId === s5.result?.id)
    check('14. plan 写被拦（error 含原因，零审批）', toolEnd5.params.isError === true && (toolEnd5.params.summary ?? '').includes('plan'))
    check('15. plan-me.txt 未落盘', !existsSync(join(ws, 'plan-me.txt')))
    await engine.waitEvent('run.completed', (p) => p.sessionId === s5.result?.id)

    // ———— S6 权限通告与时效（1.2a 内核替换后重钉：通告面降级） ————
    // 手搓 system 通告消息与 pi 会话树（append-only 投影）不兼容，1.2a 起
    // setPermission 降级为纯 summary 记账 —— 审批判定读活值（强制面不变，
    // S2/S5 已钉），模型收不到提示词层告知（多试几次被拦的写），归 1.4
    // systemPromptOverride 动态拼段对账。此处钉降级事实：请求 system 恒无
    // 通告文本、切换模式不改变请求形状
    const s6 = await engine.send<{ id: string }>('session.create', { cwd: ws, permissionMode: 'auto' })
    if (s6.result?.id === undefined) throw new Error('auto 会话物化失败')
    await engine.send('agent.submit', { sessionId: s6.result.id, text: 'hi', model: 'mock' })
    await engine.waitEvent('run.completed', (p) => p.sessionId === s6.result?.id)
    const bodyA = requestBodies[requestBodies.length - 1]
    check('16a. auto 物化（1.2a 降级：请求 system 不含权限通告）', !JSON.stringify(bodyA).includes('已授予完全访问'))
    await engine.send('session.setPermission', { sessionId: s6.result.id, mode: 'ask' })
    await engine.send('agent.submit', { sessionId: s6.result.id, text: 'again', model: 'mock' })
    await engine.waitEvent('run.completed', (p) => p.sessionId === s6.result?.id)
    const bodyB = requestBodies[requestBodies.length - 1]
    check('16b. 切回 ask（同降级面：无通告、无残留）', !JSON.stringify(bodyB).includes('已授予完全访问'))
    await engine.send('session.setPermission', { sessionId: s6.result.id, mode: 'plan' })
    await engine.send('agent.submit', { sessionId: s6.result.id, text: 'once more', model: 'mock' })
    await engine.waitEvent('run.completed', (p) => p.sessionId === s6.result?.id)
    const bodyC = requestBodies[requestBodies.length - 1]
    check(
      '16c. 切 plan（同降级面：无通告；plan 强制拦截见 S5）',
      !JSON.stringify(bodyC).includes('plan（只读）') && !JSON.stringify(bodyC).includes('已授予完全访问')
    )
  })
})
