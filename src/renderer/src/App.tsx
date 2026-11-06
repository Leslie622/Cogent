/**
 * 应用壳：全局自绘标题栏 + 按 uiStore.view 切换聊天页 / 设置页。
 */
import { useUiStore } from '@/stores/ui'
import { TitleBar } from '@/features/shell/TitleBar'
import { ChatPage } from '@/features/chat/ChatPage'
import { SettingsPage } from '@/features/settings/SettingsPage'

export default function App() {
  const view = useUiStore((s) => s.view)
  return (
    <div className="flex h-screen flex-col">
      <TitleBar />
      <div className="min-h-0 flex-1">{view === 'chat' ? <ChatPage /> : <SettingsPage />}</div>
    </div>
  )
}
