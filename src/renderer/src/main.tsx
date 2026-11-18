import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ConsoleApp } from './features/console/ConsoleApp'
import { EmbeddedDemo } from './features/embedded/EmbeddedDemo'
import { isDarkMode, useAppearanceStore } from './stores/appearance'
import './globals.css'

// 窗口分流：控制台/内嵌 demo 是独立 BrowserWindow（ipc/console.ts、ipc/embedded.ts），
// 加载同一 bundle 但带 hash —— 在此分流到对应根组件，聊天 App 与引擎接线一概不挂
const hash = window.location.hash

// 外观初值同步（createRoot 前）：persist 同步 hydrate，此刻读即用户偏好；
// 深色晚挂会先渲染一段白底再翻转（闪白），换行门控顺手同挂
{
  const { colorMode, codeWrap } = useAppearanceStore.getState()
  if (isDarkMode(colorMode, window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark')
  }
  document.documentElement.toggleAttribute('data-code-wrap', codeWrap)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {hash === '#console' ? <ConsoleApp /> : hash === '#embedded' ? <EmbeddedDemo /> : <App />}
  </StrictMode>
)
