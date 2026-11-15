/**
 * 交互座集成测试（阶段 4c-1/4c-2，docs/计划/交互座实现.md §5）—— 断言对象 =
 * customTools 注入链 + todo_write 全链（todos.updated 事件 / 结果回灌 / 新 run
 * 段注入 / session.messages 种子）+ ask_user 全链（question.asked 挂起 /
 * question.respond 作答回灌 / abort 取消收口不永悬 / 重复回答 InvalidParams）。
 * mock 单桩：LLM（OpenAI SSE，18970）。临时 COGENT_HOME 隔离。
 */
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, it } from 'vitest'
import type { AskQuestionParam, SessionMessagesResult, TodoItem } from '../../src/protocol'
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
  text('继续'), // 三轮（新 run —— before_agent_start 段活算在此轮请求前）
  // S2 一轮：ask_user 挂起（宿主作答后回灌）；二轮收尾
  {
    type: 'toolCall',
    callId: 'a1',
    tool: 'ask_user',
    args: {
      questions: [
        {
          question: '用哪个数据库？',
          header: '存储',
          options: [
            { label: 'SQLite', description: '单文件零运维' },
            { label: 'PostgreSQL', description: '生产级' }
          ]
        }
      ]
    }
  },
  text('收到答案'), // S2 二轮
  // S3 一轮：ask_user 再挂起（测 abort 收口）；此后无动作（run 被 abort）
  {
    type: 'toolCall',
    callId: 'a2',
    tool: 'ask_user',
    args: {
      questions: [
        {
          question: '再问一个？',
          options: [
            { label: '好', description: '' },
            { label: '不', description: '' }
          ]
        }
      ]
    }
  },
  // S4：enter_plan 切档 → 同 run submit_plan 挂起 → 批准后收尾
  {
    type: 'toolCall',
    callId: 'p1',
    tool: 'enter_plan',
    args: {}
  },
  {
    type: 'toolCall',
    callId: 'p2',
    tool: 'submit_plan',
    args: { plan: '## 目标\n实现存储层。\n\n## 步骤\n1. 建 schema\n2. 写迁移' }
  },
  text('S4 收尾'), // S4 批准后的收尾轮（工具结果已含批准文案）
  // S5：ask 档直接调 submit_plan（非 plan 档拒绝路径）
  {
    type: 'toolCall',
    callId: 'p3',
    tool: 'submit_plan',
    args: { plan: '不该出现的方案' }
  },
  text('S5 收尾')
]
let actionIndex = 0
/** LLM 请求体留存（断言段注入与工具结果回灌） */
const requestBodies: Array<Record<string, unknown>> = []

