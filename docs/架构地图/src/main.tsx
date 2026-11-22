/** 仅初始化文档与共享外观，不加载 Electron 桥、主应用或聊天 store。 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { bindAppearanceDom } from '@/lib/appearance-dom'
import './页面.css'
import { App } from './App'

const unbind = bindAppearanceDom()
if (import.meta.hot) import.meta.hot.dispose(unbind)
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
