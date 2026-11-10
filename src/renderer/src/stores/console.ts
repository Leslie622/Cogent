/**
 * 控制台数据状态：观测条目（inspect 域）的会话选择、实时追加、详情拉取。
 * 与 chat store 同构（事件 → store 缓冲 → UI），但消费的是 inspect.event
 * 而非聊天事件 —— 控制台是独立窗口（#console），事件由 main 广播两窗口各取所需。
 */
import { create } from 'zustand'
import type { InspectEntryDetail, InspectEntrySummary, SessionSummary } from '@/env.d'

/** 时间线的四层过滤开关键（解剖层次，见 kinds.ts 的 kind → layer 归并） */
export type ConsoleLayer = 'api' | 'engine' | 'tool' | 'session'

interface ConsoleState {
  sessions: SessionSummary[]
  sessionId: string | null
  /** 选中会话的观测条目（seq 升序；初载 inspect.entries + 实时 inspect.event 追加） */
  entries: InspectEntrySummary[]
  /** 详情缓存 seq → detail（时间线里点开过的条目，会话切换即清） */
  details: Partial<Record<number, InspectEntryDetail>>
  selectedSeq: number | null
  /** 选中条目详情拉取失败的原因（环形丢弃/引擎重启丢内存），选中切换即重置 */
  detailError: string | null
  layers: Record<ConsoleLayer, boolean>
  /** 实时跟随滚动（时间线新条目自动滚到底；翻阅历史时可关） */
  follow: boolean
  /** sessionId → 是否正在 run（run.started 置位、completed/failed 复位；侧栏呼吸点） */
  runningBySession: Partial<Record<string, boolean>>
  /** load 是否在途（去重用：主窗口新会话首跑的事件风暴会并发触发几十次 load） */
  loading: boolean
  /** 初载失败的原因（引擎不可用等；ConsoleApp 呈现）。null = 正常 */
  loadError: string | null

  load: () => Promise<void>
  selectSession: (sessionId: string) => Promise<void>
  /** inspect.event 落库：选中会话追加条目；别的会话只维护运行位（不打断正在看的） */
  applyEntry: (sessionId: string, entry: InspectEntrySummary) => void
  selectEntry: (seq: number) => Promise<void>
  toggleLayer: (layer: ConsoleLayer) => void
  setFollow: (follow: boolean) => void
}

export const useConsoleStore = create<ConsoleState>((set, get) => ({
  sessions: [],
  sessionId: null,
  entries: [],
  details: {},
  selectedSeq: null,
  detailError: null,
  layers: { api: true, engine: true, tool: true, session: true },
  follow: true,
  runningBySession: {},
  loading: false,
  loadError: null,

  load: async () => {
    // in-flight 去重：事件风暴下"未知会话"分支每条事件触发一次 load，幂等但
    // 每次都是一个 session.list 往返 —— 在途时直接跳过
    if (get().loading) return
    set({ loading: true })
    try {
      const sessions = await window.cogent.engineRequest('session.list', {})
      set({ sessions, loadError: null })
      // 默认选中最近活跃会话（updatedAt 倒序第一个）；空列表 = 主窗口还没有对话
      const latest = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).at(0)
      if (latest !== undefined && get().sessionId === null) {
        await get().selectSession(latest.id)
      }
    } catch (error) {
      set({ loadError: error instanceof Error ? error.message : String(error) })
    } finally {
      set({ loading: false })
    }
  },

  selectSession: async (sessionId) => {
    set({ sessionId, entries: [], details: {}, selectedSeq: null, detailError: null })
    const { entries } = await window.cogent.engineRequest('inspect.entries', { sessionId })
    // 异步竞态守卫：切换期间用户又选了别的会话，晚到的响应丢弃（真条件，非摆设）
    if (get().sessionId !== sessionId) return
    // 初载快照与实时事件赛跑：事件（webContents.send）可能先于响应（invoke 往返）
    // 到达并已 append —— 不能用较旧的快照整体覆盖，按 seq 单调性归并取并集
    set((state) => {
      if (state.entries.length === 0) return { entries }
      const lastSeq = state.entries[state.entries.length - 1].seq
      return { entries: [...state.entries, ...entries.filter((e) => e.seq > lastSeq)] }
    })
  },

  applyEntry: (sessionId, entry) => {
    const state = get()
    // 运行位任何会话都维护（侧栏呼吸点数据源）
    const running =
      entry.kind === 'run.started' ? true : entry.kind === 'run.completed' || entry.kind === 'run.failed' ? false : undefined
    const runningBySession =
      running === undefined ? state.runningBySession : { ...state.runningBySession, [sessionId]: running }

    if (sessionId !== state.sessionId) {
      set({ runningBySession })
      // 控制台开着时主窗口新建会话首跑：列表刷新让新会话出现（自动选中只在
      // 尚未选中任何会话时发生 —— 跟最新活动，但不打断正在看的会话）
      if (!state.sessions.some((s) => s.id === sessionId) || state.sessionId === null) {
        void get().load()
      }
      return
    }
    // 去重守卫：inspect.entries 初载与实时事件在边界处可能重叠（seq 单调可判）
    if (state.entries.length > 0 && entry.seq <= state.entries[state.entries.length - 1].seq) return
    set({ entries: [...state.entries, entry], runningBySession })
  },

  selectEntry: async (seq) => {
    set({ selectedSeq: seq, detailError: null })
    // 无详情条目（run.started/completed 这类概览即全部的）不发起拉取 —— 引擎侧
    // 该 seq 本就没存档，拉必报"不存在"（2026-11-10 用户报告的红字误报根因）
    const entry = get().entries.find((e) => e.seq === seq)
    if (entry === undefined || !entry.hasDetail) return
    const cached = get().details[seq]
    if (cached !== undefined) return
    const sessionId = get().sessionId
    if (sessionId === null) return
    try {
      const detail = await window.cogent.engineRequest('inspect.entry', { sessionId, seq })
      // 会话维度竞态守卫：拉取期间切换了会话，晚到详情丢弃 —— seq 是会话内
      // 单调编号，跨会话同 seq 是常态，入缓存会把旧会话的数据写给新会话
      if (get().sessionId !== sessionId) return
      set((state) => ({ details: { ...state.details, [seq]: detail } }))
    } catch (error) {
      // 本条的失败只归本条 —— 用户已点开别的条目/切换会话时不覆盖新选中态的展示
      if (get().selectedSeq !== seq || get().sessionId !== sessionId) return
      set({ detailError: error instanceof Error ? error.message : String(error) })
    }
  },

  toggleLayer: (layer) =>
    set((state) => ({ layers: { ...state.layers, [layer]: !state.layers[layer] } })),

  setFollow: (follow) => set({ follow })
}))

/**
 * 控制台的事件订阅：只认 inspect.event（聊天事件与本窗口无关，main 广播
 * 两窗口、各取所需）。ConsoleApp 挂载时接一次。
 */
export function bindConsoleEvents(): () => void {
  return window.cogent.onEngineEvent((event) => {
    if (event.method !== 'inspect.event') return
    useConsoleStore.getState().applyEntry(event.params.sessionId, event.params.entry)
  })
}
