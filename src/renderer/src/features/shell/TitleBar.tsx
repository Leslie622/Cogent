/**
 * 自绘窗口标题栏（无边框窗口的 header）：
 * 左侧拖拽区（-webkit-app-region: drag）+ 右侧窗口控制按钮（最小化/最大化/关闭）。
 * Windows 惯例按钮在右上角；按钮区必须 no-drag，否则点不到。
 */
import { useEffect, useState } from 'react'
import { MinusIcon, SquareIcon, XIcon, CopyIcon } from 'lucide-react'

export function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    // 订阅 main 推送的最大化状态（maximize/unmaximize 事件）
    return window.cogent.onWindowState(setIsMaximized)
  }, [])

  const buttonBase =
    'flex h-8 w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'

  return (
    <header className="flex h-8 shrink-0 select-none items-center justify-end border-b bg-background">
      {/* 拖拽区：占满按钮左侧全部空间；双击 = 切换最大化（系统拖拽区自带该行为） */}
      <div className="h-full flex-1" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />
      <div className="flex items-center" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button className={buttonBase} aria-label="最小化" onClick={() => void window.cogent.minimizeWindow()}>
          <MinusIcon size={14} />
        </button>
        <button
          className={buttonBase}
          aria-label={isMaximized ? '还原' : '最大化'}
          onClick={() => void window.cogent.toggleMaximizeWindow()}
        >
          {/* 最大化显示"两层方块"（还原），普通显示单方块 */}
          {isMaximized ? <CopyIcon size={12} /> : <SquareIcon size={12} />}
        </button>
        <button
          className={`${buttonBase} hover:bg-destructive hover:text-white`}
          aria-label="关闭"
          onClick={() => void window.cogent.closeWindow()}
        >
          <XIcon size={14} />
        </button>
      </div>
    </header>
  )
}
