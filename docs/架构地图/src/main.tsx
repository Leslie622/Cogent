/** 自包含文档入口：仅读取本地明暗主题偏好，不连接主应用或 Electron 桥。 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './页面.css'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
