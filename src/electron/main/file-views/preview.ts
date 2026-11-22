/** 浏览器只通过保有的 lease 读资源；交付依赖继续由 Host 冻结清单解析，main 不拿路径读盘。 */
import { randomUUID } from 'node:crypto'
import type { IpcDeps } from '../ipc'
import { FILE_LIMITS } from '../../../shared/files'
import type { FileViewLease } from '../../../shared/file-views'
import { createPreviewPolicy } from './preview-policy'
export async function createFileViewPreviewSource(deps: IpcDeps, leaseId: string, selectedRoot?: string) {
  const windowId = deps.getWindow()!.webContents.id
  const parent = await deps.host.request('fileViews.cloneLease', { windowId, leaseId })
  let current: Awaited<ReturnType<typeof createPreviewPolicy>> | undefined
  try {
    if (parent.descriptor.delivery === undefined) current = await createPreviewPolicy(parent.descriptor.path, selectedRoot)
    else if (selectedRoot !== undefined) throw new Error('交付版HTML只使用同版冻结资源，不能扩大资源目录')
  } catch (error) { await deps.host.request('fileViews.release', { windowId, leaseId: parent.leaseId }); throw error }
  let released = false
  const isReleased = () => released
  const active = new Set<string>()
  return {
    kind: parent.descriptor.delivery === undefined ? 'current' as const : 'delivery' as const,
    path: current?.path ?? parent.descriptor.path,
    entryPath: current?.entryPath,
    policy: current?.policy,
    readResource: async (relativePath: string): Promise<{ bytes: Uint8Array; mime: string }> => {
      if (isReleased()) throw new Error('网页文件来源已关闭')
      const operationId = randomUUID()
      active.add(operationId)
      let resource: FileViewLease | undefined
      try {
        resource = await deps.host.request('fileViews.previewResource', { windowId, leaseId: parent.leaseId, relativePath, ...(current === undefined ? {} : { policy: current.policy }) })
        const chunks: Buffer[] = []; let offset = 0
        for (;;) {
          if (isReleased()) throw new Error('网页文件来源已关闭')
          const result = await deps.host.request('fileViews.readChunk', { windowId, leaseId: resource.leaseId, version: resource.descriptor.version, operationId, offset, length: FILE_LIMITS.chunk })
          chunks.push(Buffer.from(result.base64, 'base64')); offset = result.nextOffset
          if (result.done) break
        }
        return { bytes: Buffer.concat(chunks), mime: resource.descriptor.mime }
      } finally { active.delete(operationId); if (resource !== undefined) await deps.host.request('fileViews.release', { windowId, leaseId: resource.leaseId }) }
    },
    release: async () => {
      if (released) return
      released = true
      try { await Promise.all([...active].map(operationId => deps.host.request('fileViews.cancel', { windowId, operationId }))) }
      finally { await deps.host.request('fileViews.release', { windowId, leaseId: parent.leaseId }) }
    }
  }
}
