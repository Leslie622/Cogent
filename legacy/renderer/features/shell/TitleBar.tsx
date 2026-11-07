/**
 * 自绘窗口标题栏（无边框窗口的 header，v0 稿样式）：
 * 薄荷绿底（bg-sidebar）与下方侧栏连成一体；左侧拖拽区含装饰性菜单文案
 * （文件/编辑/视图/帮助 —— 菜单本体属路线空位，先按稿占位）；右侧真实窗口控制。
 * 高度 48px（h-12）与 ChatPage 里 ChatSidebar 的 top-12 / calc(100vh-3rem) 耦合，改高需同步。
 */
import { useEffect, useState } from 'react'
import { MinusIcon, SquareIcon, XIcon, CopyIcon } from 'lucide-react'

export function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    // 订阅 main 推送的最大化状态（maximize/unmaximize 事件）
    return window.cogent.onWindowState(setIsMaximized)
  }, [])

  // v0 稿的圆角小按钮样式（不再是通栏热区）；关闭保留 Windows 惯例的红色 hover
  const buttonBase =
    'flex h-9 w-9 items-center justify-center rounded-md text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'

  return (
    <header className="flex h-12 shrink-0 select-none items-center justify-end bg-sidebar">
      {/* 拖拽区：占满按钮左侧全部空间；双击 = 切换最大化（系统拖拽区自带该行为）。
          装饰菜单文案随稿保留：纯文本、不可交互，接菜单时再改为 no-drag 按钮 */}
      <div
        className="flex h-full flex-1 items-center px-4"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <nav className="flex items-center gap-7 text-[15px] tracking-tight text-sidebar-foreground">
          <span>文件</span>
          <span>编辑</span>
          <span>视图</span>
          <span>帮助</span>
        </nav>
      </div>
      <div className="flex items-center" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button className={buttonBase} aria-label="最小化" onClick={() => void window.cogent.minimizeWindow()}>
          <MinusIcon size={16} />
        </button>
        <button
          className={buttonBase}
          aria-label={isMaximized ? '还原' : '最大化'}
          onClick={() => void window.cogent.toggleMaximizeWindow()}
        >
          {/* 最大化显示"两层方块"（还原），普通显示单方块 */}
          {isMaximized ? <CopyIcon size={13} /> : <SquareIcon size={13} />}
        </button>
        <button
          className={`${buttonBase} hover:bg-destructive hover:text-white`}
          aria-label="关闭"
          onClick={() => void window.cogent.closeWindow()}
        >
          <XIcon size={16} />
        </button>
      </div>
    </header>
  )
}
