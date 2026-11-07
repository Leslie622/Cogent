/**
 * 应用壳：全局自绘标题栏 + 按 uiStore.view 切换聊天页 / 设置页。
 * 挂载时：接引擎事件流 + 拉模型目录/key 状态 + 载入会话。
 */
import { useEffect } from 'react'
import { useUiStore } from '@/stores/ui'
import { useEngineStore } from '@/stores/engine'
import { bindEngineEvents, useChatStore } from '@/stores/chat'
import { TitleBar } from '@/features/shell/TitleBar'
import { ChatPage } from '@/features/chat/ChatPage'
import { SettingsPage } from '@/features/settings/SettingsPage'

export default function App() {
  const view = useUiStore((s) => s.view)

  useEffect(() => {
    // 事件订阅先行（避免 load 期间漏事件），再拉初始数据
    const unbind = bindEngineEvents()
    void useEngineStore.getState().load()
    void useChatStore.getState().load()
    return unbind
  }, [])

  return (
    <div className="flex h-screen flex-col">
      <TitleBar />
      <div className="min-h-0 flex-1">{view === 'chat' ? <ChatPage /> : <SettingsPage />}</div>
    </div>
  )
}
