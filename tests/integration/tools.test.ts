/**
 * 工具循环集成测试 —— 原 tmp/cogent-smoke/tools-smoke.mjs 正名迁移
 * （2026-11-10 批次 1 建立，2026-11-11 批次 3 扩全量；断言与场景流原样，
 * 载体从手写 check 计数换 Vitest expect，D6）。
 *
 * mock SSE（18940）+ 引擎驱动 + 断言三合一，临时 COGENT_HOME 隔离。
 * 场景流一条到底（单 it）：动作队列按请求序弹（串行驱动顺序确定），
 * 中途任何断言失败即终止 —— 与原脚本的 exit 语义一致。
 *
 * 场景：
 *  S1 基本循环：read 相对路径 → tool.* 事件 → 段化终态 → 工具结果回灌二轮
 *  S2 只读不限界：绝对路径读工作区外
 *  S3 截断护栏（3.1）：行数上限 / 字节上限 / 单行超限 三态
 *  S4 grep 长行：truncateLine 的 [truncated] 标注
 *  S5 并发写队列（3.2）：同批并行 4 写（race×2 + 不同文件×2）→ 同文件串行
 *  S6 杀引擎重启：session.messages 历史回查 toolCalls 复原
 *  S7 无绑定会话：相对路径按主目录（覆写后的 home）兜底
 *  S8 edit / S9 bash / S10 自主模式 / S11 gitignore·grep context·ls
 *
 * mock 关键点（踩坑沉淀，勿改）：多轮分流按动作队列弹；toolCall 的 call id
 * 逐次唯一（配对按 toolCallId）；重启后的引擎是内存态白纸 —— 凭据/自定义
 * provider 要重灌。
 */
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import {
  check,
  chunk,
  type EngineHandle,
  initEngine,
  makeTempDir,
  removeDir,
  sse,
  sleep,
  startEngine
} from './harness'

const PORT = 18_940
const ws = makeTempDir('cogent-tools-ws-')
const outside = makeTempDir('cogent-tools-outside-')
const home = makeTempDir('cogent-tools-home-')

