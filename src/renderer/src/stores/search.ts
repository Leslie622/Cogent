/** 搜索草稿与导航意图；异步加载只消费本次身份，不接管聊天消息或持久化真源。 */
import { create } from 'zustand'
import type { SearchHit, SearchResult } from '@shared/session-search'
import { useChatStore } from './chat'
import { useHomeStore } from './home'
import { useUiStore } from './ui'
import { unwrapIpcError } from '@/lib/ipc'

interface SearchNavigation {
  sessionId: string
  query: string
  hits: SearchHit[]
  index: number
  cursor?: string
}
interface SearchState {
  open: boolean
  navigation: SearchNavigation | null
  target: { sessionId: string; hit: SearchHit; serial: number } | null
  serial: number
  error: string | null
  busy: boolean
  setOpen: (open: boolean) => void
  select: (result: SearchResult, query: string, hit?: SearchHit) => Promise<void>
  move: (direction: -1 | 1) => Promise<void>
  clear: () => void
}
export const useSearchStore = create<SearchState>((set, get) => ({
  open: false, navigation: null, target: null, serial: 0, error: null, busy: false,
  setOpen: (open) => set((state) => ({ open, serial: state.serial + 1, busy: false, error: null })),
  clear: () => set((state) => ({ navigation: null, target: null, error: null, busy: false, serial: state.serial + 1 })),
  select: async (result, query, chosen) => {
    const serial = get().serial + 1
    const home = useHomeStore.getState().session
    set({ serial, busy: true, error: null, target: null })
    try {
      if (result.session.archivedAt !== undefined) await useChatStore.getState().archive(result.session.id, false)
      if (get().serial !== serial) return
      if (useHomeStore.getState().session !== home) { set({ busy: false }); return }
      useUiStore.getState().setView('home')
      useHomeStore.getState().openChat(result.session.id)
      const selectedHome = useHomeStore.getState().session
      set({ open: false })
      await useChatStore.getState().selectSession(result.session.id)
      if (get().serial !== serial) return
      if (useChatStore.getState().activeSessionId !== result.session.id || useHomeStore.getState().session !== selectedHome) { set({ busy: false }); return }
      const page = query.trim() === '' ? undefined : await window.cogent.engineRequest('session.search', { query, sessionId: result.session.id, limit: 100 })
      if (get().serial !== serial) return
      if (useChatStore.getState().activeSessionId !== result.session.id || useHomeStore.getState().session !== selectedHome) { set({ busy: false }); return }
      let hits = page?.items[0]?.hits ?? []
      let index = chosen === undefined ? 0 : hits.findIndex((hit) => hit.anchor.sourceId === chosen.anchor.sourceId && hit.anchor.offset === chosen.anchor.offset)
      // 从会话内后续页选择时，所选锚点未必位于聊天导航的首屏。
      if (chosen !== undefined && index === -1) { hits = [chosen, ...hits]; index = 0 }
      const hit = hits.at(index)
      set({ navigation: hit === undefined ? null : { sessionId: result.session.id, query, hits, index, cursor: page?.nextCursor },
        target: hit === undefined ? null : { sessionId: result.session.id, hit, serial }, busy: false })
    } catch (error) { if (get().serial === serial) set({ error: unwrapIpcError(error), busy: false }) }
  },
  move: async (direction) => {
    const navigation = get().navigation
    if (navigation === null || get().busy) return
    const serial = get().serial + 1
    set({ serial, busy: true, error: null })
    try {
      let hits = navigation.hits, cursor = navigation.cursor
      if (direction === 1 && navigation.index === hits.length - 1 && cursor !== undefined) {
        const page = await window.cogent.engineRequest('session.search', { query: navigation.query, sessionId: navigation.sessionId, limit: 100, cursor })
        hits = [...new Map([...hits, ...(page.items[0]?.hits ?? [])].map((hit) => [`${hit.anchor.sourceId}:${hit.anchor.offset}`, hit])).values()]; cursor = page.nextCursor
      }
      if (get().serial !== serial) return
      if (useChatStore.getState().activeSessionId !== navigation.sessionId) { set({ busy: false }); return }
      const index = (navigation.index + direction + hits.length) % hits.length
      set({ navigation: { ...navigation, hits, cursor, index }, target: { sessionId: navigation.sessionId, hit: hits[index], serial }, busy: false })
    } catch (error) { if (get().serial === serial) set({ error: unwrapIpcError(error), busy: false }) }
  }
}))
