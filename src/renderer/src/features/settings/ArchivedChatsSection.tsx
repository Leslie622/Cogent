/**
 * 设置 · 已归档的聊天分区：归档视图（回收站）。数据源 = session.listArchived
 * （引擎按 archivedAt 倒序）；每行 恢复（回主列表）/ 删除（彻底删，转录文件
 * 一并清）。空态文案对齐主流产品（ChatGPT 同款口吻）。
 */
import { useCallback, useEffect, useState } from 'react'
import { IconArrowBackUp, IconTrash } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { SettingsGroup, SettingsRow } from './SettingsParts'
import { useChatStore } from '@/stores/chat'
import type { SessionSummary } from '@/env.d'

export function ArchivedChatsSection() {
  const [archived, setArchived] = useState<SessionSummary[]>([])
  const sessions = useChatStore((s) => s.sessions)

  // 初载拉归档列表；sessions 变化（恢复动作让会话回主列表）时顺势刷新视图
  const reload = useCallback(async () => {
    const list = await window.cogent.engineRequest('session.listArchived', {})
    setArchived(list)
  }, [])
  useEffect(() => {
    void reload()
  }, [reload, sessions.length])

  const restore = async (chatId: string) => {
    await useChatStore.getState().archive(chatId, false)
    setArchived((prev) => prev.filter((s) => s.id !== chatId))
  }

  const remove = async (chatId: string) => {
    await useChatStore.getState().deleteSession(chatId)
    setArchived((prev) => prev.filter((s) => s.id !== chatId))
  }

  return (
    <SettingsGroup label="已归档的聊天">
      {archived.length === 0 ? (
        <SettingsRow
          title="没有已归档的聊天"
          desc="归档的聊天会显示在此处。你可以在聊天操作中选择归档。"
        >
          <span />
        </SettingsRow>
      ) : (
        archived.map((chat) => (
          <SettingsRow
            key={chat.id}
            title={chat.title}
            desc={`归档于 ${new Date(chat.archivedAt ?? chat.updatedAt).toLocaleDateString()}`}
          >
            {/* 右侧双钮自排（SettingsRow 的 children 容器只包一层，此处自组行内 flex） */}
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="xs"
                className="h-7 gap-1 rounded-lg px-2.5 text-[13px] hover:bg-secondary/80"
                aria-label={`恢复 ${chat.title}`}
                onClick={() => void restore(chat.id)}
              >
                <IconArrowBackUp className="size-3.5" />
                恢复
              </Button>
              <Button
                variant="secondary"
                size="xs"
                className="h-7 gap-1 rounded-lg px-2.5 text-[13px] text-destructive hover:bg-destructive/10"
                aria-label={`删除 ${chat.title}`}
                onClick={() => void remove(chat.id)}
              >
                <IconTrash className="size-3.5" />
                删除
              </Button>
            </div>
          </SettingsRow>
        ))
      )}
    </SettingsGroup>
  )
}