/** 每次请求分到的动作类型（调试错位用） */
const actionLog: string[] = []
const server: Server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    requestBodies.push(JSON.parse(body) as Record<string, unknown>)
    const action = ACTIONS[actionIndex++] ?? text('fallback')
    actionLog.push(action.type === 'toolCall' ? `${action.type}:${action.tool}` : action.type)
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

    // ———— S2 ask_user：挂起 → question.asked → 宿主作答 → 答案回灌 ————
    await engine.send('agent.submit', { sessionId, text: '动手前先问我', model: 'mock' })
    const asked = await engine.waitEvent('question.asked', (p) => p.sessionId === sessionId, 30_000)
    const askedQuestions = asked.params.questions as AskQuestionParam[]
    check(
      '6. question.asked 携带问题全文（选项/描述）',
      askedQuestions[0]?.question === '用哪个数据库？' && askedQuestions[0]?.options[0]?.label === 'SQLite',
      JSON.stringify(asked.params)
    )
    const respond = await engine.send('question.respond', {
      requestId: asked.params.requestId,
      answers: ['PostgreSQL']
    })
    check('7. question.respond 配对成功', respond.result?.ok === true, JSON.stringify(respond.error ?? respond.result))
    await engine.waitEvent('run.completed', (p) => p.sessionId === sessionId, 30_000)
    // S2 二轮请求（第 5 个请求体：S1 两轮 + run2 一轮 + S2 首轮之后）携带答案
    // 文本（工具结果回灌闭环）。JSON 串里的引号是 \"，断言片段先按同规则转义
    //（skills 测试同款手法）
    const r3 = requestBodies[4] as { messages?: Array<{ role: string }> } | undefined
    const answerFragment = JSON.stringify('"用哪个数据库？"="PostgreSQL"').slice(1, -1)
    check(
      '8. 答案回灌下一轮（"用哪个数据库？"="PostgreSQL"）',
      JSON.stringify(r3?.messages ?? []).includes(answerFragment),
      JSON.stringify((r3?.messages ?? []).map((m) => ({ role: m.role, head: JSON.stringify(m).slice(0, 260) })))
    )

    // ———— S3 abort 收口：挂起中点停止 → cancelled 结果 → run.failed（不永悬）————
    await engine.send('agent.submit', { sessionId, text: '再问一次', model: 'mock' })
    // 超时诊断附动作序列（mock 分发错位时一眼可辨）
    await engine.waitEvent('question.asked', (p) => p.sessionId === sessionId, 30_000).catch((e: Error) => {
      throw new Error(`${e.message}；动作序列=${actionLog.join(',')}`)
    })
    await engine.send('agent.abort', { sessionId })
    const failed = await engine.waitEvent('run.failed', (p) => p.sessionId === sessionId, 30_000).catch(() => undefined)
    check('9. abort 后 run 落终态（挂起提问已取消，不永悬）', failed !== undefined, 'run.failed 未到')

    // 重复回答已收口的请求 → InvalidParams（防静默成功）
    const stale = await engine.send('question.respond', { requestId: asked.params.requestId, answers: ['SQLite'] })
    check('10. 已收口的提问再答 → InvalidParams', stale.error?.code === -32602, JSON.stringify(stale.error))

    // ———— S4 plan 闭环：enter_plan 切档 → submit_plan 挂起 → 批准切档 + 段注入 ————
    await engine.send('agent.submit', { sessionId, text: '先规划再干', model: 'mock' })
    const planRequested = await engine.waitEvent('plan.requested', (p) => p.sessionId === sessionId, 30_000)
    check(
      '11. enter_plan 幂等切档 + plan.requested 携带方案全文',
      (planRequested.params.plan as string).includes('实现存储层'),
      JSON.stringify(planRequested.params.plan).slice(0, 200)
    )
    const planVerdict = await engine.send('plan.respond', {
      requestId: planRequested.params.requestId,
      approved: true,
      switchMode: 'auto'
    })
    check('12. 批准 + 切档 auto 成功', planVerdict.result?.ok === true, JSON.stringify(planVerdict.error ?? planVerdict.result))
    await engine.waitEvent('run.completed', (p) => p.sessionId === sessionId, 30_000)
    // 切档断言：工具结果含批准文案；批准后新 run 的系统提示含 cogent_plan 段 + auto 档通告
    const s4Bodies = requestBodies.slice(6, 9)
    const s4All = JSON.stringify(s4Bodies)
    const approvedFragment = JSON.stringify('用户已批准你的计划').slice(1, -1)
    check(
      '13. 批准结果回灌（含已批准文案）',
      s4All.includes(approvedFragment),
      s4All.slice(0, 200)
    )
    await engine.send('agent.submit', { sessionId, text: '按计划开工', model: 'mock' })
    await engine.waitEvent('run.completed', (p) => p.sessionId === sessionId, 30_000).catch(() => undefined)
    const afterPlan = requestBodies.at(-1) as { messages?: Array<{ role: string }> } | undefined
    const afterSystem = JSON.stringify((afterPlan?.messages ?? []).filter((m) => m.role === 'system'))
    check(
      '14. 批准后新 run：cogent_plan 段 + auto 档通告',
      afterSystem.includes('已批准的计划') && afterSystem.includes('完全访问'),
      afterSystem.slice(0, 300)
    )
    // 会话摘要已切 auto（plan.respond 返回值也带，这里验事件侧一致性）
    const listed = await engine.send('session.list', {})
    const summary = (listed.result as Array<{ id: string; permissionMode?: string }> | undefined)?.find(
      (s) => s.id === sessionId
    )
    check('15. 会话摘要切档 auto', summary?.permissionMode === 'auto', JSON.stringify(summary))

    // ———— S5 非 plan 档拒绝：ask 档直接调 submit_plan → isError 指引 ————
    // 先切回 ask（S4 已切 auto），再提交
    await engine.send('session.setPermission', { sessionId, mode: 'ask' })
    await engine.send('agent.submit', { sessionId, text: '直接提方案', model: 'mock' })
    const rejected = await engine.waitEvent(
      'tool.completed',
      (p) => p.sessionId === sessionId && p.callId === 'p3',
      30_000
    )
    check(
      '16. 非 plan 档调 submit_plan → isError 指引文案',
      rejected.params.isError === true && (rejected.params.summary ?? '').includes('不在 plan 模式'),
      JSON.stringify(rejected.params)
    )
    await engine.waitEvent('run.completed', (p) => p.sessionId === sessionId, 30_000).catch(() => undefined)
  }, 180_000)
})
