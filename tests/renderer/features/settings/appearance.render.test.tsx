/** 强调色回归：只显示 Themd 色板，不让旧预设或无效草稿成为当前颜色。 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AppearanceSection } from '@/features/settings/AppearanceSection'
import { useAppearanceStore } from '@/stores/appearance'

const storageKey = 'cogent-appearance'

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }))
})

afterEach(() => {
  cleanup()
  useAppearanceStore.getState().setAccent('default')
  localStorage.removeItem(storageKey)
  vi.unstubAllGlobals()
})

it('打开取色面板不改设置，Themd 色板和 HEX 输入即时保存，默认档可恢复', () => {
  render(<AppearanceSection />)
  const controls = within(screen.getByRole('group', { name: '强调色' }))
  expect(controls.getAllByRole('button')).toHaveLength(2)
  const reset = controls.getByRole('button', { name: '恢复默认' })
  const trigger = controls.getByRole('button', { name: '选择颜色' })
  expect(reset).toBeDisabled()
  expect(trigger).toHaveTextContent(/^$/)
  fireEvent.click(trigger)
  const picker = within(screen.getByRole('dialog', { name: '强调色选择器' }))
  expect(picker.queryByText('自定义强调色')).not.toBeInTheDocument()
  const swatches = within(picker.getByRole('group', { name: '预设色' }))
  expect(swatches.getAllByRole('button')).toHaveLength(16)
  expect(useAppearanceStore.getState().accent).toBe('default')

  const violet = swatches.getByRole('button', { name: '预设色 #8b5cf6' })
  fireEvent.click(violet)
  expect(violet).toHaveAttribute('aria-pressed', 'true')
  const input = screen.getByRole('textbox', { name: 'HEX' })
  expect(input).toHaveValue('#8b5cf6')
  expect(useAppearanceStore.getState().accent).toBe('#8b5cf6')

  fireEvent.change(input, { target: { value: 'bad' } })
  fireEvent.blur(input)
  expect(input).toHaveValue('#8b5cf6')
  expect(useAppearanceStore.getState().accent).toBe('#8b5cf6')

  fireEvent.change(input, { target: { value: '123ABC' } })
  expect(useAppearanceStore.getState().accent).toBe('#123abc')
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({ state: { accent: '#123abc' } })
  fireEvent.click(reset)
  expect(useAppearanceStore.getState().accent).toBe('default')
})

it.each([
  ['teal', 'default'],
  ['#123abc', '#123abc'],
  ['#123abc80', '#123abc80'],
  ['#123abc00', '#123abc00'],
  ['#123abc000', 'default'],
  ['constructor', 'default'],
])('重读强调色 %s 后只保留合法 RGB / RGBA HEX', async (stored, accent) => {
  localStorage.setItem(storageKey, JSON.stringify({ state: { accent: stored }, version: 0 }))
  await act(() => useAppearanceStore.persist.rehydrate())
  expect(useAppearanceStore.getState().accent).toBe(accent)
})

it('RGBA 输入与取色同步，改色不重置透明度，重新打开仍显示保存值', () => {
  render(<AppearanceSection />)
  const trigger = screen.getByRole('button', { name: '选择颜色' })
  fireEvent.click(trigger)
  const hex = screen.getByRole('textbox', { name: 'HEX' })
  const red = screen.getByRole('textbox', { name: 'R' })
  const green = screen.getByRole('textbox', { name: 'G' })
  const blue = screen.getByRole('textbox', { name: 'B' })
  const alpha = screen.getByRole('textbox', { name: 'A (%)' })
  const slider = screen.getByRole('slider', { name: '透明度' })

  fireEvent.change(hex, { target: { value: '#123456' } })
  fireEvent.blur(hex)
  expect(red).toHaveValue('18')
  expect(green).toHaveValue('52')
  expect(blue).toHaveValue('86')
  fireEvent.change(alpha, { target: { value: '50' } })
  fireEvent.blur(alpha)
  expect(slider).toHaveAttribute('aria-valuenow', '50')
  expect(useAppearanceStore.getState().accent).toBe('#12345680')
  fireEvent.change(red, { target: { value: '255' } })
  fireEvent.blur(red)
  expect(hex).toHaveValue('#ff3456')
  expect(useAppearanceStore.getState().accent).toBe('#ff345680')
  fireEvent.change(alpha, { target: { value: '101' } })
  fireEvent.blur(alpha)
  expect(alpha).toHaveValue('50')

  fireEvent.click(screen.getByRole('button', { name: '预设色 #8b5cf6' }))
  expect(useAppearanceStore.getState().accent).toBe('#8b5cf680')
  fireEvent.click(trigger)
  fireEvent.click(trigger)
  expect(screen.getByRole('textbox', { name: 'A (%)' })).toHaveValue('50')
  fireEvent.keyDown(screen.getByRole('slider', { name: '透明度' }), { key: 'ArrowLeft' })
  expect(screen.getByRole('textbox', { name: 'A (%)' })).toHaveValue('49')
})
