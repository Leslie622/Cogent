/**
 * thinkingLevel 'off' 放行回归钉（约定.md §1.3-4：翻过车的 bug 随修随钉）。
 *
 * 事故：架构审查批给 agent.submit 加入口校验时，白名单照抄了「off 不属于
 * 支持的等级」的口径，漏收 'off' —— 而 UI 滑杆默认档就是 off（关闭思考），
 * 默认态发消息直接被 -32602 拒掉。'off' 是 pi 原生档：agent 层转
 * reasoning: undefined，方言层再按端点翻译（DeepSeek/anthropic 显式
 * thinking disabled、openai 通用省略字段）。
 *
 * 钉三个行为：
 *  T1 非推理模型 off → accepted + run.completed（事故路径，此前在此被拒）
 *  T2 推理模型 off → 请求体不带任何思考参数（off 语义 = 不发，openai 通用方言）
 *  T3 非法档位仍拒（-32602，校验没有随放行一起放松），引擎后续可用
 */
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { check, chunk, type EngineHandle, initEngine, makeTempDir, removeDir, sse, startEngine } from './harness'

const PORT = 18_943
const home = makeTempDir('cogent-think-off-home-')
const ws = makeTempDir('cogent-think-off-ws-')

// ———— mock 端点：全部回纯文本（本场景无工具轮），记录请求体供 T2 断言 ————

const requestBodies: Array<Record<string, unknown>> = []
let replies = 0

const server: Server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    requestBodies.push(JSON.parse(body) as Record<string, unknown>)
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    res.write(sse(chunk({ content: `reply-${replies++}` })))
    res.write(sse(chunk({}, 'stop', { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })))
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

const engine: EngineHandle = startEngine(home)

const newSession = async (): Promise<string> => {
  const r = await engine.send('session.create', { cwd: ws })
  if (r.result?.id === undefined) throw new Error(`session.create 失败: ${JSON.stringify(r.error ?? r.result)}`)
  return r.result.id
}

const PROVIDERS = [
  {
    id: 'custom/mock',
    name: 'Mock',
    baseUrl: `http://127.0.0.1:${PORT}/v1`,
    models: ['mock'],
    // 推理模型：声明选档集（map 由引擎构建）——off 走 map 默认规则可用
    modelDefs: [{ id: 'mock-reasoner', reasoning: true, thinkingLevels: ['low', 'high'] }]
  }
]

describe('agent.submit thinkingLevel 值域（off 放行回归钉）', () => {
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r))
    await initEngine(engine, { client: 'thinking-off-smoke', port: PORT, providers: PROVIDERS })
  }, 60_000)

  afterAll(() => {
    engine.kill()
    server.close()
    for (const dir of [home, ws]) removeDir(dir)
  })

  it('T1 非推理模型 off 受理并完成（事故路径）', async () => {
    const s1 = await newSession()
    const r1 = await engine.send('agent.submit', { sessionId: s1, text: 'T1 off on plain model', model: 'mock', thinkingLevel: 'off' })
    check('1. 非推理模型 off → accepted', r1.result?.accepted === true, JSON.stringify(r1.error ?? {}))
    await engine.waitEvent('run.completed', (p) => p.sessionId === s1)
  })

  it('T2 推理模型 off：请求体不带思考参数', async () => {
    const s2 = await newSession()
    const r2 = await engine.send('agent.submit', {
      sessionId: s2,
      text: 'T2 off on reasoner',
      model: 'mock-reasoner',
      provider: 'custom/mock',
      thinkingLevel: 'off'
    })
    check('2. 推理模型 off → accepted', r2.result?.accepted === true, JSON.stringify(r2.error ?? {}))
    await engine.waitEvent('run.completed', (p) => p.sessionId === s2)
    const body = requestBodies.find((b) => b.model === 'mock-reasoner')
    check('3. off 请求体无 reasoning_effort', body !== undefined && body.reasoning_effort === undefined)
    check('4. off 请求体无 thinking', body !== undefined && body.thinking === undefined)
  })

  it('T3 非法档位仍拒，引擎未被拖坏', async () => {
    const s3 = await newSession()
    const r3 = await engine.send('agent.submit', { sessionId: s3, text: 'T3 bogus', model: 'mock', thinkingLevel: 'bogus' })
    check('5. 非法档 → InvalidParams', r3.error?.code === -32602, JSON.stringify(r3.error ?? {}))
    check('6. 拒绝文案含 off（值域对齐枚举）', (r3.error?.message ?? '').includes('off'))
    const r4 = await engine.send('agent.submit', { sessionId: s3, text: 'T3 recover', model: 'mock', thinkingLevel: 'off' })
    check('7. 拒后引擎仍可用', r4.result?.accepted === true, JSON.stringify(r4.error ?? {}))
    await engine.waitEvent('run.completed', (p) => p.sessionId === s3)
  })
})
