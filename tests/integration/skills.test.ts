/**
 * 技能座集成测试（阶段 4b-1，docs/计划/技能座实现.md §5）—— 断言对象 =
 * Host 侧接线：skills.save/list 协议方法（同名 project 胜 + 冲突诊断）、
 * skills 段注入系统提示（before_agent_start 活算）、read 工具渐进加载闭环、
 * **同会话**禁用下一轮请求清单消失（回合边界热刷新，sections diff 补丁）、
 * inherit 回落后 /skill: 活展开进用户消息。
 * 技能发现/校验本身是 pi loadSkillsFromDir 的（单测已钉 store 合并语义）。
 *
 * mock 单桩：LLM（OpenAI SSE，18960）。临时 COGENT_HOME 隔离，技能经协议
 * skills.save 写入（顺带覆盖协议路径本身）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import type { SkillListResult } from '../../src/protocol'
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

const PORT = 18_960
const home = makeTempDir('cogent-skills-home-')
const ws = makeTempDir('cogent-skills-ws-')
const projectSkillPath = join(ws, '.cogent', 'skills', 'commit-check', 'SKILL.md')

// ———— mock LLM：动作队列（请求序 = 动作序，串行驱动确定） ————

type Action =
  | { type: 'text'; text: string }
  | { type: 'toolCall'; callId: string; tool: string; args: Record<string, unknown> }
const text = (t: string): Action => ({ type: 'text', text: t })
const ACTIONS: Action[] = [
  // S2 一轮：read 渐进加载（读胜者 project 版 SKILL.md 正文）
  { type: 'toolCall', callId: 'r1', tool: 'read', args: { path: projectSkillPath } },
  text('S2 done'), // S2 二轮
  text('S3 done'), // S3（同会话热禁用后）
  text('S4 done') // S4（inherit 回落 + /skill: 展开后）
]
let actionIndex = 0
/** LLM 请求体留存（断言系统提示段/工具结果回灌/用户消息展开） */
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

const submitAndDone = async (sessionId: string, text: string): Promise<void> => {
  await engine.send('agent.submit', { sessionId, text, model: 'mock' })
  await engine.waitEvent('run.completed', (p) => p.sessionId === sessionId, 30_000)
}

