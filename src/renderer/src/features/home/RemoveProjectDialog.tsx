/** 项目移除确认：界面持有在途与错误状态，store 完成持久化后才通知成功。 */
import { useState } from 'react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import type { ProjectSummary } from '@/env.d'
import { unwrapIpcError } from '@/lib/ipc'
import { useProjectStore } from '@/stores/project'

export function RemoveProjectDialog({ project, onClose }: { project: ProjectSummary; onClose: () => void }) {
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remove = useProjectStore((s) => s.remove)

  const submit = async () => {
    setRemoving(true)
    setError(null)
    try {
      await remove(project.id)
      toast.success('项目已移除')
      onClose()
    } catch (cause) {
      // IPC / 磁盘失败保留确认现场，不能关窗或提前报成功。
      setError(unwrapIpcError(cause))
      setRemoving(false)
    }
  }

  return (
    <AlertDialog open onOpenChange={(open) => { if (!open && !removing) onClose() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>移除项目？</AlertDialogTitle>
          <AlertDialogDescription>
            确定要移除项目「{project.name}」吗？项目中的聊天和本地文件会保留。
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error !== null && <p role="alert" className="text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={removing}>取消</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={removing} onClick={() => { void submit() }}>
            {removing ? '移除中…' : '移除项目'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
