import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ConsoleApp } from './features/console/ConsoleApp'
import { EmbeddedDemo } from './features/embedded/EmbeddedDemo'
import { bindAppearanceDom } from './lib/appearance-dom'
import './globals.css'

// 窗口分流：控制台/内嵌 demo 是独立 BrowserWindow（ipc/console.ts、ipc/embedded.ts），
// 加载同一 bundle 但带 hash —— 在此分流到对应根组件，聊天 App 与引擎接线一概不挂
const hash = window.location.hash

const unbindAppearance = bindAppearanceDom()
if (import.meta.hot) import.meta.hot.dispose(unbindAppearance)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {hash === '#console' ? <ConsoleApp /> : hash === '#embedded' ? <EmbeddedDemo /> : <App />}
  </StrictMode>
)
