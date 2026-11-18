/** iframe 提供真实窗口宽度；覆盖两侧自动折叠、手动意图恢复及 400px 工具栏。 */
import { createRoot } from 'react-dom/client'
import { AppShell } from '@/features/shell/AppShell'
import { emptyBucket, useChatStore } from '@/stores/chat'
import { useHomeStore } from '@/stores/home'
import { useEngineStore } from '@/stores/engine'
import { useProjectStore } from '@/stores/project'
import '@/globals.css'

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

async function run() {
  if (new URLSearchParams(location.search).has('frame')) {
    window.cogent = { onWindowState: () => () => {} } as unknown as typeof window.cogent
    useProjectStore.setState({ load: async () => {}, loaded: true })
    useHomeStore.setState({ session: { kind: 'chat', chatId: 'shell-fixture' } })
    useChatStore.setState({ activeSessionId: 'shell-fixture', sessions: [{ id: 'shell-fixture', title: '缩窗后保留对话', createdAt: 0, updatedAt: 0, planEnabled: true }], bySession: {
      'shell-fixture': { ...emptyBucket(), messages: [
        { id: 'u1', role: 'user', content: '你好', timestamp: 0 },
        { id: 'a1', role: 'assistant', content: '窗口缩小到 400px 后，对话和输入区仍然可用。', timestamp: 1, usage: { input: 40_000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 40_100 } },
      ] },
    } })
    useEngineStore.setState({
      models: [{ id: 'deepseek-flash', name: 'DeepSeek', provider: 'deepseek', reasoning: false, thinkingLevels: ['off'], contextWindow: 128_000, maxTokens: 8192 }],
      keyConfigured: { deepseek: true }, activeProviderId: 'deepseek', activeModelId: 'deepseek-flash',
    })
    createRoot(document.getElementById('root')!).render(<AppShell />)
    return
  }

  const report = document.createElement('pre')
  report.id = 'shell-layout-report'
  report.style.cssText = 'height:140px;overflow:auto'
  report.textContent = '正在验证真实 AppShell 缩窗…'
  const iframe = document.createElement('iframe')
  iframe.style.cssText = 'width:1240px;height:600px;border:0;display:block'
  iframe.src = `${location.pathname}?frame`
  document.getElementById('root')!.append(report, iframe)
  await new Promise<void>((resolve) => iframe.addEventListener('load', () => resolve(), { once: true }))
  await delay(1000)
  const doc = iframe.contentDocument!
  const button = (label: string) => doc.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
  const rect = (selector: string) => doc.querySelector<HTMLElement>(selector)!.getBoundingClientRect()
  const rows = []
  const settleLayout = async () => {
    await new Promise<void>((resolve) => iframe.contentWindow!.requestAnimationFrame(() => resolve()))
    await Promise.allSettled(doc.getAnimations().filter((animation) => animation.constructor.name === 'CSSTransition').map((animation) => animation.finished))
    await new Promise<void>((resolve) => iframe.contentWindow!.requestAnimationFrame(() => resolve()))
  }
  const waitForLayout = async (ready: () => boolean) => {
    const started = performance.now()
    while (!ready()) {
      assert(performance.now() - started < 8000, '等待分栏布局超时')
      await delay(50)
    }
  }
  try {
    button('展开标签页区').click()
    await waitForLayout(() => Math.abs(rect('[data-home-tabs]').width - 380) < 1)
    await settleLayout()
    assert(rect('[data-home-tabs]').width >= 280, '宽窗未展开右侧标签页区')
    const style = (selector: string) => iframe.contentWindow!.getComputedStyle(doc.querySelector(selector)!)
    assert(style('main').borderTopLeftRadius === '14px', '内容主体未使用项目 radius-xl')
    assert(style('[data-slot=input-group]').borderTopLeftRadius === '10px', '输入框未使用 InputGroup 原生圆角')
    assert(style('button[aria-label="发送"]').borderTopLeftRadius === '8px', '发送按钮未使用 icon-sm 原生圆角')
    const draft = doc.querySelector<HTMLTextAreaElement>('textarea')!
    const frameWindow = iframe.contentWindow! as Window & typeof globalThis
    Object.getOwnPropertyDescriptor(frameWindow.HTMLTextAreaElement.prototype, 'value')!.set!.call(draft, '缩窗时保留的草稿')
    draft.dispatchEvent(new frameWindow.Event('input', { bubbles: true }))
    for (const width of [1100, 760, 400, 1240]) {
      iframe.style.width = `${width}px`
      await waitForLayout(() => (width <= 760 ? rect('[data-sidebar-clip]').width === 0 : rect('[data-sidebar-clip]').width > 0)
        && (width <= 1100 ? rect('[data-home-tabs]').width === 0 : Math.abs(rect('[data-home-tabs]').width - 380) < 1))
      await settleLayout()
      const sidebar = rect('[data-sidebar-clip]').width
      const tabs = rect('[data-home-tabs]').width
      const chat = rect('.home-chat').width
      assert(width <= 760 ? sidebar === 0 : sidebar > 0, `${width}px 会话侧栏显隐错误`)
      assert(width <= 1100 ? tabs === 0 : Math.abs(tabs - 380) < 1, `${width}px 标签页区显隐/原宽恢复错误`)
      assert(doc.documentElement.scrollWidth <= width + 1, `${width}px 应用横向溢出`)
      assert(doc.querySelector('textarea') === draft && draft.value === '缩窗时保留的草稿', `${width}px 草稿或输入框身份丢失`)
      const close = button('关闭').getBoundingClientRect()
      assert(close.right <= width && close.left >= 0, `${width}px 窗口控制被挤出`)
      if (width === 400) {
        const context = button('上下文窗口用量：31.33%')
        assert(context.getBoundingClientRect().width > 0, '400px 上下文入口丢失')
        assert(iframe.contentWindow!.getComputedStyle(context.querySelector('.context-ring')!).display !== 'none', '400px 未使用上下文圆环')
        const input = rect('.chat-composer-column')
        for (const control of doc.querySelectorAll<HTMLButtonElement>('.composer-toolbar button')) {
          const box = control.getBoundingClientRect()
          assert(box.right <= input.right && box.left >= input.left, `400px 输入按钮越界：${control.ariaLabel}`)
          assert(box.bottom <= 600, `400×600px 输入按钮超出窗口下缘：${control.ariaLabel}`)
        }
        assert(button('展开侧边栏').disabled && button('展开标签页区').disabled, '400px 可误展开侧栏挤掉对话')
      }
      rows.push({ width, sidebar, tabs, chat })
    }
    // 手动收起后，跨断点不能把用户有意关闭的栏重新打开。
    button('折叠侧边栏').click()
    button('折叠标签页区').click()
    await waitForLayout(() => rect('[data-sidebar-clip]').width === 0 && rect('[data-home-tabs]').width === 0)
    await settleLayout()
    iframe.style.width = '400px'
    await delay(350)
    iframe.style.width = '1240px'
    await settleLayout()
    assert(rect('[data-sidebar-clip]').width === 0 && rect('[data-home-tabs]').width === 0, '手动收起的栏被放宽窗口误恢复')
    report.textContent = `全部通过：自动折叠 / 放宽恢复 / 手动收起保留 / 400px 头部与上下文\n${JSON.stringify(rows, null, 2)}`
    iframe.style.width = '400px'
  } catch (error) {
    report.textContent = `${String(error)}\n${JSON.stringify(rows, null, 2)}`
  }
}
void run()
