/** 启动呈现层：页面在遮罩后正常初始化，等待就绪和最短展示时间后统一淡出。 */
import { useEffect, useState, type ReactNode } from 'react'
import { Spinner } from '@/components/ui/spinner'

export function StartupOverlay({ loading, children }: { loading: boolean; children: ReactNode }) {
  const [minimumElapsed, setMinimumElapsed] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const fading = minimumElapsed && !loading

  useEffect(() => {
    const timer = window.setTimeout(() => setMinimumElapsed(true), 2000)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!fading) return
    // 与遮罩的 opacity 过渡同长，淡出结束前仍拦住鼠标与键盘。
    const timer = window.setTimeout(() => setDismissed(true), 300)
    return () => window.clearTimeout(timer)
  }, [fading])

  return (
    <>
      <div inert={!dismissed} aria-hidden={!dismissed}>
        {children}
      </div>
      {!dismissed && (
        <div
          data-slot="startup-overlay"
          data-state={fading ? 'fading' : 'loading'}
          className="fixed inset-0 z-100 flex items-center justify-center bg-background text-foreground transition-opacity duration-300 ease-out data-[state=fading]:opacity-0"
        >
          <Spinner aria-label="正在初始化引擎" />
        </div>
      )}
    </>
  )
}
