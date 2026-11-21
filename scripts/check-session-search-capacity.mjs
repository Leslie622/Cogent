/** 合成磁盘语料容量探针；测完整 worker 往返，禁止用它替代真实用户语料与多平台验证。 */
import { Worker } from 'node:worker_threads'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

const root = mkdtempSync(join(tmpdir(), 'cogent-search-capacity-'))
mkdirSync(join(root, 'sessions'))
const descriptors = []
for (let session = 0; session < 100; session++) {
  const summary = { id: randomUUID(), title: `容量聊天 ${session}`, createdAt: session, updatedAt: session }
  const transcript = Array.from({ length: 500 }, (_, message) => ({ role: 'user', timestamp: message,
    content: `第 ${message} 条历史消息。` + '正常的中英文会话正文 abcdef，保持合成文本大小。'.repeat(8) + (message === 498 ? 'needlehistory 登录报错 你好' : '') }))
  writeFileSync(join(root, 'sessions', `${summary.id}.json`), JSON.stringify({ version: 1, summary, transcript }))
  descriptors.push({ summary, cwd: root })
}
const worker = new Worker(resolve('out/main/search-worker.js'), { workerData: { root }, stdout: true, stderr: true })
worker.stdout.on('data', (data) => process.stderr.write(data))
worker.stderr.on('data', (data) => process.stderr.write(data))
const pending = new Map(); let id = 0
worker.on('message', (message) => { const request = pending.get(message.id); pending.delete(message.id); message.error ? request.reject(new Error(message.error)) : request.resolve(message.result) })
const request = query => new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); worker.postMessage({ id: key, descriptors, query: { query } }) })
const failures = []
let last = performance.now(), maximumHeartbeatGap = 0
const heartbeat = setInterval(() => { const now = performance.now(); maximumHeartbeatGap = Math.max(maximumHeartbeatGap, now - last); last = now }, 10)
try {
  const cold = performance.now(); const initial = await request('needlehistory'); const coldMs = performance.now() - cold
  if (initial.issues.length > 0 || initial.items.length !== 30) throw new Error('合成语料索引不完整')
  const timings = []
  for (const query of ['needlehistory', '登录报错', '你好', '好', '历史']) {
    const samples = []
    for (let iteration = 0; iteration < 20; iteration++) { const before = performance.now(); await request(query); samples.push(performance.now() - before) }
    samples.sort((a, b) => a - b)
    const row = { query, p50ms: +samples[10].toFixed(2), p95ms: +samples[18].toFixed(2) }; timings.push(row)
    if (row.p95ms > 200) failures.push(query)
  }
  const result = { node: process.version, sessions: 100, messages: 50000, rounds: 20, coldMs: +coldMs.toFixed(2), timings,
    maximumHeartbeatGapMs: +maximumHeartbeatGap.toFixed(2), databaseBytes: statSync(join(root, 'search', 'sessions-v1.sqlite')).size, warmTarget200ms: failures.length === 0 }
  mkdirSync(resolve('tmp/session-search-capacity'), { recursive: true })
  writeFileSync(resolve('tmp/session-search-capacity/result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
} finally {
  clearInterval(heartbeat); await worker.terminate()
  if (!root.startsWith(join(tmpdir(), 'cogent-search-capacity-'))) throw new Error('临时目录越界')
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
