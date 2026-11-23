/** 用受控子进程确定性验证 harness 的字节边界、超时和退出。 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { connectEngine, sleep } from './harness'

const script = `
  const { createInterface } = require('node:readline')
  const stdin = createInterface({ input: process.stdin })
  let frame, boundary
  stdin.on('line', line => {
    const { id, method } = JSON.parse(line)
    if (method === 'split') {
      frame = Buffer.from(JSON.stringify({ id, result: '中文🙂' }) + '\\n')
      boundary = frame.indexOf(Buffer.from('中')) + 1
      process.stdout.write(frame.subarray(0, boundary))
    } else if (method === 'continue') {
      process.stdout.write(frame.subarray(boundary))
      process.stdout.write(JSON.stringify({ method: 'example', params: { text: '完成' } }) + '\\n')
      process.stdout.write(JSON.stringify({ id, result: true }) + '\\n')
    } else if (method === 'quit') {
      process.stderr.write('异常退出', () => process.exit(23))
    }
  })
`

it('流式解码和超时清理保留迟到事件，退出结束所有等待', async () => {
  const child = spawn(process.execPath, ['--input-type=commonjs', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'] })
  const engine = connectEngine(child)
  try {
    await expect(engine.waitEvent('example', undefined, 20)).rejects.toThrow('等待事件超时')
    await expect(engine.send('ignored', undefined, 20)).rejects.toThrow('等待 RPC 超时')
    const partial = once(child.stdout, 'data')
    const split = engine.send<string>('split')
    await partial
    await expect(engine.send('continue')).resolves.toEqual({ id: 3, result: true })
    await expect(split).resolves.toEqual({ id: 2, result: '中文🙂' })
    // 给旧轮询足够时间误抢迟到事件，随后再用新的等待器读取。
    await sleep(60)
    await expect(engine.waitEvent('example', undefined, 100)).resolves.toMatchObject({ params: { text: '完成' } })
    const waiting = expect(engine.waitEvent('never')).rejects.toThrow('异常退出')
    const request = expect(engine.send('quit')).rejects.toThrow('23')
    await Promise.all([waiting, request])
  } finally {
    await engine.stop()
  }
})
