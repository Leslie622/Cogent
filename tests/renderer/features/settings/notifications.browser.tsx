/**
 * 通知分区 · 浏览器验收面（真渲染自查）：mock window.cogent 桥（platform
 * 判定/文件动作），engine store 用内存默认 notify（不 load 引擎）。
 * 跑法：npx vite --config tests/browser-harness.config.ts，开
 * http://localhost:5199/features/settings/notifications.browser.html
 */
import { createRoot } from 'react-dom/client'
import { Component, type ReactNode } from 'react'
import { NotificationsSection } from '@/features/settings/NotificationsSection'
import '@/globals.css'

// 桥接 stub（浏览器无 preload）：动作方法为 no-op，platform 按 Windows
window.cogent = {
  platform: 'win32',
  pickSoundFile: () => Promise.resolve(null),
  clearSoundFile: () => Promise.resolve({ ok: true }),
  openNotificationSettings: () => Promise.resolve(),
  notifyToast: () => Promise.resolve({ ok: true })
} as unknown as typeof window.cogent

/** 验收面专用：把渲染错误打到页面上（定位真浏览器才触发的崩溃） */
class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (this.state.error !== null) {
      return <pre className="p-4 text-xs text-red-600">{String(this.state.error.stack)}</pre>
    }
    return this.props.children
  }
}

createRoot(document.getElementById('root')!).render(
  <Boundary>
    <div className="h-screen overflow-y-auto">
      <NotificationsSection />
    </div>
  </Boundary>
)
