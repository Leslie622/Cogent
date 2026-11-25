/** 强调色回归：只显示 Themd 色板，不让旧预设或无效草稿成为当前颜色。 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { AppearanceSection } from '@/features/settings/AppearanceSection'
import { useAppearanceStore } from '@/stores/appearance'

const storageKey = 'cogent-appearance'

beforeEach(() => {
  useAppearanceStore.setState({ colorMode: 'light', interfaceSkin: 'mint', shellOpacity: 65 })
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }))
})

afterEach(() => {
  cleanup()
  useAppearanceStore.getState().setAccent('default')
  useAppearanceStore.setState({ colorMode: 'light', interfaceSkin: 'mint', shellOpacity: 65 })
  localStorage.removeItem(storageKey)
  vi.unstubAllGlobals()
})

it('主题色紧随深浅模式，卡片单选即时保存，键盘可切换且跟随明暗预览', async () => {
  const user = userEvent.setup()
  render(<AppearanceSection />)
  const modes = screen.getByRole('combobox', { name: '深色浅色' })
  const picker = screen.getByRole('radiogroup', { name: '主题色' })
  expect(modes.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  const cards = within(picker)
  expect(cards.getAllByRole('radio')).toHaveLength(6)
  expect(cards.getByRole('radio', { name: '薄荷' })).toHaveAttribute('aria-checked', 'true')
  const ink = cards.getByRole('radio', { name: '墨色' })
  const lightPreview = ink.style.getPropertyValue('--chrome-surface')
  await user.click(ink)
  expect(ink).toHaveAttribute('aria-checked', 'true')
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({ state: { interfaceSkin: 'ink', colorMode: 'light' } })
  await user.keyboard('{ArrowRight}')
  expect(cards.getByRole('radio', { name: '薄荷' })).toHaveAttribute('aria-checked', 'true')
  expect(useAppearanceStore.getState().interfaceSkin).toBe('mint')
  act(() => useAppearanceStore.getState().setColorMode('dark'))
  expect(ink.style.getPropertyValue('--chrome-surface')).not.toBe(lightPreview)
  await user.click(cards.getByRole('radio', { name: '暮紫' }))
  expect(useAppearanceStore.getState()).toMatchObject({ interfaceSkin: 'dusk', colorMode: 'dark' })
  act(() => useAppearanceStore.getState().setColorMode('light'))
  expect(cards.getByRole('radio', { name: '暮紫' })).toHaveAttribute('aria-checked', 'true')
  expect(ink.style.getPropertyValue('--chrome-surface')).toBe(lightPreview)
})

it('打开取色面板不改设置，Themd 色板和 HEX 输入即时保存，默认档可恢复', () => {
  render(<AppearanceSection />)
  const controls = within(screen.getByRole('group', { name: '强调色' }))
  expect(controls.getAllByRole('button')).toHaveLength(2)
  const reset = controls.getByRole('button', { name: '恢复默认强调色' })
  const trigger = controls.getByRole('button', { name: '选择颜色' })
  expect(reset).toBeDisabled()
  /* 默认档触发钮按明暗回落显示色值（亮 #0231fa／暗 #5f9cff，测试环境无 dark 类） */
  expect(trigger).toHaveTextContent('#0231fa')
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
  ['light', ['#171717', '#398c79', '#9b8433', '#b16b4c', '#557da6', '#8a6aa5']],
  ['dark', ['#e5e5e5', '#87cbb6', '#d4bd72', '#d6a286', '#92b8df', '#bda3d8']],
] as const)('取色器底部的六个主题色共用%s色板，点选保留透明度并即时保存', (colorMode, colors) => {
  useAppearanceStore.setState({ colorMode, interfaceSkin: 'sea', accent: '#12345680' })
  render(<AppearanceSection />)
  const trigger = screen.getByRole('button', { name: '选择颜色' })
  fireEvent.click(trigger)
  const dialog = screen.getByRole('dialog', { name: '强调色选择器' })
  const picker = within(dialog)
  const standard = picker.getByRole('group', { name: '预设色' })
  const themes = picker.getByRole('group', { name: '主题色' })
  expect(standard.compareDocumentPosition(themes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  const choices = within(themes)
  const names = ['墨色', '薄荷', '蜜蜂', '羊皮纸', '海盐', '暮紫']
  expect(choices.getAllByRole('button')).toHaveLength(6)
  expect(choices.queryAllByRole('button', { pressed: true })).toHaveLength(0)
  names.forEach((name, index) => {
    const choice = choices.getByRole('button', { name: `主题色 ${name}` })
    fireEvent.click(choice)
    expect(choice).toHaveAttribute('aria-pressed', 'true')
    expect(choices.getAllByRole('button', { pressed: true })).toHaveLength(1)
    expect(picker.getByRole('textbox', { name: 'HEX' })).toHaveValue(colors[index])
    expect(picker.getByRole('textbox', { name: 'A (%)' })).toHaveValue('50')
    expect(useAppearanceStore.getState()).toMatchObject({ accent: `${colors[index]}80`, interfaceSkin: 'sea', colorMode })
  })
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({ state: { accent: `${colors[5]}80` } })
  fireEvent.click(trigger)
  fireEvent.click(trigger)
  expect(within(screen.getByRole('group', { name: '主题色' })).getByRole('button', { name: '主题色 暮紫' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('textbox', { name: 'A (%)' })).toHaveValue('50')
})

it('取色器打开时切换明暗，主题色候选更新而自选颜色保持原值', () => {
  render(<AppearanceSection />)
  fireEvent.click(screen.getByRole('button', { name: '选择颜色' }))
  fireEvent.click(screen.getByRole('button', { name: '主题色 墨色' }))
  expect(useAppearanceStore.getState().accent).toBe('#171717')
  act(() => useAppearanceStore.getState().setColorMode('dark'))
  expect(screen.getByRole('button', { name: '主题色 墨色' })).toHaveAttribute('title', '墨色 #e5e5e5')
  expect(screen.getByRole('textbox', { name: 'HEX' })).toHaveValue('#171717')
  fireEvent.click(screen.getByRole('button', { name: '主题色 墨色' }))
  expect(screen.getByRole('textbox', { name: 'HEX' })).toHaveValue('#e5e5e5')
  expect(useAppearanceStore.getState().accent).toBe('#e5e5e5')
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

it('外壳不透明度滑杆默认禁用恢复钮，调整后显示百分比、即时保存并可恢复默认', () => {
  vi.stubGlobal('cogent', { backdropSupported: true })
  render(<AppearanceSection />)
  expect(screen.getByRole('group', { name: '外壳不透明度' })).toBeInTheDocument()
  const reset = screen.getByRole('button', { name: '恢复默认不透明度' })
  expect(screen.getByText('65%')).toBeInTheDocument()
  expect(reset).toBeDisabled()
  act(() => useAppearanceStore.getState().setShellOpacity(80))
  expect(screen.getByText('80%')).toBeInTheDocument()
  expect(reset).not.toBeDisabled()
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({ state: { shellOpacity: 80 } })
  fireEvent.click(reset)
  expect(useAppearanceStore.getState().shellOpacity).toBe(65)
  expect(screen.getByText('65%')).toBeInTheDocument()
  expect(reset).toBeDisabled()
})

it('不支持系统材质的平台隐藏外壳不透明度滑杆', () => {
  vi.stubGlobal('cogent', { backdropSupported: false })
  render(<AppearanceSection />)
  expect(screen.queryByRole('group', { name: '外壳不透明度' })).not.toBeInTheDocument()
})

it('代码设置独立成组，默认显示行号且不换行，重读缺省或无效值时保留默认行号', async () => {
  useAppearanceStore.setState({ showLineNumbers: true, codeWrap: false })
  render(<AppearanceSection />)
  const codeHeading = screen.getByText('代码')
  const chatHeading = screen.getByText('对话')
  expect(chatHeading.compareDocumentPosition(codeHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  const lineNumbers = screen.getByRole('switch', { name: '显示代码行号' })
  const wordWrap = screen.getByRole('switch', { name: '长行自动换行' })
  expect(lineNumbers).toHaveAttribute('aria-checked', 'true')
  expect(wordWrap).toHaveAttribute('aria-checked', 'false')

  fireEvent.click(lineNumbers)
  fireEvent.click(wordWrap)
  expect(useAppearanceStore.getState()).toMatchObject({ showLineNumbers: false, codeWrap: true })

  localStorage.setItem(storageKey, JSON.stringify({ state: { showLineNumbers: false }, version: 0 }))
  await act(() => useAppearanceStore.persist.rehydrate())
  expect(useAppearanceStore.getState().showLineNumbers).toBe(false)

  localStorage.setItem(storageKey, JSON.stringify({ state: {}, version: 0 }))
  await act(() => useAppearanceStore.persist.rehydrate())
  expect(useAppearanceStore.getState().showLineNumbers).toBe(true)
})
