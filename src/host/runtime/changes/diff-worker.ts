/** 独立工作线程：对首尾原始字节做解码和净行差计算，避免大文本阻塞 Host 事件循环。 */
import { parentPort } from 'node:worker_threads'
import { computeDiffStat } from './diff-core'

interface WorkerMessage {
  id: string
  before: Uint8Array | null
  after: Uint8Array | null
  timeoutMs: number
}

parentPort?.on('message', (msg: WorkerMessage) => {
  try {
    const beforeBuf = msg.before === null ? null : Buffer.from(msg.before.buffer, msg.before.byteOffset, msg.before.byteLength)
    const afterBuf = msg.after === null ? null : Buffer.from(msg.after.buffer, msg.after.byteOffset, msg.after.byteLength)
    const result = computeDiffStat(beforeBuf, afterBuf, msg.timeoutMs)
    parentPort?.postMessage({ id: msg.id, result })
  } catch (error) {
    parentPort?.postMessage({ id: msg.id, error: error instanceof Error ? error.message : String(error) })
  }
})
