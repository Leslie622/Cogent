/**
 * 上下文压缩集成测试 —— 原 tmp/cogent-smoke/compaction-smoke.mjs 正名迁移
 * （2026-11-12 批次 4 + 完备化 S1–S8 + 三轮验收修复 + D9 保留式扩至 30 项；
 * 断言与场景流原样，载体换 Vitest，D6）。
 *
 * mock SSE（18941）+ 引擎驱动 + 断言三合一，临时 COGENT_HOME 隔离
 * （USERPROFILE/HOME 同步覆写）。场景流一条到底（单 it，中途失败即终止，
 * 与原脚本 exit 语义一致）。
 *
 * 场景流（一个大会话串到底 + 若干小会话）：
 *  S1 阈值自动触发（循环堆大回合到触发线；触发点动态）
 *  S2 触发回合请求体（被摘要原文消失 + 摘要投影 + 保留区 + 新问）
 *  S4 手动无可压缩（小会话）→ InvalidRequest
 *  S5 手动成功 + 迭代合并 + 7b 二次连点拒绝（D9 时间戳守卫）
 *  S3 杀引擎重启（S6 之前的场景序）：历史回查保留式复原（D9）+ 5b 请求投影
 *  S6 场景⑨：20000 窗 ≈60% 触发（余量线绑定区）
 *  S7 场景②：工具轮间 L2（run 不中断、下一请求换轨）
 *  S8 场景⑤：length 停因 toolCall 全 fail → 自愈重发
 *  S9/S10 场景③④：L1 裁剪零摘要请求 + 落盘复原
 *  S11 场景⑥：溢出恢复 + 单次闸
 *  S12 场景⑦：auto-continue 续写 + 段合并
 *  S13 思考预算通道（compat 字段名 × 档位预算）
 *  S14 场景(S2 验收 bug 回归)：轮间压缩配对完整性（请求 + 落盘转录）
 *  S15/S16 空续写拒绝 + 摘要预算守卫降级
 * （check 编号沿用开发.md 配方时代的编号，1–23 + 5b/7b/9–22 各段）
 *
 * mock 关键点（勿改）：
 *  ① contextWindow 给 24000（真实产品量级 —— 小窗口下 keepRecent(窗口/2)
 *     占比过大，"显著缩小"类断言永不成立）；
 *  ② mock 不回 usage（回合请求）：回了估算会锚在假数上永不触发阈值，不回才
 *     退回 pi-ai 纯字符口径（3.5 chars/token，可预测）；摘要请求回 usage 无此虑；
 *  ③ 事件等待带水位（waitEvent 的 __consumed）：压缩与 run 事件交错；
 *  ④ 摘要请求识别（R4 指令内联后）：看末条 user 是否为指令（护栏段固定开头
 *     'acting as a compaction engine'），同为 SSE 流按请求体特征分流。
 */
import { createServer, type Server } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
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

const PORT = 18_941
const home = makeTempDir('cogent-compaction-home-')
const ws = makeTempDir('cogent-compaction-ws-')

// ———— 推演参数（与 runtime/compaction.ts 常量的关系，细节见原脚本头注） ————
// 触发公式 = max(ctx×0.5, min(ctx×0.9, ctx−8192))：24000 窗 → 15808（余量线
// 绑定）；keepRecent = 12000。每回合 user 30000c / 3.5 ≈ 8571 tok。
const TURN_CHARS = 30_000
// 场景⑨：20000 窗 → 阈值 11808（59%）；每回合 6300c ≈ 1800 tok，7 回合触发
const TURN_CHARS_20K = 6_300
// mock 摘要文本的显式标记（断言摘要投影 / 迭代合并靠它，不依赖真实语义）
const SUMMARY_V1 = 'CHECKPOINT-V1-MARK Goal: verify compaction.'
const SUMMARY_V2 = 'CHECKPOINT-V2-MARK merged checkpoint.'

// ———— 请求体留存（断言面） ————
/** 回合请求体留存（断言被摘要原文消失 / 保留区与新问进请求） */
const requestBodies: Array<Record<string, unknown>> = []
/** 摘要请求体留存（断言迭代合并 previous-summary；带 __smokeLeadingRole 观察面） */
const summaryRequests: Array<Record<string, unknown> & { __smokeLeadingRole?: string }> = []
/** 溢出模拟计数(S5 场景⑥):按 user 指令标记计数,ONCE 前 1 次 / TWICE 前 2 次回 400 */
const overflowCounts = new Map<string, number>()

// 场景③④共用的可裁探针:单行 ≈18050c(> 裁剪线 8192,read 上限 64KB 内不截断)。
// HEAD/MID/TAIL 三标记钉在头/中/尾 —— 断言裁剪保形:头尾进保留区、middle 消失
writeFileSync(
  join(ws, 'probe.txt'),
  `PROBE-HEAD-MARK ${'p'.repeat(9_000)} PROBE-MID-MARK ${'p'.repeat(9_000)} PROBE-TAIL-MARK`
)
// 场景②专用的不可裁探针:单行 8000c(< 8192 裁剪线)—— L1 对它无动作,
// 轮间检查点只能走 L2 摘要(②验证的正是 L2 轮间触发)
writeFileSync(join(ws, 'probe2.txt'), `PROBE2-RESULT-MARK ${'q'.repeat(8_000)}`)

// ———— mock 端点：按请求体特征分流（回合 / 摘要） ————

