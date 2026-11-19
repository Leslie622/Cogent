/** 外观的持久化边界和跨窗口投影；不把 jsdom 当成真实排版证据。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { bindAppearanceDom } from '@/lib/appearance-dom'
import { buildUserTokens, CODE_FONT_SIZES, UI_FONT_SIZES, useAppearanceStore } from '@/stores/appearance'

let unbind = () => {}
const media = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(media))
  document.documentElement.removeAttribute('style')
  useAppearanceStore.setState({ uiFontSize: 14, codeFontSize: null, colorMode: 'light', codeWrap: false, accent: 'default' })
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
