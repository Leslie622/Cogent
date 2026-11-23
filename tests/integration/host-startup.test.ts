/** 真构建产物的启动诊断走 stderr，凭据只用于初始化，不进入诊断日志。 */
import { expect, it } from 'vitest'
import { createServer } from 'node:http'
import { copyFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { closeLoopback, chunk, initEngine, makeTempDir, removeDir, sse, startEngine } from './harness'
import type { AttachmentRef } from '../../src/shared/attachments'

it('Host 启动阶段可定位，握手与后续 RPC 仍正常', async () => {
  const home = makeTempDir('cogent-startup-')
  const engine = startEngine(home, { COGENT_HTTP_RPC: '1' })
  const secret = 'startup-test-credential-never-log'
  try {
    const initialized = await engine.send('initialize', {
      client: 'startup-test', protocolVersion: 3,
      credentials: { openai: { apiKey: secret } }
    })
    expect(initialized.result?.service).toBe('cogent-agent')
    expect((await engine.send('session.list')).error).toBeUndefined()
    // stdout/stderr 是两根独立管道，响应到达不保证末条诊断已被父进程读到。
    await expect.poll(() => engine.stderrLines.join('\n')).toContain('initialize 完成')
    const logs = engine.stderrLines.join('\n')
    for (const stage of ['加载 Host 模块', '初始化模型运行时', '恢复本地存储与会话',
      '装配请求路由', '启动 HTTP 监听', 'stdio 就绪', '收到 initialize', 'initialize 完成']) {
      expect(logs).toContain(stage)
    }
    expect(logs).not.toContain(secret)
  } finally {
    await engine.stop()
    removeDir(home)
  }
})

it('合并 SDK 后真实图片 worker 仍从原包加载并将图片送入请求', async () => {
  const home = makeTempDir('cogent-startup-image-')
  const observation = join(home, 'worker.json')
  let requestBody = ''
  const server = createServer((request, response) => {
    request.on('data', (data: Buffer) => { requestBody += data.toString() })
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(sse(chunk({ content: '收到图片' })) + sse(chunk({}, 'stop')) + 'data: [DONE]\n\n')
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('测试 HTTP 服务未返回端口')
  const observer = pathToFileURL(resolve('tests/integration/image-worker-observer.mjs')).href
  const engine = startEngine(home, { COGENT_IMAGE_WORKER_OUT: observation,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${observer}` })
  try {
    await initEngine(engine, { client: 'image-resource-test',
      providers: [{ id: 'custom/mock', name: 'Mock', baseUrl: `http://127.0.0.1:${address.port}/v1`, models: [],
        modelDefs: [{ id: 'mock', input: ['text', 'image'], reasoning: false }] }] })
    const original = join(home, '图片.png')
    copyFileSync('tests/fixtures/附件兼容/一像素.png', original)
    const imported = await engine.send<AttachmentRef>('attachments.importPath', { path: original })
    expect(imported.error).toBeUndefined()
    const created = await engine.send<{ id: string }>('session.create', {})
    expect(created.result).toBeDefined()
    await engine.send('agent.submit', { sessionId: created.result!.id, text: '看图',
      model: 'mock', provider: 'custom/mock', thinkingLevel: 'off', attachmentIds: [imported.result!.id] })
    await engine.waitEvent('run.completed', (params) => params.sessionId === created.result!.id, 30_000)
    expect(requestBody).toContain('image_url')
    const worker = JSON.parse(readFileSync(observation, 'utf8')) as { source: string; ok: boolean }
    expect(worker.ok).toBe(true)
    expect(worker.source).toContain('/pi-coding-agent/dist/utils/image-resize-worker.js')
  } finally {
    await engine.stop()
    await closeLoopback(server)
    removeDir(home)
  }
})
