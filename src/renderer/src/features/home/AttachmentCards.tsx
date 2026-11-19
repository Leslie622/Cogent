/** 输入区与历史复用的附件卡；正常只显示文件信息，异常才提供操作提示。 */
import { useEffect, useState } from 'react'
import { IconFile, IconPhoto, IconVideo, IconX, IconRefresh, IconDownload, IconFolder } from '@tabler/icons-react'
import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription,
  AttachmentGroup, AttachmentMedia, AttachmentRemove, AttachmentStatus, AttachmentTitle, AttachmentTrigger } from '@/components/ui/attachment'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { DraftAttachment } from '@/stores/attachments'
import { formatAttachmentBytes as formatBytes, hasLocalAttachmentReader, mediaBindingIssue, NATIVE_IMAGE_MIMES, type AttachmentRef, type MediaBindings } from '@shared/attachments'
import { unwrapIpcError } from '@/lib/ipc'

export function isReferenceOnlyAttachment(ref: AttachmentRef, imageInput: boolean, media: MediaBindings): boolean {
  if (imageInput && NATIVE_IMAGE_MIMES.includes(ref.mime)) return false
  const kind = ref.mime.startsWith('image/') ? 'image' : ref.mime.startsWith('video/') ? 'video' : 'document'
  if (kind === 'document' && hasLocalAttachmentReader(ref)) return false
  const binding = media[kind]
  return binding === undefined || mediaBindingIssue(ref, binding) !== undefined
}
function isImage(item: DraftAttachment): boolean {
  if (item.directory !== undefined) return false
  return item.ref === undefined ? /\.(?:png|jpe?g|gif|webp)$/i.test(item.name) : NATIVE_IMAGE_MIMES.includes(item.ref.mime)
}
function AttachmentCard({ item, onRemove, onRetry }: {
  item: DraftAttachment; onRemove?: () => void; onRetry?: () => void
}) {
  const [thumbnail, setThumbnail] = useState<string>()
  const [preview, setPreview] = useState<string>()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string>()
  const ref = item.ref
  const directory = item.directory
  const image = isImage(item)
  const issue = error ?? item.error
  const canRetry = item.status === 'error' && onRetry !== undefined
  const fileActions = !image && onRemove === undefined && ref !== undefined
  useEffect(() => {
    if (ref === undefined && directory === undefined) return
    const lifetime = { active: true }
    void (async () => {
      try {
        if (directory !== undefined) {
          const info = await window.cogent.engineRequest('attachments.describe', { path: directory.path })
          if (!('kind' in info)) throw new Error('路径已不是文件夹')
          if (lifetime.active) setError(undefined)
          return
        }
        await window.cogent.engineRequest('attachments.resolve', { id: ref!.id })
        if (image) { const value = await window.cogent.attachmentPreview(ref!.id, true); if (lifetime.active) setThumbnail(value) }
      } catch (cause) { if (lifetime.active) setError(`${directory === undefined ? '附件' : '文件夹'}不可用：${unwrapIpcError(cause)}`) }
    })()
    return () => { lifetime.active = false }
  }, [image, ref, directory])
  const openDirectory = (): void => {
    void window.cogent.openPath(directory!.path).then((issue) => setError(issue === null ? undefined : issue), (cause: unknown) => setError(unwrapIpcError(cause)))
  }
  const action = (name: 'reveal' | 'save'): void => {
    void window.cogent.attachmentAction(ref!.id, name).catch((cause: unknown) => setError(unwrapIpcError(cause)))
  }
  const show = (): void => {
    setOpen(true)
    void window.cogent.attachmentPreview(ref!.id, false).then(setPreview, (cause: unknown) => setError(unwrapIpcError(cause)))
  }
  return <>
    <Attachment size="sm" variant={image ? 'image' : 'file'}
      state={item.status === 'error' || error !== undefined ? 'error' : item.status === 'queued' ? 'idle' : item.status === 'importing' ? 'processing' : 'done'}
      aria-label={image ? `图片 ${item.name}` : undefined}>
      <AttachmentMedia variant={thumbnail === undefined ? 'icon' : 'image'}>
        {thumbnail !== undefined ? <img src={thumbnail} alt={item.name} /> : directory !== undefined ? <IconFolder /> : image ? <IconPhoto /> : ref?.mime.startsWith('video/') ? <IconVideo /> : <IconFile />}
      </AttachmentMedia>
      {!image && <AttachmentContent>
        <AttachmentTitle title={item.name}>{item.name}</AttachmentTitle>
        <AttachmentDescription title={issue}>
          {issue ?? (directory !== undefined ? directory.path : item.status === 'queued' ? '等待导入' : item.status === 'importing' ? `正在导入${item.progress === undefined ? '…' : ` ${formatBytes(item.progress)}`}` : item.status === 'error' ? '导入失败' : formatBytes(item.size))}
        </AttachmentDescription>
      </AttachmentContent>}
      {image && ref !== undefined && item.status === 'ready' && <AttachmentTrigger aria-label={`预览 ${item.name}`} onClick={show} />}
      {directory !== undefined && <AttachmentTrigger aria-label={`打开文件夹 ${item.name}`} title={directory.path} onClick={openDirectory} />}
      {(canRetry || fileActions) && <AttachmentActions variant={image ? 'overlay' : 'default'}>
        {canRetry && <AttachmentAction size={image ? 'icon-2xs' : undefined} variant={image ? 'secondary' : undefined} aria-label={`重试 ${item.name}`} onClick={onRetry}><IconRefresh /></AttachmentAction>}
        {fileActions && <>
          <AttachmentAction aria-label={`定位 ${item.name}`} onClick={() => action('reveal')}><IconFolder /></AttachmentAction>
          <AttachmentAction aria-label={`另存 ${item.name}`} onClick={() => action('save')}><IconDownload /></AttachmentAction>
        </>}
      </AttachmentActions>}
      {onRemove !== undefined && <AttachmentRemove aria-label={`移除 ${item.name}`} onClick={onRemove}><IconX /></AttachmentRemove>}
      {image && (issue !== undefined || item.status === 'error') && <AttachmentStatus state="error" role="alert" title={issue}>不可用</AttachmentStatus>}
      {image && item.status === 'importing' && <AttachmentStatus state="processing" role="status">导入中</AttachmentStatus>}
      {image && item.status === 'queued' && <AttachmentStatus state="processing" role="status">等待中</AttachmentStatus>}
    </Attachment>
    <Dialog open={open} onOpenChange={(value) => { setOpen(value); if (!value) setPreview(undefined) }}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader><DialogTitle>{item.name}</DialogTitle></DialogHeader>
        {error !== undefined ? <p role="alert">{error}</p> : preview !== undefined ? <img className="max-h-[70vh] w-full object-contain" src={preview} alt={item.name} /> : <p>正在读取图片…</p>}
        <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => action('reveal')}>定位原件</Button><Button onClick={() => action('save')}>另存为</Button></div>
      </DialogContent>
    </Dialog>
  </>
}
export function AttachmentCards({ items, onRemove, onRetry, history = false }: {
  items: DraftAttachment[]; history?: boolean
  onRemove?: (key: string) => void; onRetry?: (key: string) => void
}) {
  const card = (item: DraftAttachment) => <AttachmentCard key={item.key} item={item}
      onRemove={onRemove === undefined ? undefined : () => onRemove(item.key)} onRetry={onRetry === undefined ? undefined : () => onRetry(item.key)} />
  if (!history) return <AttachmentGroup aria-label="附件" layout="composer" className="w-full">{items.map(card)}</AttachmentGroup>
  const images = items.filter(isImage)
  const files = items.filter((item) => !isImage(item))
  return <div data-slot="message-attachments" className="flex max-w-full flex-col items-end gap-2 self-end">
    {images.length > 0 && <AttachmentGroup aria-label="图片附件" layout="wrap" align="end" className="max-w-full">{images.map(card)}</AttachmentGroup>}
    {files.length > 0 && <AttachmentGroup aria-label="文件附件" layout="wrap" align="end" className="max-w-full">{files.map(card)}</AttachmentGroup>}
  </div>
}
