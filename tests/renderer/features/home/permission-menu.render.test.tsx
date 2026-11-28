/**
 * PermissionMenu 全链路测试（mock IPC）—— 钉「点完全访问没切换」的第二
 * 入口：权限菜单选完全访问 → FullAccessConfirm 闸门 → 确认启用 →
 * session.setPermission IPC 带参发出 → 引擎摘要回流 → 触发钮变完全访问。
 * store 用真实实现（setPermission 的 sessions 更新逻辑一起验证），只替
 * window.cogent.engineRequest（jsdom 无 preload）。事件用 fireEvent（jsdom
 * 下 userEvent 的 pointer 序列打不开 Base UI 菜单，见
 * switch-mode-dropdown.render.test.tsx 头注）。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/env.d'
import { useAppearanceStore } from '@/stores/appearance'
import { useChatStore } from '@/stores/chat'
import { PermissionMenu } from '@/features/home/PermissionMenu'

const SID = 's-perm-menu'
const summary = (mode: SessionSummary['permissionMode']): SessionSummary => ({
  id: SID,
  title: '权限菜单测试会话',
  createdAt: 0,
  updatedAt: 0,
  permissionMode: mode
})

const initialState = { ...useChatStore.getState() }
const engineRequest = vi.fn()
beforeEach(() => {
  useChatStore.setState(initialState, true)
  engineRequest.mockReset()
  window.cogent = { engineRequest } as unknown as typeof window.cogent
})

const mount = (mode: SessionSummary['permissionMode'] = 'ask') => {
  useChatStore.setState({
    activeSessionId: SID,
    sessions: [summary(mode)]
  })
  render(<PermissionMenu session={{ kind: 'chat', chatId: SID }} />)
}

describe('PermissionMenu 完全访问切换全链路', () => {
  it('选完全访问 → 过闸门 → setPermission IPC 带参 → 摘要回流后触发钮变「完全访问」', async () => {
    mount('ask')
    expect(screen.getByRole('button', { name: /权限模式：变更前确认/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /权限模式/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /完全访问/ }))

    // 闸门出现且确认前不发 IPC
    expect(screen.getByText('要启用完全访问吗？')).toBeInTheDocument()
    expect(engineRequest).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('checkbox'))
    engineRequest.mockResolvedValue({ summary: summary('auto') })
    fireEvent.click(screen.getByRole('button', { name: '确认启用' }))

    expect(engineRequest).toHaveBeenCalledWith('session.setPermission', {
      sessionId: SID,
      mode: 'auto'
    })
    // 摘要回流是 setPermission 的 async 续段（await IPC 后才 set），waitFor 等
    // 触发钮翻成完全访问（琥珀警示档名）
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /权限模式：完全访问/ })).toBeInTheDocument()
    )
  })

  it('闸门取消 = 不切档：无 IPC、触发钮保持原档', () => {
    mount('ask')
    fireEvent.click(screen.getByRole('button', { name: /权限模式/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /完全访问/ }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(engineRequest).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /权限模式：变更前确认/ })).toBeInTheDocument()
  })

  it('已是完全访问再点它 = 无操作不弹闸门', () => {
    mount('auto')
    fireEvent.click(screen.getByRole('button', { name: /权限模式/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /完全访问/ }))
    expect(screen.queryByText('要启用完全访问吗？')).not.toBeInTheDocument()
  })

  it('切回收紧档（ask）无闸门直切', async () => {
    mount('auto')
    fireEvent.click(screen.getByRole('button', { name: /权限模式/ }))
    engineRequest.mockResolvedValue({ summary: summary('ask') })
    fireEvent.click(screen.getByRole('menuitem', { name: /变更前确认/ }))
    expect(engineRequest).toHaveBeenCalledWith('session.setPermission', {
      sessionId: SID,
      mode: 'ask'
    })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /权限模式：变更前确认/ })).toBeInTheDocument()
    )
  })
})

/** jsdom 没有 Tailwind 样式：菜单行被聚焦时的底色由桩给出（真实值由 Electron 探针验证）；
 *  hook 读静息底色的克隆副本带 position:absolute 内联，仍走真实计算值。 */
const realGetComputedStyle = window.getComputedStyle.bind(window)
function stubMenuFocusBackground() {
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => {
    const style = realGetComputedStyle(el)
    const row = el as HTMLElement
    if (!row.matches('[data-slot="dropdown-menu-item"]') || row.style.position === 'absolute') return style
    const focus =
      row.getAttribute('data-variant') === 'warning' ? 'oklab(0.666 0.053 0.146 / 0.1)' : 'oklch(0.97 0 0)'
    return new Proxy(style, {
      get: (target, key) => (key === 'backgroundColor' ? focus : (Reflect.get(target, key, target) as unknown)),
    })
  })
}

