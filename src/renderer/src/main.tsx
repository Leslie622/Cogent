import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ConsoleApp } from './features/console/ConsoleApp'
import './globals.css'

// 窗口分流：控制台是独立 BrowserWindow（ipc/console.ts），加载同一 bundle 但带
// hash '#console' —— 在此分流到控制台根组件，聊天 App 与引擎接线一概不挂
const isConsoleWindow = window.location.hash === '#console'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isConsoleWindow ? <ConsoleApp /> : <App />}
  </StrictMode>
)
