/**
 * 交互座集成测试（阶段 4c-1，docs/计划/交互座实现.md §5）—— 断言对象 =
 * customTools 注入链 + todo_write 全链：模型调 todo_write → 工具执行
 *（桥更新会话状态 + todos.updated 北向事件）→ 工具结果回灌转录 → 下一轮
 * 请求系统提示含 cogent_todos 段（before_agent_start 回合边界活算）→
 * session.messages 带 todos 种子（StoredSession 持久化路径顺带覆盖）。
 * mock 单桩：LLM（OpenAI SSE，18970）。临时 COGENT_HOME 隔离。
 */
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, it } from 'vitest'
import type { SessionMessagesResult, TodoItem } from '../../src/protocol'
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

const PORT = 18_970
const home = makeTempDir('cogent-interact-home-')
const ws = makeTempDir('cogent-interact-ws-')

// ———— mock LLM：动作队列（请求序 = 动作序，串行驱动确定） ————

type Action =
  | { type: 'text'; text: string }
  | { type: 'toolCall'; callId: string; tool: string; args: Record<string, unknown> }
const text = (t: string): Action => ({ type: 'text', text: t })
const ACTIONS: Action[] = [
  // 一轮：todo_write 全量落两件（含 in_progress/pending 两态）
  {
    type: 'toolCall',
    callId: 't1',
    tool: 'todo_write',
    args: {
      todos: [
        { content: '实现存储层', status: 'in_progress', priority: 'high' },
        { content: '写测试', status: 'pending', priority: 'medium' }
      ]
    }
  },
  text('清单已记'), // 二轮（同一 run 内）
  text('继续') // 三轮（新 run —— before_agent_start 段活算在此轮请求前）
]
let actionIndex = 0
/** LLM 请求体留存（断言段注入与工具结果回灌） */
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

describe('交互座集成（customTools 注入 + todo_write 全链）', () => {
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r))
    await initEngine(engine, {
      client: 'interact-smoke',
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
    const sessionId = (await engine.send('session.create', { cwd: ws })).result?.id
    if (sessionId === undefined) throw new Error('session.create 失败')
    await engine.send('agent.submit', { sessionId, text: '开始干活', model: 'mock' })

    // 1. 工具执行成功（customTools 白名单放行 + read 档免审批直执行）
    const toolEnd = await engine.waitEvent('tool.completed', (p) => p.sessionId === sessionId && p.callId === 't1', 30_000)
    check(
      '1. todo_write 执行成功',
      toolEnd.params.isError === false && (toolEnd.params.summary ?? '').includes('任务清单已更新'),
      JSON.stringify(toolEnd.params)
    )

    // 2. 北向事件：全量清单快照（TodoStrip 数据源）
    const todosEvent = await engine.waitEvent('todos.updated', (p) => p.sessionId === sessionId, 30_000)
    const updated = todosEvent.params.todos as TodoItem[]
    check(
      '2. todos.updated 携带全量清单',
      updated.length === 2 && updated[0]?.content === '实现存储层' && updated[0]?.status === 'in_progress',
      JSON.stringify(todosEvent.params)
    )

    // 3. 同 run 二轮请求：工具结果回灌（段不在此轮 —— before_agent_start 是
    //    run 级钩子（_prepareRun），run 中途的 todo_write 要到下一个 run 才进段；
    //    本轮模型上下文里已有全量工具结果，不需要段）
    await engine.waitEvent('run.completed', (p) => p.sessionId === sessionId, 30_000)
    const r1 = requestBodies[1] as { messages?: Array<{ role: string }> } | undefined
    check('3. 工具结果回灌二轮（循环闭合）', JSON.stringify(r1?.messages ?? []).includes('任务清单已更新'))

    // 4. 新 run：cogent_todos 段进系统提示（before_agent_start 活算 + sections diff）
    await engine.send('agent.submit', { sessionId, text: '继续干活', model: 'mock' })
    await engine.waitEvent(
      'run.completed',
      (p) => p.sessionId === sessionId,
      30_000
    )
    const r2 = requestBodies[2] as { messages?: Array<{ role: string }> } | undefined
    const systemText = JSON.stringify((r2?.messages ?? []).filter((m) => m.role === 'system'))
    check(
      '4. 新 run 系统提示含 cogent_todos 段（权威状态跨 run 持久）',
      systemText.includes('任务清单（当前权威状态）') && systemText.includes('实现存储层'),
      systemText.slice(0, 300)
    )

    // 5. session.messages 带 todos 种子（StoredSession 持久化 → TodoStrip 打开会话）
    const messages = await engine.send<SessionMessagesResult>('session.messages', { sessionId })
    check(
      '5. session.messages 带 todos 种子',
      messages.result?.todos?.length === 2 && messages.result.todos[0]?.content === '实现存储层',
      JSON.stringify(messages.result?.todos)
    )
  }, 180_000)
})