/** 文本流响应 —— 关键点②：不带 usage 字段；finish 可指定（'length' = 截断） */
const textResponse = (res: { write: (s: string) => void; end: () => void }, text: string, finish = 'stop'): void => {
  res.write(sse(chunk({ content: text })))
  res.write(sse(chunk({}, finish)))
  res.write('data: [DONE]\n\n')
  res.end()
}
/** 摘要响应（带 usage，D9 验收后增补）：账经 completed.summaryUsage 显式下发 */
const summaryResponse = (res: { write: (s: string) => void; end: () => void }, text: string): void => {
  res.write(sse(chunk({ content: text })))
  res.write(sse(chunk({}, 'stop', { usage: { prompt_tokens: 21000, completion_tokens: 120, total_tokens: 21120 } })))
  res.write('data: [DONE]\n\n')
  res.end()
}
/** read 的 toolCall 流响应，path 由指令文本带出；finishReason 'length' = 场景⑤ */
const toolCallResponse = (
  res: { write: (s: string) => void; end: () => void },
  callId: string,
  finishReason: string,
  path: string
): void => {
  res.write(
    sse(
      chunk({
        tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path }) } }]
      })
    )
  )
  res.write(sse(chunk({}, finishReason)))
  res.write('data: [DONE]\n\n')
  res.end()
}

/** 消息文本抽取分形状：user 的 content 是 text 块数组（整串 stringify 会把
 JSON 花括号带进 (\S+) 捕获组，路径解析必炸）；tool 的 content 是纯字符串 */
const messageText = (msg: { role?: string; content?: unknown } | undefined): string => {
  if (msg === undefined) return ''
  const content = msg.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((b) => ((b as { type?: string; text?: string }).type === 'text' ? (b as { text: string }).text : '')).join('')
  }
  return ''
}

const server: Server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const payload = JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }> }
    // 溢出模拟(S5 场景⑥):末条 user 带 OVERFLOW_ONCE/TWICE 标记 → 前 N 次
    // 回 OpenAI 风格 400(pi-ai overflow 模式命中)→ 引擎删失败轮 + continue
    // 重试;ONCE 重试即成功,TWICE 重试再溢出验单次闸。必须在 SSE writeHead 之前分支
    const preLast = payload.messages?.at(-1)
    const ovMarker =
      preLast?.role === 'user'
        ? messageText(preLast).includes('OVERFLOW_ONCE')
          ? 'once'
          : messageText(preLast).includes('OVERFLOW_TWICE')
            ? 'twice'
            : null
        : null
    if (ovMarker !== null) {
      const n = (overflowCounts.get(ovMarker) ?? 0) + 1
      overflowCounts.set(ovMarker, n)
      if (n <= (ovMarker === 'once' ? 1 : 2)) {
        // 溢出请求留痕(计数断言按 requestBodies 过滤标记;放行的请求由下方
        // SSE 分支入列 —— 此处若也 push 会双计)
        requestBodies.push(payload)
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            error: {
              message:
                "This model's maximum context length is 8192 tokens. However, your messages resulted in 25570 tokens. Please reduce the length of the messages."
            }
          })
        )
        return
      }
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    // 摘要请求识别(R4 指令内联后):看末条 user 是否为摘要指令(护栏段固定开头)
    const lastMsg = payload.messages?.at(-1)
    if (lastMsg?.role === 'user' && messageText(lastMsg).includes('acting as a compaction engine')) {
      summaryRequests.push(payload)
      // 修 A 观察面:首条是否 system(真前缀形态)—— 预算守卫降级时被摘要区
      // 直传领头,user 会话首问会是第一条
      summaryRequests[summaryRequests.length - 1].__smokeLeadingRole = payload.messages?.[0]?.role ?? 'none'
      // 迭代合并：请求带 <previous-summary> 说明已有旧摘要（UPDATE 提示词）
      summaryResponse(res, body.includes('<previous-summary>') ? SUMMARY_V2 : SUMMARY_V1)
      return
    }
    // 回合请求：按最后一条消息特征分发（无状态；既有场景路径不变，②③⑤ 专用）
    requestBodies.push(payload)
    const last = payload.messages?.at(-1)
    const lastText = messageText(last)
    // 指令形如 "DO:TOOL read probe2.txt" —— 工具与目标文件从指令带出
    const directive = last?.role === 'user' ? /DO:(LEN)?TOOL\s+read\s+(\S+)/.exec(lastText) : null
    if (directive) {
      toolCallResponse(res, directive[1] ? 'call-len' : 'call-tool-ok', directive[1] ? 'length' : 'tool_calls', directive[2])
    } else if (last?.role === 'user' && lastText.includes('LENCONT')) {
      // S6 场景⑦：首答纯文本 length 截断 → 引擎 auto-continue 注入显式指令再跑
      textResponse(res, 'CONT-PART1-MARK partial answer that got cut', 'length')
    } else if (last?.role === 'user' && lastText.includes('LENEMPTY')) {
      // S15 场景(修 B 验收)：空正文 length(room 耗尽形态)→ 引擎不应注入续写,
      // 直接以截断终态收尾(此前实测空转 11 连)
      textResponse(res, '', 'length')
    } else if (last?.role === 'user' && lastText.includes('[cogent:continue]')) {
      // 引擎注入的续写指令 → 续文无缝接上（前导空格演示拼接语义）
      textResponse(res, ' CONT-PART2-MARK seamless continuation')
    } else if (last?.role === 'tool' && lastText.includes('truncated')) {
      // fail 报文回到模型 → 自愈重发完整调用（重发目标统一读 probe.txt）
      toolCallResponse(res, 'call-redo', 'tool_calls', 'probe.txt')
    } else {
      textResponse(res, `R${requestBodies.length} ack`)
    }
  })
})

// ———— 引擎驱动（harness） ————

let engine: EngineHandle = startEngine(home)

