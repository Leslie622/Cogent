/** 单 worker 请求桥；目录快照/查询游标留在 worker，主 Host 只传结果页。 */
import { Worker } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { FileViewDirectory, FileViewSearch } from '../../../shared/file-views'
import type { ScanRequest } from './scan-engine'
export interface DirectoryScanner { run(request: ScanRequest, signal?: AbortSignal): Promise<FileViewDirectory | FileViewSearch | { ok: true }>; dispose(): void }
export class WorkerDirectoryScanner implements DirectoryScanner {
  private worker: Worker | undefined
  private pending = new Map<string, { resolve: (value: FileViewDirectory | FileViewSearch | { ok: true }) => void; reject: (error: Error) => void; cleanup: () => void }>()
  private getWorker(): Worker {
    if (this.worker !== undefined) return this.worker
    const worker = new Worker(process.env.COGENT_FILE_VIEW_WORKER ?? join(import.meta.dirname, '..', 'file-view-worker.js'), { resourceLimits: { maxOldGenerationSizeMb: 256 }, stdout: true, stderr: true })
    this.worker = worker; worker.unref()
    worker.stdout.on('data', (data: Buffer) => process.stderr.write(data)); worker.stderr.on('data', (data: Buffer) => process.stderr.write(data))
    worker.on('message', (message: { id: string; result?: FileViewDirectory | FileViewSearch | { ok: true }; error?: string }) => {
      const pending = this.pending.get(message.id)
      if (pending === undefined) return
      this.pending.delete(message.id); pending.cleanup()
      if (message.error !== undefined) pending.reject(new Error(message.error)); else pending.resolve(message.result!)
    })
    worker.once('error', (error: Error) => this.failed(worker, error))
    worker.once('exit', (code) => this.failed(worker, new Error(`目录 worker 退出（${code}），请重新展开或搜索`)))
    return worker
  }
  private failed(worker: Worker, error: Error): void {
    if (this.worker !== worker) return
    this.worker = undefined
    for (const request of this.pending.values()) { request.cleanup(); request.reject(error) }
    this.pending.clear()
  }
  run(request: ScanRequest, signal?: AbortSignal): Promise<FileViewDirectory | FileViewSearch | { ok: true }> {
    signal?.throwIfAborted()
    if (this.worker === undefined && (request.kind === 'close' || request.kind === 'cancel')) return Promise.resolve({ ok: true })
    if (this.pending.size >= 64) return Promise.reject(new Error('目录请求过多，请等待当前操作完成'))
    const worker = this.getWorker(); const id = randomUUID()
    return new Promise((resolve, reject) => {
      const abort = () => worker.postMessage({ id, cancel: true })
      const timer = setTimeout(() => { this.failed(worker, new Error('目录读取超过 30 秒；网络盘可稍后重试')); void worker.terminate() }, 30_000)
      this.pending.set(id, { resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) } })
      signal?.addEventListener('abort', abort, { once: true }); worker.postMessage({ id, request })
    })
  }
  dispose(): void { const worker = this.worker; if (worker !== undefined) { this.failed(worker, new Error('目录服务已关闭')); void worker.terminate() } }
}
