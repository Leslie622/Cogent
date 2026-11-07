/**
 * 应用入口（UI 重写期）：引擎接线（事件流 + 初始数据）+ 三块骨架。
 * 界面按 AGENTS.md「UI 设计方针」逐件重写，旧界面在 legacy/renderer 借鉴。
 */
import { useEffect } from 'react'
import { useEngineStore } from '@/stores/engine'
import { bindEngineEvents, useChatStore } from '@/stores/chat'
import { AppShell } from '@/features/shell/AppShell'

export default function App() {
  useEffect(() => {
    // 事件订阅先行（避免 load 期间漏事件），再拉初始数据
    const unbind = bindEngineEvents()
    void useEngineStore.getState().load()
    void useChatStore.getState().load()
    return unbind
  }, [])

  return <AppShell />
}
