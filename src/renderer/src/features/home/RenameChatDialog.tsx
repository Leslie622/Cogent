/** 聊天重命名表单：草稿归弹窗，持久化由 chat store 发起；失败保留输入供重试。 */
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useChatStore, type SessionSummary } from '@/stores/chat'
import { unwrapIpcError } from '@/lib/ipc'

export function RenameChatDialog({ chat, onClose }: { chat: SessionSummary; onClose: () => void }) {
  const [title, setTitle] = useState(chat.title)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rename = useChatStore((s) => s.rename)
  const canSave = title.trim().length > 0 && title.trim() !== chat.title && !saving

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    // 表单的 Enter 提交同样遵守空值、未改动和在途禁用规则。
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      await rename(chat.id, title.trim())
      onClose()
    } catch (cause) {
      // IPC / 磁盘保存属于外部边界，错误留在表单，不能关窗伪装保存成功。
      setError(unwrapIpcError(cause))
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose() }}>
      <DialogContent showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>重命名聊天</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => { void submit(event) }}>
          <Input
            aria-label="聊天名称"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onFocus={(event) => event.target.select()}
            autoFocus
            disabled={saving}
          />
          {error !== null && <p role="alert" className="text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>取消</Button>
            <Button type="submit" disabled={!canSave}>{saving ? '保存中…' : '保存'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
