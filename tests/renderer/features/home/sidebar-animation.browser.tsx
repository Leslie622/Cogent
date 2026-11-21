/** 真实导航逐帧验收：裁剪期间行高、图标位置、反向开合和嵌套状态保持稳定。 */
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { HomeSidebar } from '@/features/home/HomeSidebar'
import { AppShell } from '@/features/shell/AppShell'
import { interfaceSkinVariables } from '@/lib/interface-skins'
import { useChatStore } from '@/stores/chat'
import { useProjectStore } from '@/stores/project'
import '@/globals.css'

const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve))
function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

type Sample = { height: number; minRow: number; iconDrift: number }
type Case = { width: number; count: number; target: string; samples: Sample[] }
declare global {
  interface Window {
    sidebarAnimationResult?: { passed: boolean; cases: number; frames: number; reduced: boolean; error?: string; failure?: Case }
    sidebarPixelHarness: {
      prepare: (width: number, count: number, offset: number, dark: boolean) => Promise<{ name: string; x: number; y: number; width: number; height: number }[]>
      animate: (name: string) => Promise<void>
      checkLongList: () => Promise<{ rows: number; skipped: number; scrollHeight: number }>
    }
  }
}

window.cogent = { onWindowState: () => () => {}, onEngineEvent: () => () => {} } as unknown as typeof window.cogent
useProjectStore.setState({ loaded: true, load: async () => {}, projects: [
  { id: 'project', name: '项目一', cwds: ['C:/fixture'], createdAt: 1 },
  { id: 'pinned', name: '置顶项目', cwds: ['C:/pinned'], createdAt: 1, pinnedAt: 1 },
  { id: 'other', name: '项目二', cwds: ['C:/other'], createdAt: 1 },
] })
const host = document.getElementById('root')!
host.style.cssText = 'height:560px;width:240px'
const root = createRoot(host)
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
const cases: Case[] = []
let current: Case | undefined

function trigger(name: string): HTMLButtonElement {
  const element = [...host.querySelectorAll<HTMLButtonElement>('[data-slot="collapsible-trigger"]')]
    .find((button) => button.textContent === name)
  assert(element !== undefined, `找不到折叠入口：${name}`)
  return element
}
function panel(button: HTMLButtonElement): HTMLElement {
  return document.getElementById(button.getAttribute('aria-controls')!)!
}
async function settle() {
  await frame()
  await frame()
  await Promise.allSettled(host.getAnimations({ subtree: true }).map((animation) => animation.finished))
  await frame()
  await frame()
}

async function measure(button: HTMLButtonElement, reverse: boolean) {
  const content = panel(button)
  const rows = [...content.querySelectorAll<HTMLElement>('[data-slot="context-menu-trigger"]')]
    .filter((row) => row.getBoundingClientRect().height > 0)
  const initial = rows.map((row) => {
    const rect = row.getBoundingClientRect()
    const icon = row.querySelector('svg')!
    return { row, icon, offset: icon.getBoundingClientRect().y - rect.y }
  })
  const samples: Sample[] = []
  current!.samples = samples
  let previous = content.getBoundingClientRect().height
  let direction = -1
  let reversed = false
  flushSync(() => button.click())
  const started = await frame()
  for (let timestamp = started; timestamp - started < (reverse ? 420 : 300); timestamp = await frame()) {
    if (reverse && !reversed && timestamp - started >= 65) {
      const beforeReverse = content.getBoundingClientRect().height
      flushSync(() => button.click())
      previous = content.getBoundingClientRect().height
      if (!reduced) assert(Math.abs(previous - beforeReverse) < 1, `${button.textContent}反向瞬间高度跳变`)
      reversed = true
      direction = 1
    }
    const height = content.getBoundingClientRect().height
    assert(direction < 0 ? height <= previous + 1 : height >= previous - 1, `${button.textContent}高度反跳：${previous} → ${height}`)
    previous = height
    if (content.hidden) continue
    let minRow = 32
    let iconDrift = 0
    for (const { row, icon, offset } of initial) {
      const rect = row.getBoundingClientRect()
      minRow = Math.min(minRow, rect.height)
      iconDrift = Math.max(iconDrift, Math.abs(icon.getBoundingClientRect().y - rect.y - offset))
    }
    samples.push({ height, minRow, iconDrift })
  }
  assert(samples.every((sample) => Math.abs(sample.minRow - 32) < 0.1), `${button.textContent}折叠压缩了列表行`)
  assert(samples.every((sample) => sample.iconDrift < 0.1), `${button.textContent}折叠时图标在行内移动`)
  if (!reduced) assert(samples.some((sample) => sample.height > 1 && sample.height < samples[0].height - 1), `${button.textContent}缺少中间动画帧`)
  await settle()
  assert(content.contains(rows[0]), '折叠卸载了列表行')
  if (!reverse) {
    assert(content.hidden && content.inert, '收起结束后没有隐藏或禁止交互')
    rows[0].querySelector<HTMLButtonElement>('button')!.focus()
    assert(!content.contains(document.activeElement), '收起内容仍可聚焦')
    button.click()
    await settle()
  }
}

