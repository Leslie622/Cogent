/** SVG在img隔离文档里呈现；源码沿用文本坐标，保存仍由宿主取原始字节。 */
import { lazy, Suspense, useEffect, useState } from 'react'
import type { FileLocation } from '@shared/files'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useFilePreviewStore, type FileViewState } from '@/stores/file-preview'
import ImagePreview from './ImagePreview'

const TextPreview = lazy(() => import('../TextPreview'))

export default function SvgPreview({ text, name, tabId, active, location, onSave }: {
  text: string; name: string; tabId: string; active: boolean; location?: FileLocation
  onSave: () => Promise<{ canceled: boolean }>
}) {
  const saved = useFilePreviewStore<FileViewState | undefined>(state => state.views[tabId])
  const mode = saved?.markdownMode ?? (location === undefined ? 'render' : 'source')
  const [image, setImage] = useState<{ text: string; url: string } | null>(null)
  useEffect(() => {
    // 文本读取已完成编码解码；图像Blob声明UTF-8，避免旧XML声明把Unicode重新当其他编码。
    const source = text.replace(/^\uFEFF?\s*<\?xml[^?]*\?>/i, '')
    const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml;charset=utf-8' }))
    setImage({ text, url })
    return () => URL.revokeObjectURL(url)
  }, [text])
  return <Tabs value={mode} onValueChange={(value: unknown) => {
    if (value === 'render' || value === 'source') useFilePreviewStore.getState().setView(tabId, { markdownMode: value })
  }} className="h-full min-h-0" data-svg-preview>
    <TabsList className="mx-3 mt-2"><TabsTrigger value="render">预览</TabsTrigger><TabsTrigger value="source">源码</TabsTrigger></TabsList>
    <TabsContent value="render" keepMounted className="min-h-0 flex-1">
      {image?.text === text && <ImagePreview url={image.url} name={name} tabId={tabId} active={active && mode === 'render'} onSave={onSave} scrollMode="render" />}
    </TabsContent>
    <TabsContent value="source" keepMounted className="min-h-0 flex-1"><Suspense fallback={<p className="p-3 text-sm">正在加载查看器…</p>}>
      <TextPreview text={text} name={name} location={location} tabId={tabId} active={active && mode === 'source'} />
    </Suspense></TabsContent>
  </Tabs>
}
