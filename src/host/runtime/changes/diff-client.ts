/** 净差异计算器桥接：生产走独立 worker，源码直测可注入或回落同进程实现。 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { computeDiffStat, type DiffStatResult } from './diff-core'

export interface DiffCalculator {
  stat(before: Buffer | null, after: Buffer | null, timeoutMs: number, signal?: AbortSignal): Promise<DiffStatResult>
  dispose(): void
}

export class InProcessDiffCalculator implements DiffCalculator {
  stat(before: Buffer | null, after: Buffer | null, timeoutMs: number, signal?: AbortSignal): Promise<DiffStatResult> {
    signal?.throwIfAborted()
    return Promise.resolve(computeDiffStat(before, after, timeoutMs))
  }
  dispose(): void {}
}

export class WorkerDiffCalculator implements DiffCalculator {
  private worker: Worker | undefined
  private pending = new Map<string, {
    resolve: (result: DiffStatResult) => void
    reject: (error: Error) => void
    cleanup: () => void
  }>()

  constructor(private workerPath = process.env.COGENT_CHANGE_DIFF_WORKER ?? join(import.meta.dirname, '..', 'change-diff-worker.js')) {}

  private getWorker(): Worker {
    if (this.worker !== undefined) return this.worker
    const worker = new Worker(this.workerPath, { resourceLimits: { maxOldGenerationSizeMb: 256 }, stdout: true, stderr: true })
    this.worker = worker
    worker.unref()
    worker.stdout.on('data', (data: Buffer) => process.stderr.write(data))
    worker.stderr.on('data', (data: Buffer) => process.stderr.write(data))
    worker.on('message', (msg: { id: string; result?: DiffStatResult; error?: string }) => {
      const entry = this.pending.get(msg.id)
      if (entry === undefined) return
      this.pending.delete(msg.id)
      entry.cleanup()
      if (msg.error !== undefined) entry.reject(new Error(msg.error))
      else entry.resolve(msg.result!)
    })
    worker.once('error', (error: Error) => this.failed(worker, error))
    worker.once('exit', (code) => this.failed(worker, new Error(`差异计算 worker 退出（${code}）`)))
    return worker
  }

  private failed(worker: Worker, error: Error): void {
    if (this.worker !== worker) return
    this.worker = undefined
    for (const entry of this.pending.values()) {
      entry.cleanup()
      entry.reject(error)
    }
    this.pending.clear()
  }

  stat(before: Buffer | null, after: Buffer | null, timeoutMs: number, signal?: AbortSignal): Promise<DiffStatResult> {
    signal?.throwIfAborted()
    const worker = this.getWorker()
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const abort = () => {
        const entry = this.pending.get(id)
        if (entry === undefined) return
        this.pending.delete(id)
        entry.cleanup()
        reject(new Error('差异计算已取消', { cause: signal?.reason }))
      }
      const timer = setTimeout(() => {
        const entry = this.pending.get(id)
        if (entry === undefined) return
        this.pending.delete(id)
        entry.cleanup()
        // 阻塞超时终止失控 worker，下次调用按需重建，避免单次大文件拖垮整个会话。
        this.failed(worker, new Error('差异计算超时'))
        void worker.terminate()
        resolve({ status: 'timeout', added: null, deleted: null })
      }, Math.max(timeoutMs * 4, 5_000))
      this.pending.set(id, {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', abort)
        }
      })
      signal?.addEventListener('abort', abort, { once: true })
      worker.postMessage({ id, before, after, timeoutMs })
    })
  }

  dispose(): void {
    const worker = this.worker
    if (worker === undefined) return
    this.failed(worker, new Error('差异计算服务已关闭'))
    void worker.terminate()
  }
}

export function createDefaultDiffCalculator(): DiffCalculator {
  const path = process.env.COGENT_CHANGE_DIFF_WORKER ?? join(import.meta.dirname, '..', 'change-diff-worker.js')
  return existsSync(path) ? new WorkerDiffCalculator(path) : new InProcessDiffCalculator()
}