async function run() {
  try {
    for (const width of [240, 320]) for (const count of [4, 24]) {
      document.documentElement.dataset.sidebarStage = `${width}/${count}/初始化`
      host.style.width = `${width}px`
      useChatStore.setState({ sessions: [
        ...Array.from({ length: count }, (_, index) => ({ id: `recent-${index}`, title: `最近聊天 ${index}`, createdAt: 1, updatedAt: 1 })),
        ...Array.from({ length: 6 }, (_, index) => ({ id: `child-${index}`, title: `项目聊天 ${index}`, projectId: 'project', createdAt: 1, updatedAt: 1 })),
        { id: 'pin-chat', title: '置顶聊天', pinnedAt: 1, createdAt: 1, updatedAt: 1 },
      ] })
      root.render(<HomeSidebar key={`${width}-${count}`} />)
      await settle()
      await document.fonts.ready
      for (const name of ['置顶', '项目', '最近', '项目一']) {
        const button = trigger(name)
        assert(button.getAttribute('aria-expanded') === 'true', `${name}没有默认展开`)
        for (const reverse of [false, true]) {
          current = { width, count, target: `${name}/${reverse ? '反向' : '完整'}`, samples: [] }
          document.documentElement.dataset.sidebarStage = `${width}/${count}/${current.target}`
          await measure(button, reverse)
          cases.push(current)
        }
      }
      assert(trigger('项目一').getAttribute('aria-expanded') === 'true', '分区重开丢失项目展开态')
    }
    window.sidebarAnimationResult = { passed: true, cases: cases.length, frames: cases.reduce((sum, item) => sum + item.samples.length, 0), reduced }
  } catch (error) {
    window.sidebarAnimationResult = { passed: false, cases: cases.length, frames: 0, reduced, error: String(error), failure: current }
  }
  const report = document.createElement('pre')
  report.textContent = JSON.stringify(window.sidebarAnimationResult, null, 2)
  document.body.append(report)
}
if (new URLSearchParams(location.search).has('pixels')) {
  window.sidebarPixelHarness = {
    async prepare(width, count, offset, dark) {
      localStorage.setItem('cogent.ui.content-sidebar-layout', JSON.stringify({ widthPx: width, collapsed: false }))
      document.documentElement.classList.toggle('dark', dark)
      for (const [name, value] of Object.entries(interfaceSkinVariables('mint', dark))) document.documentElement.style.setProperty(name, value)
      host.style.cssText = `position:relative;top:${offset}px`
      useChatStore.setState({ sessions: [
        ...Array.from({ length: count }, (_, index) => ({ id: `recent-${index}`, title: `最近聊天 ${index}`, createdAt: 1, updatedAt: 1 })),
        ...Array.from({ length: 6 }, (_, index) => ({ id: `child-${index}`, title: `项目聊天 ${index}`, projectId: 'project', createdAt: 1, updatedAt: 1 })),
      ] })
      root.render(<AppShell key={`${width}-${count}-${offset}-${dark}`} />)
      await settle()
      await document.fonts.ready
      const newChat = [...host.querySelectorAll('button')].find((button) => button.textContent === '新聊天')!
      return [
        { name: '新聊天', icon: newChat.querySelector('svg')! },
        { name: '搜索', icon: host.querySelector('button[aria-label="搜索"] svg')! },
        { name: '首页', icon: host.querySelector('button[aria-label="首页"] svg')! },
      ].map(({ name, icon }) => {
        const rect = icon.getBoundingClientRect()
        return { name, x: rect.x - 2, y: rect.y - 2, width: rect.width + 4, height: rect.height + 4 }
      })
    },
    async animate(name) {
      const button = name === '会话列表' ? host.querySelector<HTMLButtonElement>('button[aria-label="折叠侧边栏"]')! : trigger(name)
      if (name === '会话列表') console.info('SIDEBAR_PHASE:closing')
      flushSync(() => button.click())
      const nextPaint = async () => {
        await frame()
        if (name === '会话列表') console.info(`SIDEBAR_CLIP:${host.querySelector('[data-sidebar-clip]')!.getBoundingClientRect().width}`)
      }
      for (let index = 0; index < 24; index++) await nextPaint()
      const restore = name === '会话列表' ? host.querySelector<HTMLButtonElement>('button[aria-label="展开侧边栏"]')! : button
      if (name === '会话列表') console.info('SIDEBAR_PHASE:opening')
      flushSync(() => restore.click())
      for (let index = 0; index < 24; index++) await nextPaint()
      await settle()
      if (name === '会话列表') console.info('SIDEBAR_PHASE:finished')
    },
    async checkLongList() {
      await window.sidebarPixelHarness.prepare(300, 300, 0, false)
      const list = host.querySelector<HTMLElement>('.scrollbar-native')!
      const buttons = [...list.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent.startsWith('最近聊天 '))
      const last = buttons[buttons.length - 1]
      const scrollHeight = list.scrollHeight
      const skipped = buttons.filter((button) => !button.checkVisibility({ contentVisibilityAuto: true })).length
      assert(skipped > 0 && !last.checkVisibility({ contentVisibilityAuto: true }), '长列表的屏外内容没有跳过渲染')
      list.scrollTop = scrollHeight
      await settle()
      assert(last.checkVisibility({ contentVisibilityAuto: true }), '滚动到底后末行没有恢复渲染')
      assert(Math.abs(list.scrollHeight - scrollHeight) < 1, '恢复屏外行改变了列表占位高度')
      const rect = last.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      assert(hit !== null && last.contains(hit), '末行恢复后不能命中主按钮')
      list.scrollTop = 0
      await settle()
      last.focus()
      await settle()
      assert(document.activeElement === last && last.checkVisibility({ contentVisibilityAuto: true }) && list.scrollTop > 0, '键盘聚焦未自动恢复屏外行并滚入视口')
      return { rows: buttons.length, skipped, scrollHeight }
    },
  }
} else {
  void run()
}
