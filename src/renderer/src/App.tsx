/**
 * 应用入口（UI 重写期）：引擎接线（事件流 + 初始数据）+ 三块骨架。
 * 界面按 AGENTS.md「UI 设计方针」逐件重写，旧界面在 legacy/renderer 借鉴。
 *
 * 引擎失败可见性（2026-11-10，架构审查修复）：load 失败落各自 store 的
 * error 字段（engineError / loadError），此处横幅呈现 + 手动重试 —— 此前
 * 全是 void 裸调，引擎起不来时 UI 是一片无解释的空白。
 */
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useScrollbarAutoHide } from '@/hooks/use-scrollbar-auto-hide'
import { useEngineStore } from '@/stores/engine'
import { bindEngineEvents, useChatStore } from '@/stores/chat'
import { accentValue, isDarkMode, useAppearanceStore } from '@/stores/appearance'
import { AppShell } from '@/features/shell/AppShell'
import { CloseAskDialog } from '@/features/shell/CloseAskDialog'

/** 外观偏好 → DOM：html.dark（深浅色，system 档跟 OS 监听）、
    html[data-code-wrap]（代码换行门控）、--chrome-accent 覆盖（强调色
    亮/暗双值，随明暗同换）。挂载一次；首帧前的初值同步在 main.tsx
    （防深色闪白底）。 */
function useAppearanceDom() {
  const colorMode = useAppearanceStore((s) => s.colorMode)
  const codeWrap = useAppearanceStore((s) => s.codeWrap)
  const accent = useAppearanceStore((s) => s.accent)
  useEffect(() => {
    const root = document.documentElement
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    // apply 一体三职：明暗类 + 强调色（双值跟面换）；default 档清覆盖回落品牌蓝
    const apply = () => {
      const dark = isDarkMode(colorMode, mq.matches)
      root.classList.toggle('dark', dark)
      const value = accentValue(accent, dark)
      if (value !== null) root.style.setProperty('--chrome-accent', value)
      else root.style.removeProperty('--chrome-accent')
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [colorMode, accent])
  useEffect(() => {
    document.documentElement.toggleAttribute('data-code-wrap', codeWrap)
  }, [codeWrap])
}

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
      <div className="text-[13px] leading-5">
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
          void useEngineStore.getState().load()
          void useChatStore.getState().load()
        }}
      >
        重试
      </Button>
    </div>
  )
}

export default function App() {
  // 滚动条「不滚动即隐藏」的全局行为，挂载一次（样式侧见 globals.css）
  useScrollbarAutoHide()
  // 外观偏好的 DOM 落点（html.dark / data-code-wrap）
  useAppearanceDom()
  useEffect(() => {
    // 事件订阅先行（避免 load 期间漏事件），再拉初始数据
    // （load 内部已把失败落 error 状态，void 不产生 unhandled rejection）
    const unbind = bindEngineEvents()
    void useEngineStore.getState().load()
    void useChatStore.getState().load()
    return unbind
  }, [])

  return (
    <>
      <AppShell />
      <EngineFailureBanner />
      {/* 「关闭窗口时」询问（ask 档）：main close 拦截器点火，全局挂一份 */}
      <CloseAskDialog />
    </>
  )
}
