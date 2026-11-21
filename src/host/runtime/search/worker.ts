/** 搜索 worker 独占索引；同步 SQLite 与全文读取不占 Host 的消息/停止事件循环。 */
import { parentPort, workerData } from 'node:worker_threads'
import { join } from 'node:path'
import { existsSync, renameSync } from 'node:fs'
import { SearchDatabase } from './database'
import { loadSearchSource, locateSearchSource, type SearchDescriptor } from './corpus'
import type { SearchPage, SearchQuery } from '../../../shared/session-search'

export interface SearchWorkerRequest { id: number; query?: SearchQuery; descriptors: SearchDescriptor[]; rebuild?: boolean }
export type SearchWorkerResponse = { id: number; result: SearchPage | { ok: true } } | { id: number; error: string }
const root = (workerData as { root: string }).root
const path = join(root, 'search', 'sessions-v1.sqlite')
let database: SearchDatabase | undefined
parentPort!.on('message', (request: SearchWorkerRequest) => {
  try {
    if (request.rebuild) {
      database?.close(); database = undefined
      const suffix = `.previous-${Date.now()}`
      for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file)) renameSync(file, file + suffix)
      parentPort!.postMessage({ id: request.id, result: { ok: true } } satisfies SearchWorkerResponse)
      return
    }
    database ??= new SearchDatabase(path)
    const known = new Set(request.descriptors.map((descriptor) => descriptor.summary.id))
    for (const summary of database.summaries()) if (!known.has(summary.id)) database.remove(summary.id)
    const issues: SearchPage['issues'] = []
    for (const descriptor of request.descriptors) {
      try {
        const source = locateSearchSource(root, descriptor)
        const changed = database.revision(descriptor.summary.id) !== source.revision
        const loaded = changed ? loadSearchSource(root, descriptor, source) : undefined
        database.replace(descriptor.summary, source.revision, loaded?.documents)
      } catch (error) {
        // 磁盘是信任边界；坏会话显式报不完整，旧索引不得伪装为当前正文。
        database.remove(descriptor.summary.id)
        issues.push({ sessionId: descriptor.summary.id, message: error instanceof Error ? error.message : String(error) })
      }
    }
    const result = database.search(request.query!)
    result.issues = issues
    parentPort!.postMessage({ id: request.id, result } satisfies SearchWorkerResponse)
  } catch (error) {
    parentPort!.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) } satisfies SearchWorkerResponse)
  }
})
