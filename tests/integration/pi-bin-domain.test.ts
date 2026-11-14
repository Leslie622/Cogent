/**
 * PI 域 env 归位回归钉。
 *
 * 事故：pi 的 tools-manager 在模块加载期冻结 TOOLS_DIR（读
 * PI_CODING_AGENT_DIR），Host 把归位赋值写在模块体里晚于 pi 加载 → app
 * （spawn 时不带该 env）的 fd/rg 查找落在 ~/.pi/agent/bin，`~/.cogent/pi/bin`
 * 里的二进制全部失明（find/grep 报 "fd is not available"）。集成测试当时
 * 全绿是 harness 显式传了 env 把 bug 掩盖 —— 本钉复刻 app 的真实条件：
 * spawn **不带** PI_CODING_AGENT_DIR，只在 <COGENT_HOME>/pi/bin 种 fd，
 * 引擎必须能找到（验入口 wrapper 的加载顺序，src/host/index.ts）。
 *
 * fd 种子来源：优先复用 harness 共享缓存（其他测试经 env 指向的下载位）；
 * 没有就经 tools-manager 现拉一次（CI 可达 GitHub）；两者皆无（内网且冷
 * 缓存）→ skip —— 与 tools.test 的 fd 自适应口径一致，不伪造环境。
 */
import { createServer, type Server } from 'node:http'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  startEngine
} from './harness'

const PORT = 18_943
const ws = makeTempDir('cogent-pibin-ws-')
const home = makeTempDir('cogent-pibin-home-')
// 共享缓存（harness 各测试经 PI_CODING_AGENT_DIR 指向的下载位）
const SHARED_BIN = join(tmpdir(), 'cogent-test-pi-domain', 'bin')

writeFileSync(join(ws, 'hello.txt'), 'pi-bin hello')

/** 种 fd 进 <home>/pi/bin；成功 = 测试可跑 */
async function seedFd(): Promise<boolean> {
  const dest = join(home, 'pi', 'bin', 'fd.exe')
  if (!existsSync(SHARED_BIN)) mkdirSync(SHARED_BIN, { recursive: true })
  if (existsSync(join(SHARED_BIN, 'fd.exe'))) {
    mkdirSync(join(home, 'pi', 'bin'), { recursive: true })
    copyFileSync(join(SHARED_BIN, 'fd.exe'), dest)
    return true
  }
  // 冷缓存：经 pi 的 tools-manager 现拉进共享位（GitHub 可达才行）
  process.env.PI_CODING_AGENT_DIR = join(tmpdir(), 'cogent-test-pi-domain')
  const tm = (await import(
    // 深路径直连：包根 import 连带的 undici 8.x 在 node <22.15 初始化即炸
    // （见 ps-utf8.test.ts 头注同款教训）
    '../../node_modules/@earendil-works/pi-coding-agent/dist/utils/tools-manager.js'
  )) as { ensureTool: (tool: 'fd' | 'rg') => Promise<string | undefined> }
  const path = await tm.ensureTool('fd')
  if (path === undefined) return false
  mkdirSync(join(home, 'pi', 'bin'), { recursive: true })
  copyFileSync(path, dest)
  return true
}

let seeded = false
let engine: EngineHandle | undefined
let server: Server | undefined

describe('PI 域 env 归位（入口 wrapper 加载顺序回归钉）', () => {
  beforeAll(async () => {
    seeded = await seedFd()
    if (!seeded) return
    // 复刻 app 的 spawn 条件：环境里没有 PI_CODING_AGENT_DIR（引擎只能靠
    // 自己入口 wrapper 的归位找到 <home>/pi/bin）。spawn 在 startEngine 内
    // 同步拷贝 env，恢复原值无竞态
    const saved = process.env.PI_CODING_AGENT_DIR
    delete process.env.PI_CODING_AGENT_DIR
    engine = startEngine(home)
    process.env.PI_CODING_AGENT_DIR = saved

    let round = 0
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        round++
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        if (round === 1) {
          res.write(
            sse(
              chunk({
                tool_calls: [
                  {
                    index: 0,
                    id: 'f1',
                    type: 'function',
                    function: { name: 'find', arguments: JSON.stringify({ pattern: 'hello.txt' }) }
                  }
                ]
              })
            )
          )
          res.write(sse(chunk({}, 'tool_calls')))
        } else {
          res.write(sse(chunk({ content: 'done' })))
          res.write(sse(chunk({}, 'stop', { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })))
        }
        res.write('data: [DONE]\n\n')
        res.end()
      })
    })
    await new Promise<void>((r) => server!.listen(PORT, '127.0.0.1', r))
    await initEngine(engine, {
      client: 'pibin-smoke',
      port: PORT,
      providers: [{ id: 'custom/mock', name: 'Mock', baseUrl: `http://127.0.0.1:${PORT}/v1`, models: ['mock'] }]
    })
  }, 120_000)

  afterAll(() => {
    engine?.kill()
    server?.close()
    for (const dir of [home, ws]) removeDir(dir)
  })

  it('引擎在无 env 的 spawn 下从 <COGENT_HOME>/pi/bin 命中 fd（find 非 error）', (ctx) => {
    if (!seeded) ctx.skip()
    return (async () => {
      const created = await engine!.send<{ id: string }>('session.create', { cwd: ws })
      if (created.result?.id === undefined) throw new Error(`session.create 失败: ${JSON.stringify(created.error)}`)
      await engine!.send('agent.submit', { sessionId: created.result.id, text: '找 hello.txt', model: 'mock' })
      const end = await engine!.waitEvent('tool.completed', (p) => p.sessionId === created.result?.id, 60_000)
      await engine!.waitEvent('run.completed', (p) => p.sessionId === created.result?.id)
      check(
        'find 非 error（fd 从 COGENT_HOME/pi/bin 命中 = wrapper 生效）',
        end.params.isError === false,
        (end.params.summary ?? '').slice(0, 160)
      )
    })()
  })
})