describe('PermissionMenu 高亮走全局滑动开关（DropdownMenu 读外观 hoverSlide）', () => {
  afterEach(() => {
    useAppearanceStore.setState({ hoverSlide: true })
    vi.restoreAllMocks()
  })

  it('开启：行保留 focus:bg-* 原类并打 data-hover-slide；焦点落行时胶囊读走该行自己的底色（warning 档带色）', () => {
    stubMenuFocusBackground()
    mount('ask')
    fireEvent.click(screen.getByRole('button', { name: /权限模式/ }))
    const menu = screen.getByRole('menu')
    const ask = screen.getByRole('menuitem', { name: /变更前确认/ })
    const auto = screen.getByRole('menuitem', { name: /完全访问/ })

    expect(menu.querySelectorAll('[data-hover-slide]')).toHaveLength(4)
    // 原有高亮类一字不动：关掉开关后行按原样自画
    expect(ask.className).toContain('focus:bg-accent')
    expect(auto.className).toContain('data-[variant=warning]:focus:bg-warning/10')

    const pill = menu.querySelector<HTMLElement>('.hover-slide-pill')
    if (pill === null) throw new Error('菜单里缺少滑动胶囊')
    expect(pill).toHaveAttribute('data-visible', 'false')

    // jsdom 无布局：补行高后派发 focusin（同 Base UI 悬停 / 方向键移焦点）
    Object.defineProperty(auto, 'offsetTop', { value: 96, configurable: true })
    Object.defineProperty(auto, 'offsetLeft', { value: 4, configurable: true })
    Object.defineProperty(auto, 'offsetWidth', { value: 248, configurable: true })
    Object.defineProperty(auto, 'offsetHeight', { value: 36, configurable: true })
    fireEvent.focusIn(auto)
    expect(pill).toHaveAttribute('data-visible', 'true')
    expect(pill.style.getPropertyValue('--pill-y')).toBe('96px')
    expect(pill.style.getPropertyValue('--pill-h')).toBe('36px')
    expect(pill.style.getPropertyValue('--pill-bg')).toBe('oklab(0.666 0.053 0.146 / 0.1)')
    expect(auto).toHaveAttribute('data-pill-over', '')
  })

  it('开启：指针压到分割线（去向不是菜单行）时不清高亮，胶囊才滑得过分割线', () => {
    stubMenuFocusBackground()
    mount('ask')
    fireEvent.click(screen.getByRole('button', { name: /权限模式/ }))
    const menu = screen.getByRole('menu')
    const plan = screen.getByRole('menuitem', { name: /计划模式/ })
    const separator = menu.querySelector('[data-slot=dropdown-menu-separator]')
    if (!(separator instanceof HTMLElement)) throw new Error('菜单里缺少分割线')

    Object.defineProperty(plan, 'offsetTop', { value: 0, configurable: true })
    Object.defineProperty(plan, 'offsetLeft', { value: 4, configurable: true })
    Object.defineProperty(plan, 'offsetWidth', { value: 248, configurable: true })
    Object.defineProperty(plan, 'offsetHeight', { value: 54, configurable: true })
    plan.focus()
    fireEvent.focusIn(plan)
    const pill = menu.querySelector<HTMLElement>('.hover-slide-pill')
    if (pill === null) throw new Error('菜单里缺少滑动胶囊')
    expect(pill).toHaveAttribute('data-visible', 'true')
    expect(plan).toHaveAttribute('data-pill-over', '')

    // React 的 onPointerLeave 由 pointerout + relatedTarget 合成。Base UI 默认在这里
    // 清空高亮并把焦点移回面板（resetOnPointerLeave），胶囊只能淡出；滑动开启时关掉了它
    fireEvent.pointerOut(plan, { relatedTarget: separator })
    expect(plan).toHaveFocus()
    expect(pill).toHaveAttribute('data-visible', 'true')
    expect(plan).toHaveAttribute('data-pill-over', '')
  })

  it('关闭：不渲染胶囊、行不打标记，指针压到分割线按 Base UI 默认清高亮', () => {
    useAppearanceStore.setState({ hoverSlide: false })
    stubMenuFocusBackground()
    mount('ask')
    fireEvent.click(screen.getByRole('button', { name: /权限模式/ }))
    const menu = screen.getByRole('menu')
    expect(menu.querySelector('.hover-slide-pill')).toBeNull()
    expect(menu.querySelector('[data-hover-slide]')).toBeNull()

    const plan = screen.getByRole('menuitem', { name: /计划模式/ })
    const separator = menu.querySelector('[data-slot=dropdown-menu-separator]')
    if (!(separator instanceof HTMLElement)) throw new Error('菜单里缺少分割线')
    plan.focus()
    fireEvent.pointerOut(plan, { relatedTarget: separator })
    expect(plan).not.toHaveFocus()
  })
})
