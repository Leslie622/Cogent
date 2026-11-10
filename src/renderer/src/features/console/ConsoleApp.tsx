/**
 * 控制台窗口根（#console hash 分流到这，见 main.tsx）：独立 BrowserWindow 的
 * 全部内容 —— 自绘 header（拖拽区 + 窗口控制，window 域 IPC 按"发起窗口"寻址，
 * 与主窗口共用）+ [会话侧栏 | 时间线/详情分栏] 主体。
 *
 * 数据自举：挂载即订阅 inspect.event（实时增量）+ load()（会话列表与初载条目）。
 * 控制台不参与聊天写路径（发消息仍在主窗口），纯观察者。
 */
import type { CSSProperties } from 'react'
import { useEffect, useState } from 'react'
import { IconCopy, IconMinus, IconSquare, IconTerminal2, IconX } from '@tabler/icons-react'
import { ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { GlowResizeHandle } from '@/components/GlowResizeHandle'
import { Button } from '@/components/ui/button'
import { bindConsoleEvents, useConsoleStore } from '@/stores/console'
import { ConsoleSidebar } from './ConsoleSidebar'
import { ConsoleTimeline } from './ConsoleTimeline'
import { ConsoleDetail } from './ConsoleDetail'

const NO_DRAG = { WebkitAppRegion: 'no-drag' } as CSSProperties
/** chrome 面上 ghost hover 覆盖（同主窗口 AppHeader 配方） */
const CHROME_HOVER = 'hover:bg-foreground/5 hover:text-foreground'

export function ConsoleApp() {
  const [maximized, setMaximized] = useState(false)

  // 事件订阅先行（避免 load 期间漏条目），再拉初始数据
  useEffect(() => {
    const unbind = bindConsoleEvents()
    void useConsoleStore.getState().load()
    return unbind
  }, [])

  useEffect(() => window.cogent.onWindowState(setMaximized), [])

  const sessions = useConsoleStore((s) => s.sessions)
  const sessionId = useConsoleStore((s) => s.sessionId)
  const active = sessions.find((s) => s.id === sessionId)

  return (
    // select-text：整窗放开文本选中（body 默认 user-select:none 防拖窗蓝选）——
    // 控制台是学习/排障内容，标题、概览、错误文案都要能随手复制（AGENTS.md 方针 5 的容器级放开）
    <div className="flex h-screen select-text flex-col bg-background text-foreground">
      <header
        className="flex h-10 shrink-0 items-center pl-4 text-muted-foreground"
        style={{ WebkitAppRegion: 'drag' } as CSSProperties}
      >
        <div className="flex items-center gap-2">
          <IconTerminal2 className="size-[18px]" />
          <span className="text-[13px]">运行时控制台</span>
          {active !== undefined && (
            <span className="text-[13px] text-muted-foreground">· {active.title}</span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-0.5 pr-2" style={NO_DRAG}>
          <Button
            variant="ghost"
            size="icon-sm"
            className={CHROME_HOVER}
            aria-label="最小化"
            onClick={() => void window.cogent.minimizeWindow()}
          >
            <IconMinus />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className={CHROME_HOVER}
            aria-label={maximized ? '还原' : '最大化'}
            onClick={() => void window.cogent.toggleMaximizeWindow()}
          >
            {maximized ? <IconCopy className="size-[14px]" /> : <IconSquare className="size-[14px]" />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="hover:bg-destructive hover:text-white"
            aria-label="关闭"
            onClick={() => void window.cogent.closeWindow()}
          >
            <IconX />
          </Button>
        </div>
      </header>

      {/* 主体：会话侧栏 + [时间线 | 详情]（两组可拖分栏，同首页标签页区手法） */}
      <div className="min-h-0 flex-1">
        <ResizablePanelGroup orientation="horizontal" className="h-full">
          <ResizablePanel defaultSize="240px" minSize="200px" maxSize="340px" className="bg-muted/40">
            <ConsoleSidebar />
          </ResizablePanel>
          <GlowResizeHandle />
          <ResizablePanel>
            <ConsoleTimeline />
          </ResizablePanel>
          <GlowResizeHandle withHandle />
          <ResizablePanel defaultSize="440px" minSize="320px" maxSize="720px">
            <ConsoleDetail />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  )
}
