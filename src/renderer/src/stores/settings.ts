/**
 * 设置页选中分区与搜索导航状态（zustand，跨区域共享）：
 *   - section：当前详情分区
 *   - query / viewMode：搜索词与内容区视图（'results' | 'detail'）
 *   - locateRequest：带单调轮次 token 的配置项定位请求（防止旧异步完成抢焦点）
 *   - navToken / navReason：精确表达滚动意图，避免切页回顶与搜索定位互相覆盖
 * 分区注册表与搜索目录在 features/settings/ —— store 只持 id 与纯导航状态，
 * 不反向依赖 features。
 */
import { create } from 'zustand'

export type SettingsSectionId =
  | 'general'
  | 'appearance'
  | 'notifications'
  | 'models'
  | 'browser'
  | 'computer-control'
  | 'shortcuts'
  | 'archived-chats'
  | 'storage'
  | 'plugins'
  | 'connections'
  | 'skills'
  | 'commands'
  | 'hooks'

export type SettingsViewMode = 'detail' | 'results'

export type SettingsNavReason =
  | 'init'
  | 'section'
  | 'search-results'
  | 'search-browse'
  | 'locate'
  | 'clear-in-detail'

export interface SettingsLocateRequest {
  /** 单调递增轮次，区分重复打开同一项及防止旧异步请求覆盖新目标 */
  token: number
  section: SettingsSectionId
  itemId: string
  scope?: 'user'
  /** 是否已完成首次滚动与聚焦（已消费后普通重渲染不再拉回） */
  consumed: boolean
}

interface SettingsState {
  section: SettingsSectionId
  query: string
  viewMode: SettingsViewMode
  locateRequest: SettingsLocateRequest | null
  navToken: number
  navReason: SettingsNavReason
  /** 外部/常规切页：退出旧搜索并清空定位，回到完整页面顶部 */
  setSection: (id: SettingsSectionId) => void
  /** 更新搜索词：非空进入结果页，清空时保留当前详情（若在详情中不额外回顶） */
  setQuery: (query: string) => void
  /** 搜索态下点击左侧导航项：保留搜索词浏览完整设置页顶部 */
  browseSectionFromSearch: (id: SettingsSectionId) => void
  /** 点击搜索结果「打开」：保留搜索词，进入所属页（配置项带定位请求） */
  openSearchResult: (target: {
    section: SettingsSectionId
    itemId?: string
    scope?: 'user'
  }) => void
  /** 从搜索进入的详情页返回搜索结果 */
  backToResults: () => void
  /** 标记指定轮次的定位请求已消费（滚动与聚焦完成） */
  consumeLocate: (token: number) => void
  /** 清除当前定位/高亮（例如高亮淡出、手动切换作用域） */
  clearLocate: (token?: number) => void
}

let nextToken = 1

export const useSettingsStore = create<SettingsState>((set) => ({
  section: 'general',
  query: '',
  viewMode: 'detail',
  locateRequest: null,
  navToken: 0,
  navReason: 'init',

  setSection: (section) =>
    set((state) => ({
      section,
      query: '',
      viewMode: 'detail',
      locateRequest: null,
      navToken: state.navToken + 1,
      navReason: 'section',
    })),

  setQuery: (query) =>
    set((state) => {
      const trimmed = query.trim()
      if (trimmed === '') {
        const wasResults = state.viewMode === 'results'
        return {
          query,
          viewMode: 'detail',
          locateRequest: null,
          navToken: state.navToken + 1,
          navReason: wasResults ? 'search-browse' : 'clear-in-detail',
        }
      }
      return {
        query,
        viewMode: 'results',
        locateRequest: null,
        navToken: state.navToken + 1,
        navReason: 'search-results',
      }
    }),

  browseSectionFromSearch: (section) =>
    set((state) => ({
      section,
      viewMode: 'detail',
      locateRequest: null,
      navToken: state.navToken + 1,
      navReason: 'search-browse',
    })),

  openSearchResult: (target) =>
    set((state) => {
      if (target.itemId === undefined) {
        return {
          section: target.section,
          viewMode: 'detail',
          locateRequest: null,
          navToken: state.navToken + 1,
          navReason: 'search-browse',
        }
      }
      const token = nextToken++
      return {
        section: target.section,
        viewMode: 'detail',
        locateRequest: {
          token,
          section: target.section,
          itemId: target.itemId,
          scope: target.scope,
          consumed: false,
        },
        navToken: state.navToken + 1,
        navReason: 'locate',
      }
    }),

  backToResults: () =>
    set((state) => ({
      viewMode: state.query.trim() !== '' ? 'results' : 'detail',
      locateRequest: null,
      navToken: state.navToken + 1,
      navReason: 'search-results',
    })),

  consumeLocate: (token) =>
    set((state) => {
      if (state.locateRequest === null || state.locateRequest.token !== token || state.locateRequest.consumed) {
        return state
      }
      return {
        locateRequest: { ...state.locateRequest, consumed: true },
      }
    }),

  clearLocate: (token) =>
    set((state) => {
      if (state.locateRequest === null) return state
      if (token !== undefined && state.locateRequest.token !== token) return state
      return { locateRequest: null }
    }),
}))