describe('技能座集成（协议方法 + 段注入 + read 闭环 + 回合热刷新 + 活展开）', () => {
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r))
    await initEngine(engine, {
      client: 'skills-smoke',
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
    // ———— S1 协议方法往返：同名两级 + 冲突诊断 ————
    const saveUser = await engine.send('skills.save', {
      scope: 'user',
      name: 'commit-check',
      description: '用户版描述',
      body: '用户版正文'
    })
    check('1. skills.save user 级写入', saveUser.result?.ok === true, JSON.stringify(saveUser.error ?? saveUser.result))
    const saveProject = await engine.send('skills.save', {
      scope: 'project',
      cwd: ws,
      name: 'commit-check',
      description: '项目版描述',
      body: '提交前三步：lint、typecheck、test'
    })
    check('2. skills.save project 级写入', saveProject.result?.ok === true, JSON.stringify(saveProject.error ?? saveProject.result))
    const list = await engine.send<SkillListResult>('skills.list', { cwd: ws })
    const winner = list.result?.skills[0]
    check(
      '3. 合并视图：同名 project 胜 + 冲突诊断',
      list.result?.skills.length === 1 &&
        winner?.scope === 'project' &&
        winner.description === '项目版描述' &&
        winner.enabled === true &&
        list.result.errors.some((e) => e.includes('commit-check')),
      JSON.stringify(list.result)
    )
    const userList = await engine.send<SkillListResult>('skills.list', {})
    check(
      '4. 缺省视图：仅 user 目录（用户版）',
      userList.result?.skills.length === 1 && userList.result.skills[0].description === '用户版描述',
      JSON.stringify(userList.result)
    )
    // 非法载荷 → InvalidParams 错误帧（名字规则在 store 的 pi 同款校验）
    const bad = await engine.send('skills.save', { scope: 'user', name: 'BAD NAME', description: 'd', body: 'b' })
    check('5. 非法名字显式拒绝（-32602）', bad.error?.code === -32602, JSON.stringify(bad.error))

    // 生态兼容目录（.agents/skills，zcode 等工具装的）：手放后只读发现 + eco 标记
    // （引擎 eco 根 = homedir()/.agents，harness 已把 HOME 指进临时 home → 天然隔离）
    mkdirSync(join(home, '.agents', 'skills', 'eco-tool'), { recursive: true })
    writeFileSync(
      join(home, '.agents', 'skills', 'eco-tool', 'SKILL.md'),
      '---\nname: eco-tool\ndescription: 生态工具\n---\n\n生态正文\n'
    )
    const ecoList = await engine.send<SkillListResult>('skills.list', {})
    const ecoEntry = ecoList.result?.skills.find((s) => s.name === 'eco-tool')
    check(
      '5b. 生态目录发现：.agents/skills 技能进列表（eco 标记 + user 作用域 + 启用）',
      ecoEntry?.eco === true && ecoEntry.scope === 'user' && ecoEntry.enabled === true,
      JSON.stringify(ecoList.result)
    )

    // ———— S2 段注入 + read 渐进加载闭环 ————
    const s2 = (await engine.send('session.create', { cwd: ws })).result?.id
    if (s2 === undefined) throw new Error('session.create 失败')
    await submitAndDone(s2, 'S2 用技能干活')
    const r0 = JSON.stringify(requestBodies[0] ?? {})
    check(
      '6. 首轮系统提示含 <available_skills>：project 胜者 + 生态技能均入选',
      r0.includes('<available_skills>') && r0.includes('项目版描述') && r0.includes('commit-check') && r0.includes('eco-tool'),
      r0.slice(0, 200)
    )
    const toolEnd = await engine.waitEvent('tool.completed', (p) => p.sessionId === s2 && p.callId === 'r1', 30_000).catch(() => undefined)
    check(
      '7. read 渐进加载：SKILL.md 正文进工具结果（read 档免审批直执行）',
      toolEnd !== undefined && toolEnd.params.isError === false && (toolEnd.params.summary ?? '').includes('提交前三步'),
      toolEnd === undefined ? 'tool.completed 未到' : JSON.stringify(toolEnd.params.summary)
    )
    const r1 = JSON.stringify(requestBodies[1] ?? {})
    check('8. 工具结果回灌二轮（循环闭合）', r1.includes('提交前三步'))

    // ———— S3 同会话热禁用：下一轮请求该技能从清单消失（sections diff 补丁） ————
    await engine.send('skills.setEnabled', { scope: 'project', cwd: ws, name: 'commit-check', value: 'disabled' })
    await submitAndDone(s2, 'S3 再看清单')
    // 只看 system 角色消息：历史里的 read 工具结果天然含技能 frontmatter，
    // 技能名出现在工具历史不算刷新失败。生态技能 eco-tool 仍启用 —— 段还在
    // 且含它，恰好证明「消失的是被禁者」而非整段被掀（整段清除的空墓碑
    // 语义由 skill-prompt.test.ts 的空集返回 null 钉）
    const r2 = requestBodies[2] as { messages?: Array<{ role: string }> } | undefined
    const systemText = JSON.stringify((r2?.messages ?? []).filter((m) => m.role === 'system'))
    check(
      '9. 热刷新：同会话下一轮系统提示无 commit-check（生态技能仍在，段未被整掀）',
      !systemText.includes('commit-check') && systemText.includes('eco-tool') && systemText.includes('You are Cogent'),
      systemText.slice(0, 200)
    )

    // ———— S4 inherit 回落 + /skill: 活展开 ————
    await engine.send('skills.setEnabled', { scope: 'project', cwd: ws, name: 'commit-check', value: 'inherit' })
    const relist = await engine.send<SkillListResult>('skills.list', { cwd: ws })
    check(
      '10. inherit 清覆盖：回落 user 名单（启用）',
      relist.result?.skills.find((s) => s.name === 'commit-check')?.enabled === true,
      JSON.stringify(relist.result?.skills)
    )
    await submitAndDone(s2, '/skill:commit-check 列出步骤')
    const r3 = requestBodies[3] as { messages?: Array<{ role: string }> } | undefined
    const userText = JSON.stringify((r3?.messages ?? []).filter((m) => m.role === 'user'))
    // JSON 串里的引号是 \"，断言片段要先按同规则转义
    const skillTag = JSON.stringify('<skill name="commit-check"').slice(1, -1)
    check(
      '11. /skill: 活展开进用户消息（块形状 + args 追加）',
      userText.includes(skillTag) && userText.includes('提交前三步') && userText.includes('列出步骤'),
      userText.slice(0, 300)
    )
  }, 180_000)
})
