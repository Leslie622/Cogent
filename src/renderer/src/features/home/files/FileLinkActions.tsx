/** 文件链接的 hover/右键交互；临时解析句柄用完释放，状态随链接来源身份隔离。 */
import { useId, useRef, useState, type ReactElement } from 'react'
import { IconCheck, IconCopy, IconDownload, IconExternalLink, IconEye, IconFolder, IconPencil } from '@tabler/icons-react'
import type { FileAction, FileDescriptor, FileKind } from '@shared/files'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { FileActionErrorDialog } from './FileActionErrorDialog'
import type { FileLinkScope } from './FileLink'

const reason = (error: unknown) => error instanceof Error ? error.message : String(error)

export function FileLinkActions({ scope, target, title, children, onPreview }: {
  scope: FileLinkScope; target: string; title?: string; children: ReactElement; onPreview: () => void
}) {
  const [tooltipOpen, setTooltipOpen] = useState(false)
  const [hint, setHint] = useState<{ path: string | null; kind: FileKind | null; error: string | null }>({ path: null, kind: null, error: null })
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const requesting = useRef(false)
  const tooltipId = useId()
  const release = (file: FileDescriptor) => window.cogent.engineRequest('files.cancel', {
    sessionId: scope.sessionId, operationId: crypto.randomUUID(), fileId: file.fileId
  })
  const withFile = async (operation: (file: FileDescriptor) => void | Promise<void>) => {
    const file = await window.cogent.engineRequest('files.resolve', {
      sessionId: scope.sessionId, turnId: scope.turnId, rawTarget: target, relativeTo: scope.relativeTo
    })
    try { await operation(file) }
    finally { await release(file) }
  }
  const resolveHint = () => {
    if (requesting.current) return
    requesting.current = true
    setCopied(false)
    setHint({ path: null, kind: null, error: null })
    void withFile((file) => setHint({ path: file.delivery?.sourcePath ?? file.path, kind: file.kind, error: null }))
      .catch((error: unknown) => setHint({ path: null, kind: null, error: reason(error) }))
      .finally(() => { requesting.current = false })
  }
  const fail = (error: unknown) => { setTooltipOpen(false); setError(reason(error)) }
  const copy = async () => {
    try {
      await withFile((file) => navigator.clipboard.writeText(file.delivery?.sourcePath ?? file.path))
      setCopied(true)
    } catch (error) { fail(error) }
  }
  const action = async (action: FileAction) => {
    try {
      await withFile(async (file) => {
        const current = file.delivery !== undefined && (action === 'editor' || action === 'reveal')
          ? await window.cogent.engineRequest('outputs.resolve', { ...file.delivery.target, version: 'current' }) : file
        try {
          await window.cogent.fileAction({ sessionId: scope.sessionId, fileId: current.fileId, action, location: file.location })
        } finally { if (current !== file) await release(current) }
      })
    } catch (error) { fail(error) }
  }
  return <>
    <TooltipProvider delay={400}>
      <Tooltip open={tooltipOpen} onOpenChange={(open) => { setTooltipOpen(open); if (open) resolveHint() }}>
        <ContextMenu onOpenChange={(open) => { if (open) { setTooltipOpen(false); resolveHint() } }}>
          <ContextMenuTrigger className="select-text" render={<TooltipTrigger aria-describedby={tooltipOpen ? tooltipId : undefined} render={children} />} />
          <ContextMenuContent onClick={(event) => event.stopPropagation()}>
            <ContextMenuItem onClick={onPreview}><IconEye />打开预览</ContextMenuItem>
            <ContextMenuItem onClick={() => void action('open')}><IconExternalLink />系统打开</ContextMenuItem>
            <ContextMenuItem onClick={() => void action('reveal')}><IconFolder />在文件管理器中定位</ContextMenuItem>
            <ContextMenuItem onClick={() => void action('editor')}><IconPencil />编辑当前原文件</ContextMenuItem>
            <ContextMenuItem disabled={hint.kind === 'directory'} onClick={() => void action('save')}><IconDownload />另存为…</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => void copy()}><IconCopy />复制完整路径</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        <TooltipContent id={tooltipId} role="tooltip" className="max-w-md" align="start" onClick={(event) => event.stopPropagation()}>
          <div className="flex min-w-0 items-center gap-2">
            <div className="min-w-0 flex-1 whitespace-pre-wrap wrap-anywhere select-text">
              {title !== undefined && <p>{title}</p>}
              <p>{hint.error ?? hint.path ?? '正在解析完整路径…'}</p>
            </div>
            <Button variant="ghost" size="icon-sm" aria-label={copied ? '已复制路径' : '复制完整路径'} disabled={hint.path === null} onClick={() => void copy()}>{copied ? <IconCheck /> : <IconCopy />}</Button>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
    <FileActionErrorDialog file={target} error={error} onClose={() => setError(null)} />
  </>
}
