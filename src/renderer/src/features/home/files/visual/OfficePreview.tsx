/** 原始Office字节只在本tab中解码；格式组件懒加载，取消/回收不允许迟到解析覆盖另一文件。 */
import { lazy, Suspense, useEffect, useState } from 'react'
import { unzipSync } from 'fflate'
import type { VisualPreviewProps } from './types'

const Docx = lazy(() => import('./DocxPreview'))
const Xlsx = lazy(() => import('./XlsxPreview'))
const Pptx = lazy(() => import('./PptxPreview'))

export function validateOfficeArchive(buffer: ArrayBuffer, name: string): void {
  if (!/\.(docx|xlsx|xlsm|pptx)$/i.test(name)) return
  let bytes = 0, entries = 0
  // 只扫描ZIP目录，不展开成员；压缩包是外部输入，先约束解析器的展开规模。
  unzipSync(new Uint8Array(buffer), { filter: entry => {
    entries++; bytes += entry.originalSize
    if (entries > 4000 || entry.originalSize > 32 * 1024 ** 2 || bytes > 256 * 1024 ** 2) throw new Error('Office文档展开量超过可视化预览预算')
    return false
  } })
}

export default function OfficePreview({ url, ...props }: Omit<VisualPreviewProps, 'buffer'> & { url: string }) {
  const [loaded, setLoaded] = useState<{ url: string; buffer: ArrayBuffer } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    setError(null); setLoaded(null)
    void (async () => {
      const response = await fetch(url, { signal: controller.signal })
      if (!response.ok) throw new Error('Office文件字节加载失败')
      const buffer = await response.arrayBuffer()
      controller.signal.throwIfAborted()
      validateOfficeArchive(buffer, props.name)
      setLoaded({ url, buffer })
    })().catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => controller.abort()
  }, [url, props.name])
  if (error !== null) return <p role="alert" className="p-3 text-sm text-destructive">{error}</p>
  if (loaded?.url !== url) return <p role="status" className="p-3 text-sm text-muted-foreground">正在读取文档…</p>
  const Viewer = /\.(xlsx|xlsm|xls)$/i.test(props.name) ? Xlsx : /\.pptx$/i.test(props.name) ? Pptx : Docx
  return <Suspense fallback={<p role="status" className="p-3 text-sm text-muted-foreground">正在加载文档查看器…</p>}><Viewer {...props} buffer={loaded.buffer} /></Suspense>
}
