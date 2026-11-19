/** 构建后的真实stdio入口也必须允许超过20个普通文件，防止只放开草稿/服务而漏掉协议层。 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { AttachmentRef, DirectoryRef } from '../../src/shared/attachments'
import { chunk, initEngine, makeTempDir, removeDir, sse, startEngine } from './harness'

it('25个普通文件经桌面stdio受理、发送并恢复历史，非法ID仍拒绝', async () => {
  const home = makeTempDir('cogent-attachment-submit-')
  const engine = startEngine(home)
  const requests: string[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (bytes: Buffer) => { body += bytes.toString() })
    request.on('end', () => {
      requests.push(body)
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(sse(chunk({ content: '已收到25份引用' })))
      response.write(sse(chunk({}, 'stop', { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })))
      response.end('data: [DONE]\n\n')
    })
  })
  try {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const port = (server.address() as AddressInfo).port
    await initEngine(engine, { client: 'attachment-submit-test', port, providers: [{
      id: 'custom/mock', name: '附件测试', baseUrl: `http://127.0.0.1:${port}/v1`, models: [],
      modelDefs: [{ id: 'mock', input: ['text'], contextWindow: 128000, maxTokens: 4096 }]
    }] })
    const created = await engine.send('session.create', { cwd: home })
    const sessionId = created.result!.id!
    const refs: AttachmentRef[] = []
    for (let i = 0; i < 25; i++) {
      const path = join(home, `普通文件-${i}.txt`); writeFileSync(path, `正文${i}`)
      const imported = await engine.send<AttachmentRef>('attachments.importPath', { path })
      expect(imported.error).toBeUndefined(); refs.push(imported.result!)
    }
    const invalid = await engine.send('agent.submit', { sessionId, text: '', attachmentIds: ['bad-id'] })
    expect(invalid.error?.message).toContain('attachmentIds')
    const submitted = await engine.send<{ accepted: boolean }>('agent.submit', {
      sessionId, text: '请接收这25个附件', model: 'mock', provider: 'custom/mock', attachmentIds: refs.map((ref) => ref.id)
    })
    expect(submitted.error).toBeUndefined(); expect(submitted.result?.accepted).toBe(true)
    await engine.waitEvent('run.completed', (params) => params.sessionId === sessionId, 15000)
    expect(requests).toHaveLength(1)
    for (const ref of refs) expect(requests[0]).toContain(ref.name)
    const history = await engine.send('session.messages', { sessionId })
    expect(history.error).toBeUndefined()
    const user = history.result!.messages!.find((message) => message.role === 'user')!
    expect(user.attachments).toEqual(refs)
  } finally {
    engine.kill(); await new Promise<void>((done) => server.close(() => done())); removeDir(home)
  }
})

it('纯目录引用经真实pi调用ls/read，历史恢复，且不创建受管原件或工作区授权', async () => {
  const home = makeTempDir('cogent-directory-submit-'); const engine = startEngine(home)
  const workspace = join(home, '工作区'); const path = join(home, '目录 空格.png')
  mkdirSync(workspace); mkdirSync(path)
  const marker = 'DIRECTORY-CONTENT-7319'; const file = join(path, '说明.txt'); writeFileSync(file, marker)
  const requests: string[] = []
  const server = createServer((request, response) => {
    let body = ''; request.on('data', (bytes: Buffer) => { body += bytes.toString() })
    request.on('end', () => {
      requests.push(body); const n = requests.length
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (n <= 2) {
        response.write(sse(chunk({ tool_calls: [{ index: 0, id: `directory-tool-${n}`, type: 'function', function: {
          name: n === 1 ? 'ls' : 'read', arguments: JSON.stringify({ path: n === 1 ? path : file })
        } }] })))
        response.write(sse(chunk({}, 'tool_calls')))
      } else {
        response.write(sse(chunk({ content: '目录读取完成' })))
        response.write(sse(chunk({}, 'stop', { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })))
      }
      response.end('data: [DONE]\n\n')
    })
  })
  try {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done)); const port = (server.address() as AddressInfo).port
    await initEngine(engine, { client: 'directory-submit-test', port, providers: [{ id: 'custom/mock', name: '目录测试', baseUrl: `http://127.0.0.1:${port}/v1`, models: [],
      modelDefs: [{ id: 'mock', input: ['text'], contextWindow: 128000, maxTokens: 4096 }] }] })
    const created = await engine.send('session.create', { cwd: workspace }); const sessionId = created.result!.id!
    const described = await engine.send<DirectoryRef>('attachments.describe', { path }); const directory = described.result!
    expect(directory).toEqual({ kind: 'directory', name: '目录 空格.png', path })
    const submitted = await engine.send('agent.submit', { sessionId, text: '', model: 'mock', provider: 'custom/mock', directories: [{ ...directory, name: 'fake-name' }] })
    expect(submitted.error).toBeUndefined()
    await engine.waitEvent('run.completed', (params) => params.sessionId === sessionId, 15000)
    expect(requests).toHaveLength(3)
    expect(requests[0]).toContain('directory_references'); expect(requests[0]).not.toContain(marker)
    expect(requests[0]).not.toContain('fake-name'); expect(requests[1]).toContain('说明.txt'); expect(requests[2]).toContain(marker)
    const history = await engine.send('session.messages', { sessionId }); const user = history.result!.messages!.find((message) => message.role === 'user')!
    expect(user.content).toBe(''); expect(user.directories).toEqual([directory])
    expect(readdirSync(join(home, 'attachments/v1/objects'))).toEqual([])
    const summaries = await engine.send<Array<{ id: string; cwd: string; cwds?: string[] }>>('session.list')
    expect(summaries.result!.find((session) => session.id === sessionId)!.cwd).toBe(workspace)
    const invalid = await engine.send('agent.submit', { sessionId, text: '', directories: [{ ...directory, path: file }] })
    expect(invalid.error?.message).toContain('不是文件夹')
    expect((await engine.send('session.delete', { sessionId })).error).toBeUndefined()
    expect(existsSync(file)).toBe(true)
  } finally {
    engine.kill(); await new Promise<void>((done) => server.close(() => done())); removeDir(home)
  }
})
