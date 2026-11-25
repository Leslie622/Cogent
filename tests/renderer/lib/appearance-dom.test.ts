/** 外观的持久化边界和跨窗口投影；不把 jsdom 当成真实排版证据。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { bindAppearanceDom } from '@/lib/appearance-dom'
import { buildUserTokens, CODE_FONT_SIZES, UI_FONT_SIZES, useAppearanceStore } from '@/stores/appearance'

let unbind = () => {}
const media = { matches: false, addEventListener: vi.fn<(type: string, listener: () => void) => void>(), removeEventListener: vi.fn() }

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(media))
  document.documentElement.removeAttribute('style')
  media.matches = false
  media.addEventListener.mockClear()
  useAppearanceStore.setState({ uiFontSize: 14, codeFontSize: null, colorMode: 'light', interfaceSkin: 'mint', shellOpacity: 65, popoverGlass: true, codeWrap: false, accent: 'default' })
})

afterEach(() => {
  unbind()
  localStorage.clear()
  vi.unstubAllGlobals()
})

it('先投影持久偏好，再订阅变化；清覆盖和卸载都有实际效果', () => {
  useAppearanceStore.setState({ uiFontSize: 16, codeFontSize: 24, colorMode: 'dark' })
  unbind = bindAppearanceDom()
  const root = document.documentElement
  expect(root.style.getPropertyValue('--ui-font-size')).toBe('16px')
  expect(root.style.getPropertyValue('--app-code-size')).toBe('24px')
  expect(root.classList.contains('dark')).toBe(true)
  useAppearanceStore.getState().setUiFontSize(11)
  useAppearanceStore.getState().setCodeFontSize(null)
  expect(root.style.getPropertyValue('--ui-font-size')).toBe('11px')
  expect(root.style.getPropertyValue('--app-code-size')).toBe('')
  unbind()
  useAppearanceStore.getState().setUiFontSize(14)
  expect(root.style.getPropertyValue('--ui-font-size')).toBe('11px')
})

it('已打开的另一窗口从 storage 事件重读数值，数值代码覆盖进入主题管道', async () => {
  unbind = bindAppearanceDom()
  localStorage.setItem('cogent-appearance', JSON.stringify({ state: { uiFontSize: 11, codeFontSize: 8 }, version: 0 }))
  window.dispatchEvent(new StorageEvent('storage', { key: 'cogent-appearance', storageArea: localStorage }))
  await Promise.resolve()
  expect(document.documentElement.style.getPropertyValue('--ui-font-size')).toBe('11px')
  expect(document.documentElement.style.getPropertyValue('--app-code-size')).toBe('8px')
  expect(buildUserTokens(useAppearanceStore.getState())['codeBlock.size']).toBe('8px')
})

it('深色继续响应皮肤，切明暗保留选择与独立强调色', () => {
  unbind = bindAppearanceDom()
  const root = document.documentElement
  const store = useAppearanceStore.getState()
  store.setAccent('#123abc')
  store.setInterfaceSkin('sea')
  expect(root.dataset.interfaceSkin).toBe('sea')
  const lightSurface = root.style.getPropertyValue('--chrome-surface')
  const lightSidebar = root.style.getPropertyValue('--sidebar')
  store.setColorMode('dark')
  expect(root.classList.contains('dark')).toBe(true)
  const darkSurface = root.style.getPropertyValue('--chrome-surface')
  const darkSidebar = root.style.getPropertyValue('--sidebar')
  expect(darkSurface).not.toBe(lightSurface)
  expect(darkSidebar).not.toBe(lightSidebar)
  store.setInterfaceSkin('parchment')
  expect(root.style.getPropertyValue('--chrome-surface')).not.toBe(darkSurface)
  expect(root.style.getPropertyValue('--sidebar')).not.toBe(darkSidebar)
  expect(root.style.getPropertyValue('--chrome-accent')).toBe('#123abc')
  expect(useAppearanceStore.getState().colorMode).toBe('dark')
  store.setInterfaceSkin('sea')
  store.setColorMode('light')
  expect(root.style.getPropertyValue('--chrome-surface')).toBe(lightSurface)
  expect(root.style.getPropertyValue('--sidebar')).toBe(lightSidebar)
})

it('跟随系统换套且不重写皮肤偏好，同源窗口重读皮肤并在首帧恢复', async () => {
  useAppearanceStore.setState({ colorMode: 'system', interfaceSkin: 'honey' })
  unbind = bindAppearanceDom()
  const root = document.documentElement
  const lightSurface = root.style.getPropertyValue('--chrome-surface')
  media.matches = true
  media.addEventListener.mock.calls[0][1]()
  expect(root.classList.contains('dark')).toBe(true)
  expect(root.style.getPropertyValue('--chrome-surface')).not.toBe(lightSurface)
  expect(useAppearanceStore.getState()).toMatchObject({ interfaceSkin: 'honey', colorMode: 'system' })
  localStorage.setItem('cogent-appearance', JSON.stringify({ state: { interfaceSkin: 'dusk', colorMode: 'dark' }, version: 0 }))
  window.dispatchEvent(new StorageEvent('storage', { key: 'cogent-appearance', storageArea: localStorage }))
  await Promise.resolve()
  expect(root.dataset.interfaceSkin).toBe('dusk')
  const savedSurface = root.style.getPropertyValue('--chrome-surface')
  unbind()
  root.style.removeProperty('--chrome-surface')
  await useAppearanceStore.persist.rehydrate()
  unbind = bindAppearanceDom()
  expect(root.style.getPropertyValue('--chrome-surface')).toBe(savedSurface)
})

it.each([
  [undefined, 'mint'], ['constructor', 'mint'], ['unknown', 'mint'], [42, 'mint'], ['forest', 'mint'], // 已下线的皮肤 ID
  ['ink', 'ink'], ['mint', 'mint'], ['honey', 'honey'], ['parchment', 'parchment'], ['sea', 'sea'], ['dusk', 'dusk'],
])('读取皮肤偏好 %s，旧档和非法值回原薄荷，合法选择保留', async (stored, expected) => {
  localStorage.setItem('cogent-appearance', JSON.stringify({ state: { interfaceSkin: stored }, version: 0 }))
  await useAppearanceStore.persist.rehydrate()
  expect(useAppearanceStore.getState().interfaceSkin).toBe(expected)
})

it.each([
  [{ uiFontSize: 11, codeFontSize: 8 }, 11, 8],
  [{ uiFontSize: 16, codeFontSize: 24 }, 16, 24],
  [{ codeFontSize: 13 }, 14, 13],
  [{ uiFontSize: 10, codeFontSize: 7 }, 14, null],
  [{ uiFontSize: 17, codeFontSize: 25 }, 14, null],
  [{ uiFontSize: 12.5, codeFontSize: 15.5 }, 14, null],
])('持久化读取 %j 后只接受受控整数档', async (stored, uiSize, codeSize) => {
  localStorage.setItem('cogent-appearance', JSON.stringify({ state: stored, version: 0 }))
  await useAppearanceStore.persist.rehydrate()
  expect(useAppearanceStore.getState().uiFontSize).toBe(uiSize)
  expect(useAppearanceStore.getState().codeFontSize).toBe(codeSize)
  expect(UI_FONT_SIZES).toEqual([11, 12, 13, 14, 15, 16])
  expect(CODE_FONT_SIZES).toEqual(Array.from({ length: 17 }, (_value, index) => index + 8))
})

it('浮层毛玻璃默认开启，切换即时投影到 html[data-popover-glass] 并持久留存', async () => {
  unbind = bindAppearanceDom()
  const root = document.documentElement
  expect(root.hasAttribute('data-popover-glass')).toBe(true)
  useAppearanceStore.getState().setPopoverGlass(false)
  expect(root.hasAttribute('data-popover-glass')).toBe(false)
  await useAppearanceStore.persist.rehydrate()
  expect(useAppearanceStore.getState().popoverGlass).toBe(false)
  localStorage.setItem('cogent-appearance', JSON.stringify({ state: { popoverGlass: true }, version: 0 }))
  window.dispatchEvent(new StorageEvent('storage', { key: 'cogent-appearance', storageArea: localStorage }))
  await Promise.resolve()
  expect(root.hasAttribute('data-popover-glass')).toBe(true)
})

it.each([
  [undefined, 65], [39, 65], [101, 65], [72.5, 65], ['80', 65],
  [40, 40], [65, 65], [100, 100],
])('读取外壳不透明度 %s，非法或越界回落默认 65，合法整数保留并实时投影到外壳', async (stored, expected) => {
  vi.stubGlobal('cogent', { backdropSupported: true })
  unbind = bindAppearanceDom()
  localStorage.setItem('cogent-appearance', JSON.stringify({ state: { shellOpacity: stored }, version: 0 }))
  await useAppearanceStore.persist.rehydrate()
  expect(useAppearanceStore.getState().shellOpacity).toBe(expected)
  expect(document.documentElement.hasAttribute('data-backdrop')).toBe(true)
  const before = document.documentElement.style.getPropertyValue('--chrome-surface')
  useAppearanceStore.getState().setShellOpacity(expected === 100 ? 50 : 100)
  expect(document.documentElement.style.getPropertyValue('--chrome-surface')).not.toBe(before)
})

it('不支持系统材质的环境不挂 data-backdrop，自动保持实色渐变', () => {
  vi.stubGlobal('cogent', { backdropSupported: false })
  useAppearanceStore.setState({ shellOpacity: 50 })
  unbind = bindAppearanceDom()
  expect(document.documentElement.hasAttribute('data-backdrop')).toBe(false)
  expect(document.documentElement.style.getPropertyValue('--sidebar')).toMatch(/^#[0-9a-f]{6}$/i)
})
