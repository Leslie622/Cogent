/** 浏览器几何回归：真实滚动壳与消息组件；jsdom 不提供实际裁切、槽宽或换行证据。 */
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { HomeChat } from '@/features/home/HomeChat'
import { emptyBucket, useChatStore } from '@/stores/chat'
import { useHomeStore } from '@/stores/home'
import { useEngineStore } from '@/stores/engine'
import '@/globals.css'

declare global { interface Window { chatLayoutResult?: { passed: boolean; results?: unknown[]; error?: string } } }

const messages = [
  { id: 'u1', role: 'user' as const, timestamp: 1, content: '先写一首关于秋天的短诗，写完后读一下 package.json，告诉我版本号。'.repeat(3) },
  { id: 'a1', role: 'assistant' as const, timestamp: 2, content: '## 窄面板换行\n\n' + '这是一段较长的正文，检查缩窄后末字是否完整可见。'.repeat(40) },
  { id: 'u2', role: 'user' as const, timestamp: 3, content: '你好' },
  { id: 'a2', role: 'assistant' as const, timestamp: 4, content: '你好！继续之前的节奏（写诗 + 读取 package.json）也行，或者聊点正事——比如 Cogent / Themd 项目里的活儿，随时说。' },
]

// 全部数据只驻留此页面内存；不挂 App 的桥接加载，不读写真实会话或密钥。
const sessionId = 'layout-fixture'
useHomeStore.setState({ session: { kind: 'chat', chatId: sessionId } })
useChatStore.setState({
  activeSessionId: sessionId,
  sessions: [{ id: sessionId, title: '窄面板回归', createdAt: 0, updatedAt: 0, planEnabled: true }],
  bySession: { [sessionId]: { ...emptyBucket(), messages: messages.map((message) => message.id === 'a2'
    ? { ...message, usage: { input: 40_000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 40_100 } }
    : message) } },
})
useEngineStore.setState({
  models: [{ id: 'deepseek-model-with-a-long-name-for-layout-testing', name: '测试模型', provider: 'deepseek', reasoning: false, thinkingLevels: ['off'], contextWindow: 128_000, maxTokens: 8192 }],
  keyConfigured: { deepseek: true }, activeProviderId: 'deepseek', activeModelId: 'deepseek-model-with-a-long-name-for-layout-testing',
})

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
// 下一次 rAF 仍在本帧布局/RO 之前；跨两帧再检查观察者更新后的真实定位。
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function App() {
  const root = useRef<HTMLDivElement>(null)
  const [report, setReport] = useState('正在测量…')
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const chat = root.current!
      const viewport = chat.querySelector<HTMLElement>('[data-slot=message-scroller-viewport]')!
      const body = chat.querySelector<HTMLElement>('[data-slot=message-scroller-content]')!
      const input = chat.querySelector<HTMLElement>('.chat-composer-column')!
      const index = chat.querySelector<HTMLElement>('.conversation-index')!
      const results = []
      // 重复缩窄/放宽，覆盖已有长消息重新换行，不只检查空容器首次布局。
      for (const width of [1100, 761, 760, 641, 640, 480, 340, 280, 240, 896, 340]) {
        document.documentElement.dataset.chatLayoutStage = `静态布局 ${width}px`
        chat.style.width = `${width}px`
        await frame()
        await delay(240)
        await Promise.allSettled(index.getAnimations().map((animation) => animation.finished))
        await frame()
        if (cancelled) return
        const c = chat.getBoundingClientRect(), b = body.getBoundingClientRect(), i = input.getBoundingClientRect()
        assert(b.left - c.left >= 27.9 && c.right - b.right >= 27.9, `${width}px 正文留白不足`)
        assert(i.left - c.left >= 21.9 && c.right - i.right >= 21.9, `${width}px 输入框留白不足`)
        const outset = b.left - i.left
        assert(outset >= 5.9 && outset <= 20.1 && Math.abs(i.right - b.right - outset) < .1, `${width}px 外扩不对称`)
        if (width >= 640) assert(Math.abs(outset - 20) < .1, `${width}px 宽屏未外扩20px`)
        assert(viewport.scrollWidth <= viewport.clientWidth + 1, `${width}px 视口横向溢出`)
        const v = viewport.getBoundingClientRect()
        assert(b.left >= v.left + viewport.clientLeft + 14, `${width}px 正文贴近左槽`)
        assert(b.right <= v.left + viewport.clientLeft + viewport.clientWidth - 14, `${width}px 正文贴近右槽`)
        for (const node of chat.querySelectorAll<HTMLElement>('[data-slot=bubble-content], .md-body p, [data-slot=message-footer]')) {
          const rect = node.getBoundingClientRect()
          assert(rect.left >= b.left - .1 && rect.right <= b.right + .1, `${width}px 消息右缘越界`)
          assert(node.scrollWidth <= node.clientWidth + 1, `${width}px 消息内部横向溢出`)
        }
        assert(parseFloat(getComputedStyle(index).width) === (width > 760 ? 24 : 0), `${width}px 索引边界错误`)
        const toolbar = chat.querySelector<HTMLElement>('.composer-toolbar')!
        assert(toolbar.scrollWidth <= toolbar.clientWidth + 1, `${width}px 工具行横向溢出`)
        const controls = [...toolbar.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.getClientRects().length > 0)
        for (const button of controls) {
          const rect = button.getBoundingClientRect()
          assert(rect.left >= i.left && rect.right <= i.right, `${width}px 按钮越出输入框：${button.ariaLabel}`)
        }
        const visible = (node: Element) => getComputedStyle(node).display !== 'none'
        assert(visible(toolbar.querySelector('.composer-context-trigger')!), `${width}px 上下文按钮不可见`)
        assert(visible(toolbar.querySelector('.context-ring')!) === (width <= 640), `${width}px 上下文圆环切换错误`)
        assert(visible(toolbar.querySelector('.context-wide')!) === (width > 640), `${width}px 上下文数值切换错误`)
        for (const label of toolbar.querySelectorAll('.composer-label,.composer-chevron')) {
          assert(visible(label) === (width > 640), `${width}px 文字/箭头切换错误`)
        }
        results.push({ width, bodyMargin: b.left - c.left, inputMargin: i.left - c.left, outset, toolbarWidth: toolbar.clientWidth })
      }
      const updateRuntime = (running: boolean, stopping = false) => useChatStore.setState((state) => ({
        bySession: { ...state.bySession, [sessionId]: {
          ...state.bySession[sessionId]!, runtime: { ...emptyBucket().runtime, running, stopping },
        } },
      }))
      const workingRow = () => chat.querySelector<HTMLElement>('[data-slot=message-scroller-pinned-row]')
      const assertVisible = (row: HTMLElement, stage: string) => {
        const r = row.getBoundingClientRect(), v = viewport.getBoundingClientRect()
        assert(r.height > 0 && r.top >= v.top && r.bottom <= v.bottom && r.left >= v.left && r.right <= v.right,
          `工作行越出真实视口：${JSON.stringify({ stage, row: { top: r.top, bottom: r.bottom, left: r.left, right: r.right }, viewport: { top: v.top, bottom: v.bottom, left: v.left, right: v.right }, style: row.getAttribute('style') })}`)
        assert(row.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)), '工作行虽在视口内却被裁切或遮挡')
      }
      updateRuntime(true)
      // 不同面板起点同时覆盖顶部工具栏、左侧栏和分数 CSS 像素；仅在原点检查会漏掉 fixed 坐标系错配。
      for (const [width, left, top] of [[896, 180, 40], [640, 50.5, 16.5], [340, 220, 0], [280, 24, 24]]) {
        document.documentElement.dataset.chatLayoutStage = `工作行 ${width}px`
        chat.style.width = `${width}px`
        chat.style.marginLeft = `${left}px`
        chat.style.marginTop = `${top}px`
        await delay(120)
        await frame()
        const row = workingRow()!
        assert(row.style.position === 'fixed', `${width}px 长内容没有进入跟随定位`)
        assertVisible(row, `${width}px 初始`)
        const beforeClock = row.textContent
        await delay(180)
        assert(row.textContent !== beforeClock, '可见工作行的计时器未更新')
        useChatStore.setState((state) => ({ bySession: { ...state.bySession, [sessionId]: {
          ...state.bySession[sessionId]!, messages: state.bySession[sessionId]!.messages.map((message) =>
            message.type === undefined && message.id === 'a2' ? { ...message, content: message.content + '\n\n继续增长的正文。'.repeat(8) } : message),
        } } }))
        await delay(120)
        assert(workingRow() === row, '内容增长重挂工作行')
        assertVisible(row, `${width}px 增长`)
        viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }))
        assert(row.style.position === '', '阅读意图没有同步归流')
        // 合成 wheel 不执行原生滚动，补上真实位移才能验证离底后的回底按钮。
        viewport.scrollTop -= 100
        viewport.dispatchEvent(new Event('scroll'))
        // 库按钮仅在 active 提交后接收点击；同栈点尚为 inert 的按钮不代表用户回底。
        await frame()
        const returnButton = chat.querySelector<HTMLButtonElement>('[data-slot=message-scroller-button]')!
        assert(!returnButton.inert, '离底后回底按钮未就绪')
        returnButton.click()
        await frame()
        await delay(120)
        assert(workingRow() === row && row.style.position === 'fixed', '显式回底时工作行丢失或重挂')
        assertVisible(row, `${width}px 回底`)
        results.push({ width, left, top, workingLine: '可见、走时、增长与阅读切换通过' })
      }
      updateRuntime(true, true)
      document.documentElement.dataset.chatLayoutStage = '停止与短回复'
      await frame()
      assert(workingRow()!.textContent.includes('正在停止'), '停止在途未显示工作状态')
      updateRuntime(false)
      await frame()
      assert(workingRow() === null, '终态残留工作行')
      chat.style.width = '896px'
      chat.style.height = '650px'
      useChatStore.setState((state) => ({ bySession: { ...state.bySession, [sessionId]: {
        ...emptyBucket(), messages: [messages[2], { ...messages[3], content: '短回复' }],
        runtime: { ...emptyBucket().runtime, running: true },
      } } }))
      await delay(120)
      const shortRow = workingRow()!
      assert(shortRow.style.position === '', '短内容不应固定到底部')
      assertVisible(shortRow, '短内容')
      results.push({ workingLine: '短内容随正文、停止在途与终态清理通过' })
      window.chatLayoutResult = { passed: true, results }
      setReport(`全部通过：真实 HomeChat 缩放与工作行可见性\n${JSON.stringify(results, null, 2)}`)
    }
    void run().catch((error: unknown) => {
      window.chatLayoutResult = { passed: false, error: String(error) }
      setReport(String(error))
    })
    return () => { cancelled = true }
  }, [])
  return <>
    <div className="flex gap-2">
      <button onClick={() => { root.current!.style.width = '1100px' }}>宽面板预览</button>
      <button onClick={() => useChatStore.setState((state) => ({ bySession: { ...state.bySession, [sessionId]: {
        ...state.bySession[sessionId]!, runtime: { ...emptyBucket().runtime, running: true },
      } } }))}>末轮生成中</button>
      <button onClick={() => useChatStore.setState((state) => ({ bySession: { ...state.bySession, [sessionId]: {
        ...state.bySession[sessionId]!, runtime: { ...emptyBucket().runtime }, turnOutcomes: { u2: 'completed' },
      } } }))}>末轮完成</button>
    </div>
    <pre id="layout-report" style={{ height: 180, overflow: 'auto' }}>{report}</pre>
    <div ref={root} style={{ width: 1100, height: 530 }}>
      <HomeChat tabsCollapsed onToggleTabs={() => {}} />
    </div>
  </>
}
createRoot(document.getElementById('root')!).render(<App />)
