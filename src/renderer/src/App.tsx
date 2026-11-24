/**
 * 主窗口入口：引擎事件与初始数据接线、全局启动遮罩和应用外壳。
 * load 失败由各自 store 记录，此处保留错误横幅与重试出口，避免遮罩无限等待。
 * 启动交接与呈现边界见 docs/模块/应用启动.md。
 */
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Toaster } from '@/components/ui/sonner'
import { StartupOverlay } from '@/components/StartupOverlay'
import { useErrorToast } from '@/hooks/use-error-toast'
import { useScrollbarAutoHide } from '@/hooks/use-scrollbar-auto-hide'
import { useEngineStore } from '@/stores/engine'
import { bindEngineEvents, useChatStore } from '@/stores/chat'
import { AppShell } from '@/features/shell/AppShell'
import { CloseAskDialog } from '@/features/shell/CloseAskDialog'

/** 引擎链路失败横幅：engine store 与 chat store 任一初载失败即出（同源：引擎不可用） */
function EngineFailureBanner() {
  const engineError = useEngineStore((s) => s.engineError)
  const chatError = useChatStore((s) => s.loadError)
  const failure = engineError ?? chatError
  // 诊断补充：宿主侧引擎状态（失败原因/Node 版本）。getStatus 此前在 renderer
  // 零消费（空挂的声明），现在随横幅接上 —— 只在失败时查一次
  const [statusDetail, setStatusDetail] = useState<string | null>(null)
  useEffect(() => {
    if (failure === null) return
    void window.cogent.getStatus().then(
      (status) => setStatusDetail(status.error !== null ? `${status.state}：${status.error}` : status.state),
      (error: unknown) => setStatusDetail(error instanceof Error ? error.message : String(error))
    )
  }, [failure])

  if (failure === null) return null
  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-destructive/30 bg-background px-4 py-2.5 shadow-lg">
      <div className="text-sm leading-normal">
        <p className="font-medium text-destructive">引擎服务不可用，对话与模型目录未加载</p>
        <p className="text-muted-foreground">
          {failure}
          {statusDetail !== null ? `（${statusDetail}）` : ''}
        </p>
      </div>
      <Button
        variant="outline"
        size="xs"
        onClick={() => {
          setStatusDetail(null)
          void (async () => {
            const status = await window.cogent.getStatus()
            if (status.state !== 'running') await window.cogent.restartHost()
            await Promise.all([useEngineStore.getState().load(), useChatStore.getState().load()])
            const id = useChatStore.getState().activeSessionId
            if (id) await useChatStore.getState().selectSession(id)
          })().catch(error => useEngineStore.setState({ engineError: String(error) }))
        }}
      >
        重试
      </Button>
    </div>
  )
}

export default function App() {
  const [startupPending, setStartupPending] = useState(true)
  // 滚动条「不滚动即隐藏」的全局行为，挂载一次（样式侧见 globals.css）
  useScrollbarAutoHide()
  // 会话错误 toast（对话区错误条退役，2026-11-20）：监听活动会话 lastError
  useErrorToast()
  useEffect(() => {
    // 事件订阅先行（避免 load 期间漏事件），再拉初始数据
    // （load 内部已把失败落 error 状态，void 不产生 unhandled rejection）
    const unbind = bindEngineEvents()
    let active = true
    // 等待完整 load（含配置/模型读取与首个会话历史），不把中途 loaded 标志当作完成。
    void Promise.all([
      useEngineStore.getState().load(),
      useChatStore.getState().load()
    ]).then(() => {
      if (active) setStartupPending(false)
    })
    return () => {
      // StrictMode 的上一轮初始化完成后，不能提前撤掉本轮的遮罩。
      active = false
      unbind()
    }
  }, [])

  return (
    <StartupOverlay loading={startupPending}>
      <AppShell />
      <EngineFailureBanner />
      {/* 「关闭窗口时」询问（ask 档）：main close 拦截器点火，全局挂一份 */}
      <CloseAskDialog />
      {/* 全局 toast 出口（sonner）：错误通知等，任意页面可见；
          顶部居中（2026-11-20 用户定调，跟 shadcn 文档 demo） */}
      <Toaster position="top-center" />
    </StartupOverlay>
  )
}
