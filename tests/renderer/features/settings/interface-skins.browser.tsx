/** 真实 AppShell 验证皮肤实际着色，避免只验证变量变化却漏掉深色 CSS 覆盖。 */
import { createRoot } from 'react-dom/client'
import { AppShell } from '@/features/shell/AppShell'
import { bindAppearanceDom } from '@/lib/appearance-dom'
import { INTERFACE_SKIN_IDS, INTERFACE_SKINS, type InterfaceSkinId } from '@/lib/interface-skins'
import { useAppearanceStore } from '@/stores/appearance'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import '@/globals.css'

const commit = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

window.cogent = { onWindowState: () => () => {} } as unknown as typeof window.cogent
useUiStore.setState({ view: 'settings' })
useSettingsStore.setState({ section: 'appearance' })
useAppearanceStore.setState({ interfaceSkin: 'mint', colorMode: 'light' })
const unbind = bindAppearanceDom()
const root = createRoot(document.getElementById('root')!)
root.render(<AppShell />)

async function select(id: InterfaceSkinId, dark: boolean) {
  useAppearanceStore.getState().setColorMode(dark ? 'dark' : 'light')
  await commit()
  document.querySelector<HTMLElement>(`[role=radio][aria-label="${INTERFACE_SKINS[id].name}"]`)!.click()
  await commit()
  // 隐藏窗口只核对最终布局与配色；主动结束过渡，不将截图当成动画时序证据。
  for (const animation of document.getAnimations().filter((animation) => animation.constructor.name === 'CSSTransition')) animation.finish()
  await commit()
}

async function verify(expectedColumns: 3 | 6) {
  await document.fonts.ready
  await commit()
  const surfaces = new Set<string>()
  const rows = []
  const style = (selector: string) => getComputedStyle(document.querySelector(selector)!)
  const mainBackground = { light: '', dark: '' }
  for (const dark of [false, true]) {
    for (const id of INTERFACE_SKIN_IDS) {
      await select(id, dark)
      const surface = style('#root > .chrome-surface').backgroundImage
      const preview = style(`[role=radio][aria-label="${INTERFACE_SKINS[id].name}"] .chrome-surface`)
      assert(surface !== 'none', `${id} ${dark} 外壳渐变被覆盖`)
      assert(surface === preview.backgroundImage, `${id} ${dark} 预览与外壳不一致`)
      assert(style('[data-sidebar-clip]').backgroundColor === style(`[role=radio][aria-label="${INTERFACE_SKINS[id].name}"] .bg-content-sidebar`).backgroundColor,
      `${id} ${dark} 侧栏与预览不一致`)
      assert(!surfaces.has(surface), `${id} ${dark} 皮肤没有实际改变外壳`)
      surfaces.add(surface)
      const mode = dark ? 'dark' : 'light'
      const background = style('main').backgroundColor
      if (mainBackground[mode] === '') mainBackground[mode] = background
      assert(background === mainBackground[mode], '换肤影响正文底色')
      assert(document.querySelectorAll('[role=radio][aria-checked=true]').length === 1, '皮肤不是单选')
      assert(document.documentElement.scrollWidth <= innerWidth, '窗口横向溢出')
      const picker = document.querySelector('[role=radiogroup]')!
      assert(getComputedStyle(picker).gridTemplateColumns.split(' ').length === expectedColumns,
        `皮肤未使用紧凑列数：${JSON.stringify({ width: innerWidth, expectedColumns, columns: getComputedStyle(picker).gridTemplateColumns, pickerWidth: picker.getBoundingClientRect().width })}`)
      for (const card of document.querySelectorAll<HTMLElement>('[role=radio]')) {
        const box = card.getBoundingClientRect()
        const panel = document.querySelector('[role=radiogroup]')!.getBoundingClientRect()
        assert(box.width >= 56 && box.left >= panel.left && box.right <= panel.right + 1, '皮肤卡太窄或溢出')
      }
      rows.push({ id, dark, width: innerWidth, surface, sidebar: style('[data-sidebar-clip]').backgroundColor })
    }
  }
  return rows
}

