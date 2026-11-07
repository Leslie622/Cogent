/**
 * 右栏：文档/文件预览占位（图1 右侧面板的架子）。
 * 将来放生成文档、代码 diff、附件预览；先留空态。
 */
import { Button } from '@/components/ui/button'
import { FileText } from 'lucide-react'
import { useUiStore } from '@/stores/ui'

export function DocPanel() {
  const setDocPanelOpen = useUiStore((s) => s.setDocPanelOpen)

  return (
    <div className="flex h-full flex-col border-l">
      <header className="flex h-12 shrink-0 items-center border-b px-3">
        <span className="text-sm font-medium">文档</span>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setDocPanelOpen(false)}>
          关闭
        </Button>
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
        <FileText size={28} />
        <p className="text-sm">暂无文档</p>
      </div>
    </div>
  )
}
