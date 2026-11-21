/** Host 搜索编排：worker 惰性启动、单连接复用；故障拒绝在途请求，下次可重新启动。 */
import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import type { SearchPage, SearchQuery } from '../../../shared/session-search'
import type { SearchDescriptor } from './corpus'
import type { SearchWorkerRequest, SearchWorkerResponse } from './worker'

export class SessionSearchService {
  private worker?: Worker
  private nextId = 0
  private pending = new Map<number, { resolve: (result: SearchPage | { ok: true }) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  constructor(private root: string) {}
  async search(query: SearchQuery, descriptors: SearchDescriptor[]): Promise<SearchPage> {
    return await this.request({ query, descriptors }) as SearchPage
  }
  async rebuild(): Promise<{ ok: true }> { return await this.request({ descriptors: [], rebuild: true }) as { ok: true } }
  dispose(): void {
    const worker = this.worker
    this.worker = undefined
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('搜索服务已关闭')) }
    this.pending.clear()
    if (worker !== undefined) void worker.terminate()
  }
  private request(payload: Omit<SearchWorkerRequest, 'id'>): Promise<SearchPage | { ok: true }> {
    if (this.worker === undefined) {
      const worker = new Worker(process.env.COGENT_SEARCH_WORKER ?? join(import.meta.dirname, '..', 'search-worker.js'), { workerData: { root: this.root }, stdout: true, stderr: true })
      this.worker = worker
      worker.stdout.on('data', (data: Buffer) => process.stderr.write(data))
      worker.stderr.on('data', (data: Buffer) => process.stderr.write(data))
      worker.on('message', (message: SearchWorkerResponse) => {
        const item = this.pending.get(message.id)
        if (item === undefined) return
        clearTimeout(item.timer); this.pending.delete(message.id)
        if ('error' in message) item.reject(new Error(message.error))
        else item.resolve(message.result)
        if (this.pending.size === 0) worker.unref()
      })
      const failed = (error: Error) => { if (this.worker === worker) { this.dispose(); process.stderr.write(`[host] 搜索 worker 失败：${error.message}\n`) } }
      worker.once('error', failed)
      worker.once('exit', (code) => failed(new Error(`退出码 ${code}`)))
    }
    const worker = this.worker
    worker.ref()
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('搜索超时，请重试或重建索引')); if (this.pending.size === 0) worker.unref() }, 60_000)
      this.pending.set(id, { resolve, reject, timer })
      worker.postMessage({ id, ...payload } satisfies SearchWorkerRequest)
    })
  }
}