async function showThemeColors(dark: boolean) {
  useAppearanceStore.getState().setAccent('#12345680')
  await select('sea', dark)
  const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="选择颜色"]')!
  trigger.scrollIntoView({ block: 'center' })
  if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click()
  await commit()
  await Promise.allSettled(document.getAnimations().map((animation) => animation.finished))
  const dialog = document.querySelector<HTMLElement>('[role=dialog][aria-label="强调色选择器"]')!
  const panel = dialog.getBoundingClientRect()
  assert(panel.left >= 0 && panel.right <= innerWidth && panel.top >= 0 && panel.bottom <= innerHeight,
    `取色浮层超出窗口：${JSON.stringify({
      panel: { left: panel.left, right: panel.right, top: panel.top, bottom: panel.bottom },
      width: innerWidth, height: innerHeight
    })}`)
  const themes = dialog.querySelector<HTMLElement>('[role=group][aria-label="主题色"]')!
  const buttons = themes.querySelectorAll<HTMLButtonElement>('button')
  assert(buttons.length === 6, '主题色候选数量错误')
  const themeBox = themes.getBoundingClientRect()
  const firstTheme = buttons[0].getBoundingClientRect()
  const lastTheme = buttons[2].getBoundingClientRect()
  assert(Math.abs(firstTheme.left - themeBox.left) <= 1 && Math.abs(lastTheme.right - themeBox.right) <= 1, '主题色色板没有贴齐分区左右边距')
  for (const button of buttons) {
    const box = button.getBoundingClientRect()
    const swatch = button.children[0].getBoundingClientRect()
    const label = button.children[1].getBoundingClientRect()
    assert(Math.abs(swatch.left - box.left) <= 1, '主题色选项内容没有靠左')
    assert(swatch.left >= box.left && label.right <= box.right, '主题色名称溢出')
  }
  assert(Math.abs(buttons[3].getBoundingClientRect().left - firstTheme.left) <= 1, '主题色上下行没有左对齐')
  const presets = dialog.querySelector<HTMLElement>('[role=group][aria-label="预设色"]')!
  const presetBox = presets.getBoundingClientRect()
  const lines = new Map<number, DOMRect[]>()
  for (const button of presets.querySelectorAll('button')) {
    const box = button.getBoundingClientRect()
    const row = Math.round(box.top)
    lines.set(row, [...(lines.get(row) ?? []), box])
  }
  const presetRows = [...lines.values()]
  const firstPresetRow = presetRows[0]
  assert(Math.abs(firstPresetRow[0].left - presetBox.left) <= 1 && Math.abs(firstPresetRow.at(-1)!.right - presetBox.right) <= 1, '预设色色板没有贴齐内容左右边距')
  assert(Math.abs(firstTheme.left - firstPresetRow[0].left) <= 1 && Math.abs(themeBox.left - presetBox.left) <= 1 && Math.abs(themeBox.right - presetBox.right) <= 1, '预设色、主题色标题与色块的边距不一致')
  for (const boxes of presetRows) {
    assert(Math.abs(boxes[0].left - firstPresetRow[0].left) <= 1, '预设色换行后没有靠左')
  }
  return { dark, width: innerWidth, height: innerHeight, colors: buttons.length }
}

async function verifyThemeColors() {
  const rows = []
  for (const dark of [false, true]) {
    rows.push(await showThemeColors(dark))
    document.querySelector<HTMLButtonElement>('button[aria-label="选择颜色"]')!.click()
    await commit()
  }
  return rows
}

declare global {
  interface Window {
    interfaceSkinHarness: { select: typeof select; verify: typeof verify; showThemeColors: typeof showThemeColors; verifyThemeColors: typeof verifyThemeColors }
  }
}
window.interfaceSkinHarness = { select, verify, showThemeColors, verifyThemeColors }
if (import.meta.hot) import.meta.hot.dispose(() => { unbind(); root.unmount() })
