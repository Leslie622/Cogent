/** Markdown 的本地图片同样按 id 有界读取；不让 file:// 或外部资源绕过文件服务。 */
import { useContext, useEffect, useState } from 'react'
import { FILE_LIMITS } from '@shared/files'
import { FileLink, FileLinkContext } from './FileLink'
export function FileImage({ target, alt }: { target: string; alt: string }) {
  const scope = useContext(FileLinkContext)
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (scope === null) return
    const controller = new AbortController()
    const isActive = () => !controller.signal.aborted
    let objectUrl: string | undefined
    let fileId: string | undefined
    const operationId = crypto.randomUUID()
    void (async () => {
      const file = await window.cogent.engineRequest('files.resolve', {
        sessionId: scope.sessionId,
        turnId: scope.turnId,
        rawTarget: target,
        relativeTo: scope.relativeTo
      })
      fileId = file.fileId
      if (!isActive()) {
        await window.cogent.engineRequest('files.cancel', { sessionId: scope.sessionId, operationId, fileId })
        return
      }
      if (file.kind !== 'image' || file.size > FILE_LIMITS.image)
        throw new Error('该图片不能内嵌预览，请点击文件打开')
      const chunks: Uint8Array<ArrayBuffer>[] = []
      let offset = 0
      for (;;) {
        const part = await window.cogent.engineRequest('files.readChunk', {
          sessionId: scope.sessionId,
          fileId: file.fileId,
          version: file.version,
          operationId,
          offset,
          length: FILE_LIMITS.chunk
        })
        if (!isActive()) return
        chunks.push(Uint8Array.from(atob(part.base64), (value) => value.charCodeAt(0)))
        offset = part.nextOffset
        if (part.done) break
      }
      objectUrl = URL.createObjectURL(new Blob(chunks, { type: file.mime }))
      setUrl(objectUrl)
      setError(null)
    })().catch((error: unknown) => {
      if (isActive()) setError(error instanceof Error ? error.message : String(error))
    })
    return () => {
      controller.abort()
      setUrl(null)
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl)
      void window.cogent
        .engineRequest('files.cancel', { sessionId: scope.sessionId, operationId, fileId })
        .catch(() => {
          /* 取消阶段 Host 可能已退出。 */
        })
    }
  }, [scope, target])
  return (
    <FileLink target={target}>
      {url === null ? (
        <span>{error ?? alt + '（加载中）'}</span>
      ) : (
        <img src={url} alt={alt} onError={() => setError('图片解码失败，请用系统打开')} />
      )}
      {error !== null && url !== null && <span role="alert">{error}</span>}
    </FileLink>
  )
}
