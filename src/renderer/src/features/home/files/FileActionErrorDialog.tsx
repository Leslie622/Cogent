/** 文件动作失败统一在独立弹窗反馈，避免错误挤进正文链接或历史卡片。 */
import { AlertDialog, AlertDialogAction, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'

export function FileActionErrorDialog({ file, error, onClose }: { file: string; error: string | null; onClose: () => void }) {
  return <AlertDialog open={error !== null} onOpenChange={(open) => { if (!open) onClose() }}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>文件操作失败</AlertDialogTitle>
        <AlertDialogDescription className="max-h-64 overflow-y-auto whitespace-pre-wrap wrap-anywhere">{file}：{error}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter><AlertDialogAction onClick={onClose}>知道了</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
}
