/**
 * 审批集成测试 —— respond 扩参（附言/always/switchMode）+ 工作区规则表 +
 * 权限通告 + 越界手许（zcode 对齐语义）。
 *
 * mock SSE（18942）+ 引擎驱动 + 断言三合一，临时 COGENT_HOME 隔离。
 * 场景流一条到底（单 it）。场景（对照 docs/模块/审批与权限.md）：
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
const outside = makeTempDir('cogent-appr-up-outside-')

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
  { type: 'text', text: 'S6c done' }, // S6c 切 plan 后（通告在）
  // ———— S7 F6 定稿（zcode 对齐）————
  { type: 'toolCall', callId: 'o1', args: { path: join(outside, 'outside-ok.txt'), content: 'O1' } }, // S7a ask 越界 → 面板（outsideRoots）→ 允许 → 真落盘
  { type: 'text', text: 'S7a done' },
  { type: 'toolCall', callId: 'o2', args: { path: join(outside, 'outside-2.txt'), content: 'O2' } }, // S7b 越界再现 → 仍弹面板（规则永不覆盖越界）→ 拒绝
  { type: 'text', text: 'S7b done' },
  // S7c 用越界写触发面板（S2 的 always 规则会吃掉根内写 → 不弹）；
  // 「允许，并切换为 autonomous」在越界面板上同样成立
  { type: 'toolCall', callId: 's1', args: { path: join(outside, 'switch-me.txt'), content: 'S1' } },
  { type: 'text', text: 'S7c done' },
  { type: 'toolCall', callId: 's2', args: { path: 'default-me.txt', content: 'D' } }, // S7d 项目默认 autonomous → 根内写零审批
  { type: 'text', text: 'S7d done' } // （S7e 只建会话不跑，不耗动作）
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

describe('审批集成（S1–S6 场景流，17 项断言）', () => {
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r))
    await initEngine(engine, { client: 'approval-upgrade-smoke', port: PORT, providers: PROVIDERS })
  }, 60_000)

  afterAll(() => {
    engine.kill()
    server.close()
    for (const dir of [home, ws, outside]) removeDir(dir)
  })

  it('场景流一条到底（断言编号沿用既有编号）', { timeout: 180_000 }, async () => {
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

    // ———— S6 权限通告与时效 ————
    // 经 before_agent_start 扩展设 cogent_permission section —— pi 对
    // sections「变更才追加 patch、回放按名替换」，切换下一轮即生效且不堆积。
    // 四档全设正向文案（切回 ask 只移除段，但历史里 plan 拦截的工具 error
    // 还在，模型会据历史推断"仍只读"连试都不试 —— 四档全给当下状态，
    // 切换 = 内容替换）
    const s6 = await engine.send<{ id: string }>('session.create', { cwd: ws, permissionMode: 'auto' })
    if (s6.result?.id === undefined) throw new Error('auto 会话物化失败')
    // 收窄提为 const：下方 waitEvent 闭包里 s6.result 的属性收窄会失效（TS 只
    // 保 const 变量自身的收窄进闭包），逐处 ?? 是反模式，提出来一次到位
    const s6id = s6.result.id
    await engine.send('agent.submit', { sessionId: s6id, text: 'hi', model: 'mock' })
    await engine.waitEvent('run.completed', (p) => p.sessionId === s6id)
    const bodyA = JSON.stringify(requestBodies[requestBodies.length - 1])
    check(
      '16a. auto 物化（请求 system 含 cogent_permission 段的完全访问文案）',
      bodyA.includes('<cogent_permission>') && bodyA.includes('完全访问模式'),
      bodyA.slice(0, 160)
    )
    await engine.send('session.setPermission', { sessionId: s6id, mode: 'ask' })
    await engine.send('agent.submit', { sessionId: s6id, text: 'again', model: 'mock' })
    await engine.waitEvent('run.completed', (p) => p.sessionId === s6id)
    const bodyB = JSON.stringify(requestBodies[requestBodies.length - 1])
    check(
      '16b. 切回 ask（段换为变更前确认文案；旧 auto 文案被替换不残留）',
      bodyB.includes('<cogent_permission>') && bodyB.includes('变更前确认模式') && !bodyB.includes('完全访问模式'),
      bodyB.slice(0, 160)
    )
    await engine.send('session.setPermission', { sessionId: s6id, mode: 'plan' })
    await engine.send('agent.submit', { sessionId: s6id, text: 'once more', model: 'mock' })
    await engine.waitEvent('run.completed', (p) => p.sessionId === s6id)
    const bodyC = JSON.stringify(requestBodies[requestBodies.length - 1])
    check(
      '16c. 切 plan（段换为 plan 文案；旧 ask 文案被替换不残留）',
      bodyC.includes('<cogent_permission>') && bodyC.includes('plan（只读）模式') && !bodyC.includes('变更前确认模式'),
      bodyC.slice(0, 160)
    )

    // ———— S7 F6 定稿（zcode 对齐）：越界可手许 + 规则不覆盖越界 + 允许并切换为 ————
    // S7a：ask 越界写照常弹面板（人是最终裁决者）+ outsideRoots 标记；手许后真落盘
    const s7 = await newSession({ cwd: ws })
    await engine.send('agent.submit', { sessionId: s7, text: 'S7a 越界写', model: 'mock' })
    const req7 = await engine.waitEvent('approval.request', (p) => p.sessionId === s7)
    check(
      '17. ask 越界写照常弹面板（kind write + outsideRoots 标记）',
      req7.params.kind === 'write' && req7.params.outsideRoots === true,
      JSON.stringify(req7.params).slice(0, 120)
    )
    await engine.send('approval.respond', { requestId: req7.params.requestId, approved: true })
    const o1End = await engine.waitEvent('tool.completed', (p) => p.sessionId === s7 && p.callId === 'o1')
    await engine.waitEvent('run.completed', (p) => p.sessionId === s7)
    check(
      '18. 手许后越界写真落盘（越界请求弹面板可手许，人是最终裁决者）',
      o1End.params.isError === false && existsSync(join(outside, 'outside-ok.txt'))
    )
    // S7b：S2 的「始终允许此工作区」规则在（根内写零审批），但**永不覆盖越界**
    // —— 越界再现仍弹面板；拒绝收尾
    const s7b = await newSession({ cwd: ws })
    await engine.send('agent.submit', { sessionId: s7b, text: 'S7b 越界再现', model: 'mock' })
    const req7b = await engine.waitEvent('approval.request', (p) => p.sessionId === s7b)
    check('19. 规则永不覆盖越界（越界再现仍弹面板）', req7b.params.outsideRoots === true)
    await engine.send('approval.respond', { requestId: req7b.params.requestId, approved: false })
    const o2End = await engine.waitEvent('tool.completed', (p) => p.sessionId === s7b && p.callId === 'o2')
    await engine.waitEvent('run.completed', (p) => p.sessionId === s7b)
    check('19b. 拒绝生效（error + 未落盘）', o2End.params.isError === true && !existsSync(join(outside, 'outside-2.txt')))
    // S7c：「允许，并切换为 autonomous」—— 允许本次 + 切会话模式 + 记项目默认
    // （先建项目 cwds=[ws]，会话 cwd=ws 按 cwd 前缀归属同项目）
    await engine.send('project.create', { name: 'F6', cwds: [ws] })
    const s7c = await newSession({ cwd: ws })
    await engine.send('agent.submit', { sessionId: s7c, text: 'S7c 切换', model: 'mock' })
    const req7c = await engine.waitEvent('approval.request', (p) => p.sessionId === s7c)
    const switchResp = await engine.send<{ summary: { permissionMode?: string } }>('approval.respond', {
      requestId: req7c.params.requestId,
      approved: true,
      switchMode: 'autonomous'
    })
    check(
      '20. respond 带回切换后摘要（permissionMode=autonomous）',
      switchResp.result?.summary.permissionMode === 'autonomous',
      JSON.stringify(switchResp.result ?? {}).slice(0, 120)
    )
    const s1End = await engine.waitEvent('tool.completed', (p) => p.sessionId === s7c && p.callId === 's1')
    await engine.waitEvent('run.completed', (p) => p.sessionId === s7c)
    check('20b. 允许语义完整（本次工具执行落盘）', s1End.params.isError === false && existsSync(join(outside, 'switch-me.txt')))
    // S7d：同项目新会话（不带 permissionMode）吃项目默认 —— autonomous 写零审批
    const s7dResp = await engine.send<{ id: string; permissionMode?: string }>('session.create', { cwd: ws })
    const s7d = s7dResp.result?.id
    if (s7d === undefined) throw new Error('S7d 会话物化失败')
    check('21. 新会话吃项目默认（summary 回带 autonomous）', s7dResp.result?.permissionMode === 'autonomous')
    await engine.send('agent.submit', { sessionId: s7d, text: 'S7d 默认生效', model: 'mock' })
    const dEnd = await engine.waitEvent('tool.completed', (p) => p.sessionId === s7d && p.callId === 's2')
    await engine.waitEvent('run.completed', (p) => p.sessionId === s7d)
    await engine.assertNoEvent('approval.request', (p) => p.sessionId === s7d)
    check('21b. 项目默认 autonomous 零审批直写（default-me.txt 落盘）', dEnd.params.isError === false && existsSync(join(ws, 'default-me.txt')))
    // S7e：项目外新会话不受影响（cwd 不在任何 cwds 内 → ask 缺省，不带字段）
    const s7eResp = await engine.send<{ id: string; permissionMode?: string }>('session.create', { cwd: outside })
    check('22. 项目外会话不吃项目默认（缺省不带 = ask）', s7eResp.result?.id !== undefined && s7eResp.result.permissionMode === undefined)
  })
})