const newSession = async (params: Record<string, unknown> = {}): Promise<string> => {
  const r = await engine.send('session.create', params)
  if (r.result?.id === undefined) throw new Error(`session.create 失败: ${JSON.stringify(r.error ?? r.result)}`)
  return r.result.id
}

const MOCK_PROVIDERS = [
  {
    id: 'custom/mock',
    name: 'Mock',
    baseUrl: `http://127.0.0.1:${PORT}/v1`,
    models: ['mock'],
    // 关键点①：contextWindow 24000（ModelDef 完整定义；简写 models 只有目录
    // 兜底 128k，keepRecent 占比过小 + 阈值天文数字，永不触发）。mock20k 供
    // 场景⑨（新触发公式 60% 验收），重启后场景在末尾使用
    modelDefs: [
      { id: 'mock', contextWindow: 24_000 },
      { id: 'mock20k', contextWindow: 20_000 }
    ]
  }
]

describe('上下文压缩集成（S1–S16 场景流，原 compaction-smoke.mjs，30 项断言）', () => {
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r))
    await initEngine(engine, { client: 'compaction-smoke', port: PORT, providers: MOCK_PROVIDERS })
  }, 60_000)

  afterAll(() => {
    engine.kill()
    server.close()
    for (const dir of [home, ws]) removeDir(dir)
  })

  it('场景流一条到底（断言编号沿用开发.md 配方时代的编号）', { timeout: 600_000 }, async () => {
    // ———— S1 阈值自动触发（循环堆回合，触发点动态） ————
    const s1 = await newSession({ cwd: ws })
    const turnText = (k: number): string => `MILESTONE_${k} ` + 'x'.repeat(TURN_CHARS)
    let triggered = 0 // 触发回合号（第 triggered 次提交触发；其前 triggered-1 回合已完成）
    for (let k = 1; k <= 6; k++) {
      await engine.send('agent.submit', { sessionId: s1, text: turnText(k), model: 'mock' })
      await engine.waitEvent('run.completed', (p) => p.sessionId === s1)
      const hit = engine.events.find(
        (e) => e.method === 'compaction.started' && e.params.sessionId === s1 && e.params.reason === 'threshold'
      )
      if (hit) {
        hit.__consumed = true
        triggered = k
        break
      }
    }
    check('1. 阈值自动触发（compaction.started reason=threshold）', triggered > 0, `6 轮未触发（领头 system 估值超预期？回合数=${requestBodies.length}）`)

    const completed = await engine.waitEvent('compaction.completed', (p) => p.sessionId === s1)
    check(
      '2. completed 前后 token（显著缩小 ≥5000，摘要文本与锚点齐备）',
      (completed.params.tokensBefore ?? 0) > (completed.params.tokensAfter ?? 0) &&
        (completed.params.tokensBefore ?? 0) - (completed.params.tokensAfter ?? 0) > 5000 &&
        typeof completed.params.summary === 'string' &&
        (completed.params.summary ?? '').includes(SUMMARY_V1) &&
        (completed.params.summarizedUntil ?? 0) > 0,
      JSON.stringify({ before: completed.params.tokensBefore, after: completed.params.tokensAfter })
    )
    check(
      '23. completed 带摘要用量（摘要调用独立计账，input/totalTokens > 0）',
      (completed.params.summaryUsage?.input ?? 0) > 0 && (completed.params.summaryUsage?.totalTokens ?? 0) > 0,
      JSON.stringify(completed.params.summaryUsage)
    )

    // ———— S2 触发回合请求体：旧文消失 + 摘要投影 + 保留区 + 新问 ————
    // 触发回合的正式请求 = 最后一个回合请求（S1 循环等到 run.completed 时请求
    // 必已发出；触发回合 mock 只回 text 无工具，单请求收尾）
    const fired = JSON.stringify(requestBodies.at(-1) ?? {})
    // 被摘要区 = 触发前最后 2 回合之外的全部（切点恒在倒数第 2 个 user）；
    // 保留区 = 倒数 2 回合（triggered-2、triggered-1 的 MILESTONE）
    check(
      '3. 被摘要原文不进请求（MILESTONE_1 消失，投影层只送摘要）',
      fired.includes('MILESTONE_1 ') === false,
      fired.slice(0, 160)
    )
    check(
      '4. 摘要投影 + 保留区 + 新问同请求（convertToLlm 的 checkpoint 前导语）',
      fired.includes('automatically generated checkpoint') &&
        fired.includes(SUMMARY_V1) &&
        fired.includes(`MILESTONE_${triggered - 1} `) &&
        fired.includes(`MILESTONE_${triggered - 2} `) &&
        fired.includes(`MILESTONE_${triggered} `),
      `triggered=${triggered} ${fired.slice(0, 160)}`
    )
    // 场景⑧(S4 验收):摘要请求本身是主请求的真前缀 —— 领头 = 会话 system
    // (不再是独立 summarization system)、被摘要区原消息直传(MILESTONE 原文
    // 在请求里)、末条 = 指令 user
    const sumReq = JSON.stringify(summaryRequests[0] ?? {})
    check(
      '14. 摘要请求真前缀（会话 system 领头/无 summarization system/原消息直传/指令收尾）',
      sumReq.includes('You are Cogent') &&
        !sumReq.includes('context summarization assistant') &&
        sumReq.includes('MILESTONE_1 ') &&
        sumReq.includes('acting as a compaction engine'),
      sumReq.slice(0, 200)
    )

    // ———— S4 手动无可压缩（小会话：近期内容不足保留窗口） ————
    const s2 = await newSession({ cwd: ws })
    await engine.send('agent.submit', { sessionId: s2, text: 'tiny talk', model: 'mock' })
    await engine.waitEvent('run.completed', (p) => p.sessionId === s2)
    const compactErr = await engine.send('session.compact', { sessionId: s2 })
    check(
      '6. 小会话 compact 报「无可压缩」（协议错误，显式结果）',
      compactErr.error !== undefined && compactErr.error.message.includes('无可压缩'),
      JSON.stringify(compactErr.error ?? compactErr.result)
    )

    // ———— S5 手动成功 + 迭代合并 ————
    // 重启前的大会话直接手动 compact（同一引擎实例，model=mock 还在内存 →
    // keepRecent=12000；不垫新回合）：触发回合 user 本身就是大文本（30000c），
    // 从尾累计 8571+8571=17142 ≥ 12000 落在倒数第 2 个 user → 被摘要区 =
    // [旧保留区首回合]，非空 → 手动成功且必带 previous-summary
    const manualResult = await engine.send<{ tokensBefore?: number; tokensAfter?: number }>('session.compact', { sessionId: s1 })
    if (manualResult.error !== undefined) {
      throw new Error(`手动 compact 返回错误: ${JSON.stringify(manualResult.error)}`)
    }
    await engine.waitEvent('compaction.started', (p) => p.sessionId === s1 && p.reason === 'manual')
    check(
      '7. 手动 compact 成功（started reason=manual + 前后 token 缩小 ≥5000）',
      (manualResult.result?.tokensBefore ?? 0) > (manualResult.result?.tokensAfter ?? 0) &&
        (manualResult.result?.tokensBefore ?? 0) - (manualResult.result?.tokensAfter ?? 0) > 5000,
      JSON.stringify({ result: manualResult.result, error: manualResult.error })
    )
    const secondSummary = JSON.stringify(summaryRequests[1] ?? {})
    check(
      '8. 迭代合并（第二次摘要请求带 <previous-summary> + 旧摘要文本）',
      secondSummary.includes('<previous-summary>') && secondSummary.includes(SUMMARY_V1),
      secondSummary.slice(0, 160)
    )
    // 7b 二次连点拒绝（D9 时间戳守卫验收）：手动压缩刚结束、无新回合 ——
    // 保留式下压缩条不在末尾，旧 at(-1) 快速路径失效，新守卫（末条 bar 后无
    // 更新的非 system 消息）应判「无可压缩」，防保留区被反复重摘要
    const doubleCompact = await engine.send('session.compact', { sessionId: s1 })
    check(
      '7b. 二次连点拒绝（刚压完无新回合 → 无可压缩，D9 时间戳守卫）',
      doubleCompact.error !== undefined && doubleCompact.error.message.includes('无可压缩'),
      JSON.stringify(doubleCompact.error ?? doubleCompact.result)
    )

    // ———— S3 杀引擎重启：历史回查折叠条复原（二次压缩后的落盘形态） ————
    // 场景序说明：S3 放在手动压缩之后 —— 重启后引擎内存白纸，agent.state.model
    // 回缺省模型（200K 窗），keepRecent 随之变大，重启后立刻手动 compact 会被判
    // 「无可压缩」；放在二次压缩后反而多验一层：迭代摘要（V2）与两代被摘要区
    // 同在落盘形态里
    engine.kill()
    await sleep(300)
    engine = startEngine(home)
    await initEngine(engine, { client: 'compaction-smoke', port: PORT, providers: MOCK_PROVIDERS })
    const history = await engine.send('session.messages', { sessionId: s1 })
    const msgs = history.result?.messages ?? []
    // D9 保留式：历史 = 影子区原文 + 两条折叠条（V1 在 V2 前，各自原位）+ 保留区。
    // 旧销毁式断言（被摘要区消失、单条折叠条带 V2）整体翻转
    const bars = msgs.filter((m) => m.role === 'compaction')
    const userTexts = msgs.filter((m) => m.role === 'user').map((m) => m.content).join('\n')
    const shadowKept = Array.from({ length: triggered }, (_, i) => `MILESTONE_${i + 1} `).every((mk) => userTexts.includes(mk))
    check(
      '5. 重启后保留式复原（两条折叠条 V1/V2 原位 + 全部被摘要区原文保留）',
      bars.length === 2 &&
        (bars[0]?.content ?? '').includes(SUMMARY_V1) &&
        (bars[1]?.content ?? '').includes(SUMMARY_V2) &&
        (bars[1]?.compaction?.tokensBefore ?? 0) > (bars[1]?.compaction?.tokensAfter ?? 0) &&
        shadowKept,
      JSON.stringify({ roles: msgs.map((m) => m.role), bars: bars.map((b) => b.compaction) })
    )
    // 5b 重启后请求投影：向 s1 再提交一回合 → 请求只含**一条** checkpoint
    //（末条 bar 的投影；旧 bar V1 与影子区 MILESTONE_1 都不进请求 —— 保留式
    // 的关键差异：历史保留 ≠ 上下文保留）。若该提交触发第三次压缩，请求换
    // 成新 checkpoint（mock 对带 previous-summary 的请求仍回 V2 文本），断言不破
    await engine.send('agent.submit', { sessionId: s1, text: 'post-compaction probe', model: 'mock' })
    await engine.waitEvent('run.completed', (p) => p.sessionId === s1)
    const probeReq = JSON.stringify(requestBodies.at(-1) ?? {})
    const checkpointCount = probeReq.split('automatically generated checkpoint').length - 1
    check(
      '5b. 重启后请求投影（单 checkpoint=V2/影子区与旧 bar 不进请求）',
      checkpointCount === 1 && probeReq.includes(SUMMARY_V2) && !probeReq.includes('MILESTONE_1 '),
      `checkpoints=${checkpointCount} ${probeReq.slice(0, 160)}`
    )

    // ———— S6 场景⑨（S1 完备化验收）：20K 窗新公式 ≈60% 触发 ————
    // 放在最后：s3 的摘要请求会进 summaryRequests，若插在 s1 两段压缩之间
    // 会挪动断言 8 读的 [1] 下标。重启后新建会话，7×1800 tok 处触发
    const s3 = await newSession({ cwd: ws })
    let trig20k = 0
    for (let k = 1; k <= 10; k++) {
      await engine.send('agent.submit', {
        sessionId: s3,
        text: `M20K_${k} ` + 'y'.repeat(TURN_CHARS_20K),
        model: 'mock20k'
      })
      await engine.waitEvent('run.completed', (p) => p.sessionId === s3)
      const hit = engine.events.find(
        (e) => e.method === 'compaction.started' && e.params.sessionId === s3 && e.params.reason === 'threshold'
      )
      if (hit) {
        hit.__consumed = true
        trig20k = k
        break
      }
    }
    if (trig20k === 0) {
      check('9. 20K 窗触发（reason=threshold，占比 55–75%）', false, '10 轮未触发')
    } else {
      const done = await engine.waitEvent('compaction.completed', (p) => p.sessionId === s3)
      const ratio = (done.params.tokensBefore ?? 0) / 20_000
      check(
        '9. 20K 窗触发（reason=threshold，占比 55–75% —— 旧 90% 公式需 ≥18000）',
        done.params.reason === 'threshold' && ratio > 0.55 && ratio < 0.75,
        `tokensBefore=${done.params.tokensBefore} ratio=${(ratio * 100).toFixed(1)}% trig=${trig20k}`
      )
    }

    // ———— S7 场景②(S2 验收):工具轮间 L2 触发且 run 不中断 ————
    // 铺 9 个中号回合(5000c ≈ 1429 tok):期末 ≈ 14200,稳在阈值 15808 下;
    // read probe2.txt 的结果(8000c ≈ 2290 tok,低于 8192 裁剪线 → L1 无动作)
    // 落账后过线 —— 轮间检查点只能走 L2 摘要,这正是场景②要验证的路径
    const s4 = await newSession({ cwd: ws })
    for (let k = 1; k <= 9; k++) {
      await engine.send('agent.submit', { sessionId: s4, text: `S4TURN_${k} ` + 'z'.repeat(5_000), model: 'mock' })
      await engine.waitEvent('run.completed', (p) => p.sessionId === s4)
    }
    const earlyCompact = engine.events.find((e) => e.method === 'compaction.started' && e.params.sessionId === s4)
    if (earlyCompact) earlyCompact.__consumed = true
    await engine.send('agent.submit', { sessionId: s4, text: 'DO:TOOL read probe2.txt', model: 'mock' })
    const toolOk = await engine.waitEvent('tool.completed', (p) => p.sessionId === s4 && !p.isError)
    const compactStart = await engine.waitEvent('compaction.started', (p) => p.sessionId === s4 && p.reason === 'threshold')
    await engine.waitEvent('run.completed', (p) => p.sessionId === s4)
    check(
      '10. 轮间 L2 触发(run 内、tool.completed 之后才 started;warmup 期零压缩)',
      !earlyCompact && engine.events.indexOf(compactStart) > engine.events.indexOf(toolOk),
      `early=${Boolean(earlyCompact)} tool@${engine.events.indexOf(toolOk)} compact@${engine.events.indexOf(compactStart)}`
    )
    // 压缩后的下一请求(run 内第二个):loop 工作副本已换轨 —— 摘要投影在、
    // 被摘要的回合 1 原文消失、工具结果与近期回合在保留区
    const afterStr = JSON.stringify(requestBodies.at(-1) ?? {})
    check(
      '10b. run 续跑且请求体换轨(checkpoint 前导语/首回合消失/工具结果与近期回合保留)',
      afterStr.includes('automatically generated checkpoint') &&
        !afterStr.includes('S4TURN_1 ') &&
        afterStr.includes('S4TURN_9 ') &&
        afterStr.includes('PROBE2-RESULT-MARK'),
      afterStr.slice(0, 160)
    )

    // ———— S8 场景⑤(R6② 核实):length 停因的 toolCall 被 fail,自愈重发 ————
    const s5 = await newSession({ cwd: ws })
    await engine.send('agent.submit', { sessionId: s5, text: 'DO:LENTOOL read probe.txt', model: 'mock' })
    const failEv = await engine.waitEvent('tool.completed', (p) => p.sessionId === s5 && p.isError === true)
    const redoEv = await engine.waitEvent('tool.completed', (p) => p.sessionId === s5 && !p.isError)
    await engine.waitEvent('run.completed', (p) => p.sessionId === s5)
    const sawFailMsg = requestBodies.some((b) => JSON.stringify(b).includes('Re-issue the tool call'))
    check(
      '11. length 停因 toolCall 全 fail(报文含 truncated)且 fail 结果回模型',
      (failEv.params.summary ?? '').includes('truncated') &&
        engine.events.indexOf(redoEv) > engine.events.indexOf(failEv) &&
        sawFailMsg,
      `summary=${(failEv.params.summary ?? '').slice(0, 80)} sawFail=${sawFailMsg}`
    )
    check(
      '11b. 自愈重发执行成功(重发调用拿到真实结果,run 正常收尾)',
      (redoEv.params.summary ?? '').includes('PROBE-HEAD-MARK'),
      (redoEv.params.summary ?? '').slice(0, 80)
    )

    // ———— S9 场景③(S3 验收):L1 单独够时零摘要请求 ————
    // 4 中号回合 + 两次 read probe.txt:第二次结果落账后过线 → 轮间检查点 →
    // L1 裁两条大结果 → 重计量回阈值下 → L2 不发
    const s6 = await newSession({ cwd: ws })
    for (let k = 1; k <= 4; k++) {
      await engine.send('agent.submit', { sessionId: s6, text: `S6TURN_${k} ` + 'z'.repeat(5_000), model: 'mock' })
      await engine.waitEvent('run.completed', (p) => p.sessionId === s6)
    }
    const summariesBefore = summaryRequests.length
    await engine.send('agent.submit', { sessionId: s6, text: 'DO:TOOL read probe.txt', model: 'mock' })
    await engine.waitEvent('run.completed', (p) => p.sessionId === s6)
    await engine.send('agent.submit', { sessionId: s6, text: 'DO:TOOL read probe.txt again', model: 'mock' })
    const pruneEv = await engine.waitEvent('compaction.pruned', (p) => p.sessionId === s6)
    await engine.waitEvent('run.completed', (p) => p.sessionId === s6)
    const s6Started = engine.events.find((e) => e.method === 'compaction.started' && e.params.sessionId === s6)
    if (s6Started) s6Started.__consumed = true
    const entries = pruneEv.params.entries ?? []
    check(
      '12. L1 单独够(两条大结果被裁、数值对账;零 compaction.started、零摘要请求)',
      entries.length === 2 &&
        entries.every((en) => en.originalChars > 17_000 && en.prunedChars > 4_000 && en.prunedChars < 6_500) &&
        !s6Started &&
        summaryRequests.length === summariesBefore,
      `entries=${JSON.stringify(entries)} started=${Boolean(s6Started)} summaries=${summaryRequests.length - summariesBefore}`
    )
    // 裁剪后的下一请求:头尾标记在、middle 标记消失、marker 在(审计痕迹进转录)
    const prunedReq = JSON.stringify(requestBodies.at(-1) ?? {})
    check(
      '12b. 裁剪保形(HEAD/TAIL 进保留区、MID 消失、PRUNE_MARKER 在请求体)',
      prunedReq.includes('PROBE-HEAD-MARK') &&
        prunedReq.includes('PROBE-TAIL-MARK') &&
        !prunedReq.includes('PROBE-MID-MARK') &&
        prunedReq.includes('tool result middle pruned'),
      prunedReq.slice(0, 160)
    )

    // ———— S10 场景④(S3 验收):prune 落盘,重启复原 ————
    // 落盘校验用请求体而非投影:未裁的结果头部 200 字符与裁后无异(HEAD 都在),
    // 只有重发请求看得到 marker 与 MID 的缺席 —— 转录真源是什么,下一请求就带什么
    engine.kill()
    await sleep(300)
    engine = startEngine(home)
    await initEngine(engine, { client: 'compaction-smoke', port: PORT, providers: MOCK_PROVIDERS })
    await engine.send('agent.submit', { sessionId: s6, text: 'post-restart probe', model: 'mock' })
    await engine.waitEvent('run.completed', (p) => p.sessionId === s6)
    const revivedReq = JSON.stringify(requestBodies.at(-1) ?? {})
    check(
      '13. 重启复原(裁剪形态落盘:MARKER/HEAD 在、MID 不在、S6TURN_1 原文在)',
      revivedReq.includes('tool result middle pruned') &&
        revivedReq.includes('PROBE-HEAD-MARK') &&
        !revivedReq.includes('PROBE-MID-MARK') &&
        revivedReq.includes('S6TURN_1 '),
      revivedReq.slice(0, 160)
    )

    // ———— S11 场景⑥(S5 验收):溢出恢复一次重试成功 + 单次闸 ————
    const s7 = await newSession({ cwd: ws })
    await engine.send('agent.submit', { sessionId: s7, text: 'OVERFLOW_ONCE please help', model: 'mock' })
    await engine.waitEvent('run.completed', (p) => p.sessionId === s7)
    const reqOnce = requestBodies.filter((b) => JSON.stringify(b).includes('OVERFLOW_ONCE')).length
    const failed7 = engine.events.find((e) => e.method === 'run.failed' && e.params.sessionId === s7)
    check(
      '15. 溢出恢复一次成功(原请求+continue 重试各一次;全程单 run 无 run.failed)',
      reqOnce === 2 && failed7 === undefined,
      `req=${reqOnce} failed=${Boolean(failed7)}`
    )
    const s8 = await newSession({ cwd: ws })
    await engine.send('agent.submit', { sessionId: s8, text: 'OVERFLOW_TWICE please help', model: 'mock' })
    const failEv8 = await engine.waitEvent('run.failed', (p) => p.sessionId === s8)
    const reqTwice = requestBodies.filter((b) => JSON.stringify(b).includes('OVERFLOW_TWICE')).length
    // run.failed 的 message 是错误文案（字符串）；SmokeEventParams.message 按
    // run.completed 的段化消息声明，此处 typeof 收窄
    const failMsg = typeof failEv8.params.message === 'string' ? failEv8.params.message : ''
    check(
      '16. 单次闸(重试再溢出 → run.failed 显式暴露;请求恰两次不循环)',
      reqTwice === 2 && failMsg.includes('maximum context length'),
      `req=${reqTwice} msg=${failMsg.slice(0, 80)}`
    )

    // ———— S12 场景⑦(S6 验收):auto-continue 续写请求 + 相邻段合并 ————
    const s9 = await newSession({ cwd: ws })
    await engine.send('agent.submit', { sessionId: s9, text: 'LENCONT write something long', model: 'mock' })
    const done9 = await engine.waitEvent('run.completed', (p) => p.sessionId === s9)
    const contReq = requestBodies.filter((b) => JSON.stringify(b).includes('[cogent:continue]')).length
    const segs9 = done9.params.messages ?? []
    check(
      '17. auto-continue(续写指令进请求;终态单 run:stopReason=stop、段合并为一条)',
      contReq === 1 &&
        done9.params.stopReason === 'stop' &&
        segs9.length === 1 &&
        (done9.params.message?.content ?? '').includes('CONT-PART1-MARK') &&
        (done9.params.message?.content ?? '').includes('CONT-PART2-MARK'),
      `contReq=${contReq} stopReason=${done9.params.stopReason} segs=${segs9.length}`
    )
    // 历史投影同形态:指令消息不成泡、截断段与续写段并回单条 assistant
    const hist9 = await engine.send('session.messages', { sessionId: s9 })
    const hmsgs = hist9.result?.messages ?? []
    const hAsst = hmsgs.filter((m) => m.role === 'assistant')
    check(
      '17b. 历史投影合并([cogent:continue] 不成泡;单条 assistant 含两段)',
      hmsgs.every((m) => !m.content.includes('[cogent:continue]')) &&
        hAsst.length === 1 &&
        (hAsst[0]?.content ?? '').includes('CONT-PART1-MARK') &&
        (hAsst[0]?.content ?? '').includes('CONT-PART2-MARK'),
      `assistants=${hAsst.length} roles=${hmsgs.map((m) => m.role).join(',')}`
    )

    // ———— S13 场景(S7 验收):compat + thinkingBudgets 透传,预算字段进请求体 ————
    // 带 compat 的第二个自定义 provider:预算按档位取值(medium=8192)×
    // max_tokens 夹制(128K 窗不触)→ 请求体应带 thinking_token_budget=8192
    await engine.send('providers.custom.sync', {
      providers: [
        ...MOCK_PROVIDERS,
        {
          id: 'custom/budget',
          name: 'BudgetMock',
          baseUrl: `http://127.0.0.1:${PORT}/v1`,
          models: ['mock-budget'],
          modelDefs: [
            {
              id: 'mock-budget',
              contextWindow: 128_000,
              reasoning: true,
              thinkingLevels: ['medium'],
              thinkingBudgets: { minimal: 1024, low: 2048, medium: 8192, high: 16384 }
            }
          ],
          compat: { thinkingTokenBudgetField: 'thinking_token_budget' }
        }
      ],
      overrides: []
    })
    // 新 provider 的 key 单独 set(凭据按 provider 隔离;缺了会 run.failed
    // "Provider is not configured: custom/budget")
    await engine.send('credentials.set', { providerId: 'custom/budget', apiKey: 'sk-budget' })
    const s10 = await newSession({ cwd: ws })
    await engine.send('agent.submit', {
      sessionId: s10,
      text: 'S13 budget probe',
      model: 'mock-budget',
      provider: 'custom/budget',
      thinkingLevel: 'medium'
    })
    await engine.waitEvent('run.completed', (p) => p.sessionId === s10)
    const budgetReq = requestBodies.find((b) => b.model === 'mock-budget')
    check(
      '18. 预算字段进请求体(thinking_token_budget=8192,compat 字段名 × 档位预算)',
      budgetReq !== undefined && (budgetReq as { thinking_token_budget?: number }).thinking_token_budget === 8192,
      `body=${JSON.stringify(budgetReq ?? {}).slice(0, 200)}`
    )
    // 卫生收尾:恢复 sync 全量语义(撤 budget provider —— 替换式同步,不传即卸)
    await engine.send('providers.custom.sync', { providers: MOCK_PROVIDERS, overrides: [] })

    // ———— S14 场景(S2 验收 bug 回归):轮间压缩后同 run 内请求的配对完整性 ————
    // 复现结构 = 验收翻车现场:垫到阈值边缘 → 大工具轮落账过线 → 轮间钩子在
    // run 中途压缩 → 压缩后的下一请求必须 toolCall/toolResult 严格配对。换引用
    // 的旧实现会把 loop 当轮收尾消息双写进转录(配对重复 → 400);原位写回
    // 后 transcript 与请求体都应干净
    const s11 = await newSession({ cwd: ws })
    // 垫底 10 回合 + DO:TOOL 轮 → 过线发生在 run 的中途(轮间钩子),正是
    // 验收翻车的并发窗口
    for (let k = 1; k <= 10; k++) {
      await engine.send('agent.submit', { sessionId: s11, text: `S11TURN_${k} ` + 'z'.repeat(5_000), model: 'mock' })
      await engine.waitEvent('run.completed', (p) => p.sessionId === s11)
    }
    await engine.send('agent.submit', { sessionId: s11, text: 'S11TURN_11 ' + 'z'.repeat(3_000) + ' DO:TOOL read probe.txt', model: 'mock' })
    await engine.waitEvent('run.completed', (p) => p.sessionId === s11)
    const didCompact = engine.events.some((e) => e.method === 'compaction.started' && e.params.sessionId === s11)
    // 取压缩后的第一个回合请求:扫 messages 数组,断言 tool 的 tool_call_id 都能
    // 在紧邻前一条 assistant 的 tool_calls 里找到,且 assistant 无重复连续条目
    // 压缩后第一个请求 = 锚 user(S11TURN_11)之后、含压缩条投影的下一个:
    // findIndex 从锚的位置向后找(前面场景也有压缩条投影,不能全局找)
    const anchorIdx = requestBodies.findIndex((b) => JSON.stringify(b).includes('S11TURN_11'))
    const postIdx = didCompact
      ? requestBodies.findIndex((b, i) => i > anchorIdx && JSON.stringify(b).includes('automatically generated checkpoint'))
      : -1
    let pairingOk = !didCompact // 没触发压缩则本轮无事可断(不应发生,触发不了算失败)
    let pairingDetail = `didCompact=${didCompact} postIdx=${postIdx}`
    if (didCompact && postIdx >= 0) {
      const postMsgs = (requestBodies[postIdx]?.messages ?? []) as Array<{
        role: string
        tool_call_id?: string
        tool_calls?: Array<{ id: string }>
      }>
      pairingOk = true
      for (let i = 1; i < postMsgs.length; i++) {
        const m = postMsgs[i]
        if (m.role !== 'tool') continue
        const prev = postMsgs[i - 1]
        const prevIds = (prev.tool_calls ?? []).map((t) => t.id)
        if (!prevIds.includes(m.tool_call_id ?? '')) {
          pairingOk = false
          pairingDetail = `idx=${i} tool ${m.tool_call_id} 前条 assistant 无此 call(前条 tc=${prevIds.join(',')})`
          break
        }
      }
      // 相邻重复 assistant(双写残迹)
      for (let i = 1; i < postMsgs.length; i++) {
        if (postMsgs[i].role === 'assistant' && postMsgs[i - 1].role === 'assistant') {
          pairingOk = false
          pairingDetail = `idx=${i} 相邻双 assistant`
          break
        }
      }
    }
    check('19. 轮间压缩后请求配对完整(tool_call_id 全有前条 tool_calls 呼应;无双 assistant)', pairingOk, pairingDetail)
    // 19b:压缩 run 收尾后**落盘转录**的配对完整性 —— 双写竞态的第二现场。
    // 读引擎 COGENT_HOME 的会话文档,按转录顺序断言每条 toolResult 的 callId
    // 与其前最近 assistant 配对 + 无相邻重复 assistant
    const sessDoc = JSON.parse(readFileSync(join(home, 'sessions', `${s11}.json`), 'utf-8')) as {
      transcript?: Array<{ role: string; toolCallId?: string; content?: Array<{ type: string; id?: string }> }>
    }
    const tr = sessDoc.transcript ?? []
    let trOk = true
    let trDetail = `len=${tr.length}`
    for (let i = 0; i < tr.length; i++) {
      const m = tr[i]
      if (m.role !== 'toolResult') continue
      let j = i - 1
      while (j >= 0 && tr[j].role !== 'assistant') j--
      const calls = j >= 0 ? (tr[j].content ?? []).filter((b) => b.type === 'toolCall').map((b) => b.id ?? '') : []
      if (!calls.includes(m.toolCallId ?? '')) {
        trOk = false
        trDetail = `idx=${i} toolResult ${m.toolCallId} 前最近 assistant 无此 call`
        break
      }
    }
    for (let i = 1; trOk && i < tr.length; i++) {
      if (tr[i].role === 'assistant' && tr[i - 1].role === 'assistant') {
        trOk = false
        trDetail = `idx=${i} 相邻双 assistant`
        break
      }
    }
    check('19b. 落盘转录配对完整(原位写回:无双写残迹/无孤儿 toolResult)', trOk, trDetail)

    // ———— S15 场景(修 B 验收):空正文截断不续写,直接截断终态 ————
    const s12b = await newSession({ cwd: ws })
    await engine.send('agent.submit', { sessionId: s12b, text: 'LENEMPTY now', model: 'mock' })
    const doneB = await engine.waitEvent('run.completed', (p) => p.sessionId === s12b)
    const contReqB = requestBodies.filter(
      (b) => JSON.stringify(b).includes('[cogent:continue]') && JSON.stringify(b).includes('LENEMPTY')
    ).length
    check(
      '20. 空正文 length 不续写(终态 stopReason=length、零续写请求)',
      doneB.params.stopReason === 'length' && contReqB === 0,
      `stopReason=${doneB.params.stopReason} contReq=${contReqB}`
    )
    // 手动续写同样拒绝(错误文案指路压缩)
    const contErr = await engine.send('session.continue', { sessionId: s12b })
    check(
      '21. 手动续写对空正文截断拒绝(错误文案指路压缩腾地)',
      contErr.error !== undefined && contErr.error.message.includes('压缩'),
      JSON.stringify(contErr.error ?? contErr.result)
    )

    // ———— S16 场景(修 A 验收):小窗深度占用的摘要降级 ————
    // mock20k 会话垫 8 回合 + probe2 结果轮 ≈ 15900 深度占用 → 过阈值 → 自动
    // 压缩的摘要请求重放 available ≈ 500 < 2048 → 预算守卫降级(被摘要区直传,
    // 无 system 领头);摘要照常成功
    const s13b = await newSession({ cwd: ws })
    for (let k = 1; k <= 8; k++) {
      await engine.send('agent.submit', { sessionId: s13b, text: `S16TURN_${k} ` + 'z'.repeat(5_000), model: 'mock20k' })
      await engine.waitEvent('run.completed', (p) => p.sessionId === s13b)
    }
    await engine.send('agent.submit', { sessionId: s13b, text: 'DO:TOOL read probe2.txt', model: 'mock20k' })
    await engine.waitEvent('run.completed', (p) => p.sessionId === s13b)
    const summariesBeforeB = summaryRequests.length
    const autoDone = await engine
      .waitEvent('compaction.completed', (p) => p.sessionId === s13b && p.error === undefined, 15_000)
      .then(
        () => true,
        () => false
      )
    const degReq = summaryRequests.at(summariesBeforeB)
    const leadingRole = degReq?.__smokeLeadingRole ?? 'none'
    check(
      '22. 摘要预算守卫降级(小窗深占用时自动压缩的摘要请求非 system 领头=被摘要区直传;摘要成功)',
      autoDone && leadingRole !== 'system',
      `autoDone=${autoDone} leading=${leadingRole} summaries=${summaryRequests.length - summariesBeforeB}`
    )
  })
})