// ———— 场景数据 ————
writeFileSync(join(ws, 'hello.txt'), 'hello cogent tools\nsecond line')
writeFileSync(join(outside, 'outside.txt'), 'content outside workspace')
// 行数上限：3000 短行 → 命中 2000 行截断，续读 offset=2001
writeFileSync(join(ws, 'big-lines.txt'), Array.from({ length: 3000 }, (_, i) => `L${i}`).join('\n'))
// 字节上限：300 行 × 300 字符 ≈ 90KB → 64KB(62.5KB 显示) 截断
writeFileSync(join(ws, 'big-bytes.txt'), Array.from({ length: 300 }, (_, i) => `B${i}-` + 'x'.repeat(296)).join('\n'))
// 单行超限：一整行 100KB
writeFileSync(join(ws, 'oneline.txt'), 'HEAD:' + 'y'.repeat(100_000))
// grep 长行：2000 字符单行含 NEEDLE → truncateLine 截断 + 标注
writeFileSync(join(ws, 'needle.txt'), 'z'.repeat(2000) + 'NEEDLE')
// S5 并发写内容（各 ~200KB：writeFile 分多块写，无队列时高概率交错撕裂）
const RACE_A = Array.from({ length: 2000 }, (_, i) => `A${i}-${'a'.repeat(96)}`).join('\n')
const RACE_B = Array.from({ length: 2000 }, (_, i) => `B${i}-${'b'.repeat(96)}`).join('\n')
// S7 无绑定会话：主目录（= 覆写后的 home）下放文件
writeFileSync(join(home, 'homefile.txt'), 'from isolated home')
// S8 edit 工具场景数据
writeFileSync(join(ws, 'edit-me.txt'), 'alpha\nbeta\ngamma\n')
writeFileSync(join(ws, 'dup.txt'), 'x\nfoo\ny\nfoo\nz\n')
writeFileSync(join(ws, 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n')
// S9 bash 工具：平台方言命令 + 心跳孤儿探针脚本
const IS_WIN = process.platform === 'win32'
const bigPrint = IS_WIN ? '1..3000 | ForEach-Object { "line $_" }' : 'for i in $(seq 1 3000); do echo "line $i"; done'
const longSleep = IS_WIN ? 'Start-Sleep -Seconds 30' : 'sleep 30'
// S11 gitignore / grep context / ls 场景数据
writeFileSync(join(ws, '.gitignore'), 'ignored-dir/\n*.secret\n')
mkdirSync(join(ws, 'ignored-dir'), { recursive: true })
writeFileSync(join(ws, 'ignored-dir', 'x.ts'), 'x')
writeFileSync(join(ws, 'keep.ts'), 'keep')
writeFileSync(join(ws, 'keep.secret'), 'secret')
// 嵌套仓：外层规则止步于此（b.outer-hidden 应出现）；仓内自己的规则生效（inner-hidden.ts 应缺席）
mkdirSync(join(ws, 'nested-repo', '.git'), { recursive: true })
writeFileSync(join(ws, 'nested-repo', '.gitignore'), 'inner-hidden.ts\n')
writeFileSync(join(ws, 'nested-repo', 'a.ts'), 'a')
writeFileSync(join(ws, 'nested-repo', 'inner-hidden.ts'), 'hidden')
writeFileSync(join(ws, 'nested-repo', 'b.outer-hidden'), 'b')
// grep context：两个相隔匹配组（组间 '--' 分隔）
writeFileSync(join(ws, 'ctx.txt'), 'a\nb\nMATCH\nc\nd\ne\nMATCH\nf')
writeFileSync(
  join(ws, 'hb.mjs'),
  "import { appendFileSync } from 'node:fs'\n" +
    'let i = 0\n' +
    "const tick = () => appendFileSync(new URL('./beat.txt', import.meta.url), `${++i}\\n`)\n" +
    'tick()\n' +
    'setInterval(tick, 200)\n'
)

// ———— mock 端点：动作队列 ————

type Action =
  | { type: 'text'; text: string }
  | { type: 'toolCall'; callId: string; tool: string; args: Record<string, unknown> }
  | { type: 'toolCallBatch'; calls: Array<{ id: string; tool: string; args: Record<string, unknown> }> }
const text = (t: string): Action => ({ type: 'text', text: t })
const readCall = (callId: string, args: Record<string, unknown>): Action => ({ type: 'toolCall', callId, tool: 'read', args })

// 动作序 = 请求序（每场景 = toolCall + text 两动作、独立会话，串行驱动完全确定）
const ACTIONS: Action[] = [
  readCall('c1', { path: 'hello.txt' }), // S1
  text('S1 done'),
  readCall('c2', { path: join(outside, 'outside.txt') }), // S2
  text('S2 done'),
  readCall('c3', { path: 'big-lines.txt' }), // S3a 行数上限
  text('S3a done'),
  readCall('c4', { path: 'big-bytes.txt' }), // S3b 字节上限
  text('S3b done'),
  readCall('c5', { path: 'oneline.txt' }), // S3c 单行超限
  text('S3c done'),
  readCall('c8', { path: 'big-lines.txt', limit: 3000 }), // S3d 显式 limit 超行数上限 → 截断器切
  text('S3d done'),
  { type: 'toolCall', callId: 'c6', tool: 'grep', args: { pattern: 'NEEDLE' } }, // S4
  text('S4 done'),
  {
    // S5：一个响应带 4 个 tool_calls（同批并行：race×2 同文件 + p1/p2 不同文件）
    type: 'toolCallBatch',
    calls: [
      { id: 'w1', tool: 'write', args: { path: 'race.txt', content: RACE_A } },
      { id: 'w2', tool: 'write', args: { path: 'race.txt', content: RACE_B } },
      { id: 'w3', tool: 'write', args: { path: 'p1.txt', content: 'P1' } },
      { id: 'w4', tool: 'write', args: { path: 'p2.txt', content: 'P2' } }
    ]
  },
  text('S5 done'),
  readCall('c7', { path: 'homefile.txt' }), // S7（重启后的新引擎）
  text('S7 done'),
  // S8 edit 工具（2026-11-11 步骤 3.3；请求序 r18 起）
  { type: 'toolCall', callId: 'e1', tool: 'edit', args: { path: 'edit-me.txt', edits: [{ oldText: 'beta', newText: 'BETA' }] } },
  text('E1 done'),
  { type: 'toolCall', callId: 'e2', tool: 'edit', args: { path: 'dup.txt', edits: [{ oldText: 'foo', newText: 'FOO' }] } }, // 多处匹配
  text('E2 done'),
  { type: 'toolCall', callId: 'e3', tool: 'edit', args: { path: 'edit-me.txt', edits: [{ oldText: 'NOPE', newText: 'x' }] } }, // 旧串不存在
  text('E3 done'),
  { type: 'toolCall', callId: 'e4', tool: 'edit', args: { path: 'crlf.txt', edits: [{ oldText: 'two', newText: 'TWO' }] } }, // CRLF 保留
  text('E4 done'),
  { type: 'toolCall', callId: 'e5', tool: 'edit', args: { path: join(outside, 'nope.txt'), edits: [{ oldText: 'a', newText: 'b' }] } }, // 越界拦截
  text('E5 done'),
  // S9 bash 工具（2026-11-11 步骤 3.4；请求序 r28 起）
  { type: 'toolCall', callId: 'b1', tool: 'bash', args: { command: 'echo cogent-bash-ok' } },
  text('B1 done'),
  { type: 'toolCall', callId: 'b3', tool: 'bash', args: { command: bigPrint } }, // 输出截断
  text('B3 done'),
  { type: 'toolCall', callId: 'b4', tool: 'bash', args: { command: longSleep, timeout: 1 } }, // 超时杀树
  text('B4 done'),
  { type: 'toolCall', callId: 'b5', tool: 'bash', args: { command: 'exit 3' } }, // 非零退出码
  text('B5 done'),
  { type: 'toolCall', callId: 'b6', tool: 'bash', args: { command: 'node hb.mjs' } }, // abort 杀树（无二轮请求）
  // S10 自主模式（2026-11-11 步骤 3.5 D6：写信任 / exec 询问；b6 被 abort 无二轮，a1 从 r37 起）
  { type: 'toolCall', callId: 'a1', tool: 'write', args: { path: 'autonomous-me.txt', content: 'A1' } },
  text('S10a done'),
  { type: 'toolCall', callId: 'a2', tool: 'bash', args: { command: 'echo hi' } },
  text('S10b done'),
  // S11（2026-11-11 步骤 3.6；请求序 r41 起）
  { type: 'toolCall', callId: 'g1', tool: 'glob', args: { pattern: '**/*' } },
  text('S11a done'),
  { type: 'toolCall', callId: 'g2', tool: 'grep', args: { pattern: 'MATCH', path: 'ctx.txt', context: 1 } },
  text('S11b done'),
  { type: 'toolCall', callId: 'g3', tool: 'ls', args: {} },
  text('S11c done')
]
let actionIndex = 0
/** 二轮请求体留存（断言工具结果回灌/截断提示进模型上下文） */
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
    } else if (action.type === 'toolCallBatch') {
      res.write(
        sse(
          chunk({
            tool_calls: action.calls.map((c, i) => ({
              index: i,
              id: c.id,
              type: 'function',
              function: { name: c.tool, arguments: JSON.stringify(c.args) }
            }))
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

// ———— 引擎驱动（harness） ————

let engine: EngineHandle = startEngine(home)

const newSession = async (params: Record<string, unknown> = {}): Promise<string> => {
  const r = await engine.send('session.create', params)
  if (r.result?.id === undefined) throw new Error(`session.create 失败: ${JSON.stringify(r.error ?? r.result)}`)
  return r.result.id
}

/** 提交并等 run.completed（每场景的收尾同步点） */
const submitAndDone = async (sessionId: string, label: string): Promise<void> => {
  await engine.send('agent.submit', { sessionId, text: label, model: 'mock' })
  await engine.waitEvent('run.completed', (p) => p.sessionId === sessionId)
}

describe('工具循环集成（S1–S11 场景流，原 tools-smoke.mjs）', () => {
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r))
    await initEngine(engine, {
      client: 'tools-smoke',
      port: PORT,
      providers: [{ id: 'custom/mock', name: 'Mock', baseUrl: `http://127.0.0.1:${PORT}/v1`, models: ['mock'] }]
    })
  }, 60_000)

  afterAll(() => {
    engine.kill()
    server.close()
    for (const dir of [home, ws, outside]) removeDir(dir)
  })

  it('场景流一条到底（断言编号沿用开发.md 配方时代的编号）', async () => {
    // ———— S1 基本循环 ————
    const s1 = await newSession({ cwd: ws })
    await engine.send('agent.submit', { sessionId: s1, text: '读 hello.txt', model: 'mock' })
    const started = await engine.waitEvent('tool.started', (p) => p.sessionId === s1)
    check(
      '1. tool.started（kind/summary 来自引擎元数据表）',
      started.params.kind === 'read' && (started.params.summary ?? '').includes('hello.txt'),
      JSON.stringify(started.params)
    )
    const completed = await engine.waitEvent('tool.completed', (p) => p.sessionId === s1)
    check('2. tool.completed 非 error', completed.params.isError === false)
    const done1 = await engine.waitEvent('run.completed', (p) => p.sessionId === s1)
    const segs = done1.params.messages ?? []
    const seg0Calls = segs[0]?.toolCalls
    check(
      '3. 段化终态两段（工具轮 + 文本轮）',
      segs.length === 2 && seg0Calls?.length === 1 && seg0Calls[0]?.name === 'read' && segs[1]?.content === 'S1 done',
      JSON.stringify(segs.map((s) => ({ c: s.content.slice(0, 20), t: s.toolCalls?.length })))
    )
    check('4. 聚合 message 兼容形态带 toolCalls', (done1.params.message?.toolCalls?.length ?? 0) === 1)
    // 二轮请求体 = requestBodies[1]（一轮 0，二轮 1）：含工具结果原文 = 循环闭合
    const round2 = JSON.stringify(requestBodies[1] ?? {})
    check('5. 二轮请求体含文件内容（工具循环闭合）', round2.includes('hello cogent tools') && round2.includes('second line'))

    // ———— S2 绝对路径读工作区外 ————
    const s2 = await newSession({ cwd: ws })
    await submitAndDone(s2, '读工作区外')
    const outsideEnd = engine.events.find(
      (e) => e.method === 'tool.completed' && e.params.sessionId === s2 && e.params.callId === 'c2'
    )
    check('6. 绝对路径读工作区外成功', outsideEnd !== undefined && outsideEnd.params.isError === false)
    const roundS2 = JSON.stringify(requestBodies[3] ?? {})
    check('6b. 工作区外内容回灌', roundS2.includes('content outside workspace'))

    // ———— S3 截断护栏（每文件独立会话，请求序 = r4..r9） ————
    const s3a = await newSession({ cwd: ws })
    await submitAndDone(s3a, '读 big-lines')
    const rLines = JSON.stringify(requestBodies[5] ?? {})
    check(
      '7. 行数上限：默认 limit 停在 2000 行 + offset=2001 续读提示（含截断器外的 limit 分支）',
      rLines.includes('共 3000 行') && rLines.includes('offset=2001'),
      rLines.slice(0, 200)
    )
    const s3b = await newSession({ cwd: ws })
    await submitAndDone(s3b, '读 big-bytes')
    const rBytes = JSON.stringify(requestBodies[7] ?? {})
    check(
      '8. 字节上限：截断提示含 62.5KB 与续读 offset',
      rBytes.includes('已截断') && rBytes.includes('62.5KB 上限') && /offset=\d+/.test(rBytes),
      rBytes.slice(0, 200)
    )
    const s3c = await newSession({ cwd: ws })
    await submitAndDone(s3c, '读 oneline')
    const rOne = JSON.stringify(requestBodies[9] ?? {})
    check(
      '9. 单行超限：提示单行尺寸 + 仅显示开头 + grep 指引',
      rOne.includes('单行') && rOne.includes('仅显示开头') && rOne.includes('grep'),
      rOne.slice(0, 200)
    )
    // S3d：显式 limit=3000 → 业务切片 3000 行，统一截断器行数上限真触发（已截断文案）
    const s3d = await newSession({ cwd: ws })
    await submitAndDone(s3d, '读 big-lines 全量')
    const rLimit = JSON.stringify(requestBodies[11] ?? {})
    check(
      '9b. 显式 limit 超 2000 行 → 截断器行数上限触发（已截断 + offset=2001）',
      rLimit.includes('已截断') && rLimit.includes('行数上限') && rLimit.includes('offset=2001'),
      rLimit.slice(0, 200)
    )

    // ———— S4 grep 长行截断标注 ————
    const s4 = await newSession({ cwd: ws })
    await submitAndDone(s4, '搜 NEEDLE')
    const rGrep = JSON.stringify(requestBodies[13] ?? {})
    check(
      '10. 长匹配行带 [truncated] 标注（不再静默切）',
      rGrep.includes('needle.txt:1:') && rGrep.includes('... [truncated]'),
      rGrep.slice(0, 200)
    )

    // ———— S5 并发写队列 ————
    const s5 = await newSession({ cwd: ws })
    await engine.send('session.setPermission', { sessionId: s5, mode: 'auto' })
    await submitAndDone(s5, '并行写四个文件')
    const wCompletes = engine.events.filter((e) => e.method === 'tool.completed' && e.params.sessionId === s5)
    check('11a. 四个写全部完成（无死锁）', wCompletes.length === 4, `got ${wCompletes.length}`)
    const race = existsSync(join(ws, 'race.txt')) ? readFileSync(join(ws, 'race.txt'), 'utf-8') : ''
    check(
      '11. 同文件并发写串行化：race.txt = A 或 B 完整内容（无交错撕裂）',
      race === RACE_A || race === RACE_B,
      `len=${race.length} A=${RACE_A.length} B=${RACE_B.length}`
    )
    check(
      '12. 不同文件不互斥：p1/p2 都落盘',
      existsSync(join(ws, 'p1.txt')) &&
        existsSync(join(ws, 'p2.txt')) &&
        readFileSync(join(ws, 'p1.txt'), 'utf-8') === 'P1' &&
        readFileSync(join(ws, 'p2.txt'), 'utf-8') === 'P2'
    )

    // ———— S6 杀引擎重启：历史回查 ————
    engine.kill()
    await sleep(300)
    engine = startEngine(home)
    await initEngine(engine, {
      client: 'tools-smoke',
      port: PORT,
      providers: [{ id: 'custom/mock', name: 'Mock', baseUrl: `http://127.0.0.1:${PORT}/v1`, models: ['mock'] }]
    })
    const history = await engine.send('session.messages', { sessionId: s1 })
    const toolMsg = (history.result?.messages ?? []).find((m) => (m.toolCalls?.length ?? 0) > 0)
    const tc0 = toolMsg?.toolCalls?.[0]
    check(
      '13. 重启后 toolCalls 复原（配对 status ok + resultSummary）',
      tc0 !== undefined && tc0.status === 'ok' && (tc0.resultSummary?.length ?? 0) > 0,
      JSON.stringify(history.result?.messages?.map((m) => m.toolCalls?.length))
    )

    // ———— S7 无绑定会话：主目录兜底 ————
    const s7 = await newSession({})
    await submitAndDone(s7, '读主目录文件')
    const homeEnd = engine.events.find(
      (e) => e.method === 'tool.completed' && e.params.sessionId === s7 && e.params.callId === 'c7'
    )
    check('14. 相对路径读覆写主目录成功', homeEnd !== undefined && homeEnd.params.isError === false)

    // ———— S8 edit 工具（步骤 3.3） ————
    // E1 精确替换 + diff：auto 会话（edit 属写类，冒烟不逐次走审批 —— 审批矩阵
    // 对非 read kind 通用，S5 已验证 write 路径）
    const s8 = await newSession({ cwd: ws })
    await engine.send('session.setPermission', { sessionId: s8, mode: 'auto' })
    await engine.send('agent.submit', { sessionId: s8, text: 'E1 精确替换', model: 'mock' })
    const e1End = await engine.waitEvent('tool.completed', (p) => p.sessionId === s8 && p.callId === 'e1')
    check(
      '15. 精确替换落盘 + 结果非 error',
      e1End.params.isError === false && readFileSync(join(ws, 'edit-me.txt'), 'utf-8') === 'alpha\nBETA\ngamma\n'
    )
    check(
      '16a. diff 进 tool.completed 事件（+/- 行带 BETA）',
      typeof e1End.params.diff === 'string' && e1End.params.diff.includes('+') && e1End.params.diff.includes('BETA'),
      JSON.stringify(e1End.params.diff).slice(0, 160)
    )
    await engine.waitEvent('run.completed', (p) => p.sessionId === s8)
    const e1History = await engine.send('session.messages', { sessionId: s8 })
    const e1ToolMsg = (e1History.result?.messages ?? []).find((m) => (m.toolCalls?.length ?? 0) > 0)
    check(
      '16b. 历史回查带 diff（重启前同一形状）',
      typeof e1ToolMsg?.toolCalls?.[0].diff === 'string' && e1ToolMsg.toolCalls[0].diff.includes('BETA')
    )
    // E2 多处匹配：error 结果含出现次数
    const s8b = await newSession({ cwd: ws })
    await engine.send('session.setPermission', { sessionId: s8b, mode: 'auto' })
    await engine.send('agent.submit', { sessionId: s8b, text: 'E2 多处', model: 'mock' })
    const e2End = await engine.waitEvent('tool.completed', (p) => p.sessionId === s8b && p.callId === 'e2')
    check('17. 多处匹配报错（含次数）', e2End.params.isError === true && (e2End.params.summary ?? '').includes('2 次'), e2End.params.summary)
    await engine.waitEvent('run.completed', (p) => p.sessionId === s8b)
    check('17b. 多处匹配文件未动', readFileSync(join(ws, 'dup.txt'), 'utf-8') === 'x\nfoo\ny\nfoo\nz\n')
    // E3 旧串不存在
    const s8c = await newSession({ cwd: ws })
    await engine.send('session.setPermission', { sessionId: s8c, mode: 'auto' })
    await engine.send('agent.submit', { sessionId: s8c, text: 'E3 不存在', model: 'mock' })
    const e3End = await engine.waitEvent('tool.completed', (p) => p.sessionId === s8c && p.callId === 'e3')
    check('18. 旧串不存在报错（含找不到）', e3End.params.isError === true && (e3End.params.summary ?? '').includes('找不到'), e3End.params.summary)
    await engine.waitEvent('run.completed', (p) => p.sessionId === s8c)
    // E4 CRLF 文件编辑：未触碰行保留 CRLF
    const s8d = await newSession({ cwd: ws })
    await engine.send('session.setPermission', { sessionId: s8d, mode: 'auto' })
    await engine.send('agent.submit', { sessionId: s8d, text: 'E4 CRLF', model: 'mock' })
    const e4End = await engine.waitEvent('tool.completed', (p) => p.sessionId === s8d && p.callId === 'e4')
    const crlfAfter = readFileSync(join(ws, 'crlf.txt'), 'utf-8')
    check(
      '19. CRLF 文件编辑：未触碰行行尾保留',
      e4End.params.isError === false && crlfAfter === 'one\r\nTWO\r\nthree\r\n',
      JSON.stringify(crlfAfter)
    )
    await engine.waitEvent('run.completed', (p) => p.sessionId === s8d)
    // E5 越界：软边界拦截（auto 模式下边界依然生效 —— 边界在工具执行层）
    const s8e = await newSession({ cwd: ws })
    await engine.send('session.setPermission', { sessionId: s8e, mode: 'auto' })
    await engine.send('agent.submit', { sessionId: s8e, text: 'E5 越界', model: 'mock' })
    const e5End = await engine.waitEvent('tool.completed', (p) => p.sessionId === s8e && p.callId === 'e5')
    check('20. 越界 edit 被拦（error 含边界提示）', e5End.params.isError === true && (e5End.params.summary ?? '').includes('边界'), e5End.params.summary)
    await engine.waitEvent('run.completed', (p) => p.sessionId === s8e)
    check('20b. 越界目标未落盘', !existsSync(join(outside, 'nope.txt')))

    // ———— S9 bash 工具（步骤 3.4） ————
    const bashSession = async (): Promise<string> => {
      const s = await newSession({ cwd: ws })
      await engine.send('session.setPermission', { sessionId: s, mode: 'auto' })
      return s
    }
    // B1 echo 往返
    const s9 = await bashSession()
    await engine.send('agent.submit', { sessionId: s9, text: 'B1 echo', model: 'mock' })
    const b1End = await engine.waitEvent('tool.completed', (p) => p.sessionId === s9 && p.callId === 'b1', 15_000)
    await engine.waitEvent('run.completed', (p) => p.sessionId === s9)
    const rB1 = JSON.stringify(requestBodies[29] ?? {})
    check(
      '21. echo 往返（非 error + 输出回灌二轮）',
      b1End.params.isError === false && rB1.includes('cogent-bash-ok'),
      (b1End.params.summary ?? '').slice(0, 120)
    )
    // B3 大输出：截断 + tool.progress 流式事件
    const s9b = await bashSession()
    await engine.send('agent.submit', { sessionId: s9b, text: 'B3 大输出', model: 'mock' })
    await engine.waitEvent('tool.progress', (p) => p.sessionId === s9b && p.callId === 'b3' && (p.text ?? '').includes('line'), 15_000)
    check('22. tool.progress 流式事件到达（快照含输出）', true)
    const b3End = await engine.waitEvent('tool.completed', (p) => p.sessionId === s9b && p.callId === 'b3', 15_000)
    await engine.waitEvent('run.completed', (p) => p.sessionId === s9b)
    const rB3 = JSON.stringify(requestBodies[31] ?? {})
    check(
      '23. 输出截断（尾部保留 + 显示行区间提示 + 全文临时文件）',
      b3End.params.isError === false && rB3.includes('显示第') && rB3.includes('全文'),
      rB3.slice(0, 200)
    )
    // B4 超时击杀
    const s9c = await bashSession()
    await engine.send('agent.submit', { sessionId: s9c, text: 'B4 超时', model: 'mock' })
    const b4End = await engine.waitEvent('tool.completed', (p) => p.sessionId === s9c && p.callId === 'b4', 15_000)
    await engine.waitEvent('run.completed', (p) => p.sessionId === s9c)
    const rB4 = JSON.stringify(requestBodies[33] ?? {})
    check('24. 超时击杀（error + 超时状态行）', b4End.params.isError === true && rB4.includes('超时'), (b4End.params.summary ?? '').slice(0, 120))
    // B5 非零退出码
    const s9d = await bashSession()
    await engine.send('agent.submit', { sessionId: s9d, text: 'B5 退出码', model: 'mock' })
    const b5End = await engine.waitEvent('tool.completed', (p) => p.sessionId === s9d && p.callId === 'b5', 15_000)
    await engine.waitEvent('run.completed', (p) => p.sessionId === s9d)
    const rB5 = JSON.stringify(requestBodies[35] ?? {})
    check('25. 非零退出码（error + 退出码 3）', b5End.params.isError === true && rB5.includes('退出码 3'), (b5End.params.summary ?? '').slice(0, 120))
    // B6 abort 杀树无孤儿：心跳文件在 abort 后停止增长
    const s9e = await bashSession()
    await engine.send('agent.submit', { sessionId: s9e, text: 'B6 abort', model: 'mock' })
    await engine.waitEvent('tool.started', (p) => p.sessionId === s9e && p.callId === 'b6', 15_000)
    await sleep(1500) // 心跳积累几拍
    await engine.send('agent.abort', { sessionId: s9e })
    await engine.waitEvent('run.failed', (p) => p.sessionId === s9e, 15_000)
    await sleep(2000) // 若有孤儿，此刻仍在追加
    const beat1 = readFileSync(join(ws, 'beat.txt'), 'utf-8').split('\n').length
    await sleep(1200)
    const beat2 = readFileSync(join(ws, 'beat.txt'), 'utf-8').split('\n').length
    check('26. abort 杀树无孤儿（心跳文件停止增长）', beat1 === beat2 && beat1 >= 3, `beat1=${beat1} beat2=${beat2}`)

    // ———— S10 自主模式（步骤 3.5 D6） ————
    const s10 = await newSession({ cwd: ws })
    await engine.send('session.setPermission', { sessionId: s10, mode: 'autonomous' })
    await engine.send('agent.submit', { sessionId: s10, text: 'S10a 写文件', model: 'mock' })
    const a1End = await engine.waitEvent('tool.completed', (p) => p.sessionId === s10 && p.callId === 'a1', 15_000)
    await engine.assertNoEvent('approval.request', (p) => p.sessionId === s10)
    check(
      '27. autonomous 写零审批直写',
      a1End.params.isError === false && existsSync(join(ws, 'autonomous-me.txt')),
      (a1End.params.summary ?? '').slice(0, 120)
    )
    await engine.waitEvent('run.completed', (p) => p.sessionId === s10)
    const s10b = await newSession({ cwd: ws })
    await engine.send('session.setPermission', { sessionId: s10b, mode: 'autonomous' })
    await engine.send('agent.submit', { sessionId: s10b, text: 'S10b bash', model: 'mock' })
    const a2req = await engine.waitEvent('approval.request', (p) => p.sessionId === s10b, 15_000)
    check(
      '28. autonomous 下 bash 仍询问（kind exec）',
      a2req.params.toolName === 'bash' && a2req.params.kind === 'exec',
      JSON.stringify(a2req.params).slice(0, 120)
    )
    await engine.send('approval.respond', { requestId: a2req.params.requestId, approved: false })
    const a2End = await engine.waitEvent('tool.completed', (p) => p.sessionId === s10b && p.callId === 'a2', 15_000)
    check('29. 拒绝后工具 error（拒绝原因回模型）', a2End.params.isError === true && (a2End.params.summary ?? '').includes('拒绝'))
    await engine.waitEvent('run.completed', (p) => p.sessionId === s10b)

    // ———— S11 批次 1 工具加固（步骤 3.6） ————
    // S11a glob 尊重 .gitignore（外层规则 + 嵌套仓边界）
    const s11 = await newSession({ cwd: ws })
    await submitAndDone(s11, 'S11a glob')
    const rGlob = JSON.stringify(requestBodies[42] ?? {})
    check(
      '30. gitignore：外层规则生效（ignored-dir/*.secret 缺席，keep.ts 在）',
      rGlob.includes('keep.ts') && !rGlob.includes('ignored-dir') && !rGlob.includes('.secret'),
      rGlob.slice(0, 160)
    )
    check(
      '31. 嵌套仓边界：外层规则止步（b.outer-hidden 在），仓内规则生效（inner-hidden 缺席）',
      rGlob.includes('b.outer-hidden') && rGlob.includes('nested-repo/a.ts') && !rGlob.includes('inner-hidden'),
      rGlob.slice(0, 160)
    )
    // S11b grep context：path:N: 匹配行 + path-N- 上下文行 + '--' 分组
    const s11b = await newSession({ cwd: ws })
    await submitAndDone(s11b, 'S11b grep context')
    const rCtx = JSON.stringify(requestBodies[44] ?? {})
    check(
      '32. grep context：匹配行 + 上下文行（-N- 前缀）+ 组间 -- 分隔',
      rCtx.includes('ctx.txt:3:MATCH') && rCtx.includes('ctx.txt-2-b') && rCtx.includes('ctx.txt-4-c') && rCtx.includes('ctx.txt-6-e') && rCtx.includes('--'),
      rCtx.slice(0, 200)
    )
    // S11c ls：目录速览（含点文件）
    const s11c = await newSession({ cwd: ws })
    await submitAndDone(s11c, 'S11c ls')
    const rLs = JSON.stringify(requestBodies[46] ?? {})
    check(
      '33. ls 列目录一层（文件在列，嵌套仓目录带 / 尾）',
      rLs.includes('hello.txt') && rLs.includes('.gitignore') && rLs.includes('nested-repo/'),
      rLs.slice(0, 200)
    )
  }, 240_000)
})
