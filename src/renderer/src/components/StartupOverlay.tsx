/** 启动呈现层：优先接管 index.html 首帧静态遮罩，保底极短防闪烁缓冲后统一淡出。 */
import { useEffect, useState, type ReactNode } from 'react'
import { Spinner } from '@/components/ui/spinner'

/** 极短防闪烁缓冲（ms）：暖启动不闪屏，冷启动就绪即淡出不额外拖延。 */
export const STARTUP_MIN_DURATION_MS = 250
export const STARTUP_FADE_DURATION_MS = 300

function readStartupShell(): HTMLElement | null {
  const element = document.getElementById('startup-shell')
  return element !== null && !document.documentElement.hasAttribute('data-cogent-skip-startup')
    ? element
    : null
}

function remainingMinimumMs(shell: HTMLElement | null): number {
  const shownAt = Number(shell?.dataset.shownAt)
  if (!Number.isFinite(shownAt)) return STARTUP_MIN_DURATION_MS
  return Math.max(0, STARTUP_MIN_DURATION_MS - Math.max(0, performance.now() - shownAt))
}

export function StartupOverlay({ loading, children }: { loading: boolean; children: ReactNode }) {
  const [hasStaticShell] = useState(() => readStartupShell() !== null)
  const [minimumElapsed, setMinimumElapsed] = useState(() => remainingMinimumMs(readStartupShell()) === 0)
  const [dismissed, setDismissed] = useState(false)
  const fading = minimumElapsed && !loading

  useEffect(() => {
    if (minimumElapsed) return
    const remaining = remainingMinimumMs(readStartupShell())
    const timer = window.setTimeout(() => setMinimumElapsed(true), remaining)
    return () => window.clearTimeout(timer)
  }, [minimumElapsed])

  useEffect(() => {
    const shell = readStartupShell()
    if (shell !== null) {
      shell.dataset.state = fading ? 'fading' : 'loading'
      shell.setAttribute('aria-busy', fading ? 'false' : 'true')
    }
    if (!fading) return
    // 与遮罩的 opacity 过渡同长，淡出结束前仍拦住鼠标与键盘。
    const timer = window.setTimeout(() => {
      readStartupShell()?.remove()
      setDismissed(true)
    }, STARTUP_FADE_DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [fading])

  return (
    <>
      <div inert={!dismissed} aria-hidden={!dismissed}>
        {children}
      </div>
      {!hasStaticShell && !dismissed && (
        <div
          data-slot="startup-overlay"
          data-state={fading ? 'fading' : 'loading'}
          className="fixed inset-0 z-100 flex items-center justify-center bg-background text-foreground [contain:strict] will-change-[opacity] transition-opacity duration-300 ease-out data-[state=fading]:opacity-0"
        >
          <div className="size-4 animate-spin will-change-transform">
            <Spinner aria-label="正在初始化引擎" className="animate-none" />
          </div>
        </div>
      )}
    </>
  )
}
