/** 字体设置回归：浏览器列出的字体族要能搜索、选择、持久化并进入现有正文样式。 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AppearanceSection } from '@/features/settings/AppearanceSection'
import { compileTokens } from '@/lib/theme/compile'
import { buildUserTokens, useAppearanceStore } from '@/stores/appearance'
import { useThemeStore } from '@/stores/theme'

const storageKey = 'cogent-appearance'
const defaults = { latin: 'theme', cjk: 'theme' } as const

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }))
})

afterEach(() => {
  cleanup()
  useAppearanceStore.setState({ contentFont: defaults, codeFont: defaults, colorMode: 'light' })
  useThemeStore.setState({ themes: [], activeThemeId: 'default' })
  localStorage.removeItem(storageKey)
  localStorage.removeItem('cogent-themes')
  vi.unstubAllGlobals()
})

it('弹窗不聚焦搜索框，正文和代码的中英文可独立搜索、选择和保存', async () => {
  const queryLocalFonts = vi.fn().mockResolvedValue([
    { family: '霞鹜文楷', style: 'Regular' },
    { family: '霞鹜文楷', style: 'Bold' },
    { family: 'Segoe UI' },
    { family: "Designer, Studio's Mono" },
  ])
  vi.stubGlobal('queryLocalFonts', queryLocalFonts)
  render(<AppearanceSection />)
  expect(queryLocalFonts).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: '设置内容字体' }))
  const content = within(screen.getByRole('dialog', { name: '内容字体' }))
  const latin = content.getByRole('tab', { name: '英文字体' })
  const latinSearch = content.getByRole('combobox', { name: '搜索英文字体' })
  await waitFor(() => expect(latin).toHaveFocus())
  expect(latinSearch).toHaveValue('')
  await content.findByRole('option', { name: '霞鹜文楷' })
  expect(content.getAllByRole('option', { name: 'Segoe UI' })).toHaveLength(1)
  fireEvent.click(content.getByRole('option', { name: 'Segoe UI' }))
  fireEvent.click(content.getByRole('tab', { name: '中文字体' }))
  const cjkSearch = content.getByRole('combobox', { name: '搜索中文字体' })
  expect(cjkSearch).not.toHaveFocus()
  fireEvent.change(cjkSearch, { target: { value: '文楷' } })
  expect(content.queryByRole('option', { name: "Designer, Studio's Mono" })).not.toBeInTheDocument()
  expect(content.getAllByRole('option', { name: '霞鹜文楷' })).toHaveLength(1)
  fireEvent.click(content.getByRole('option', { name: '霞鹜文楷' }))
  expect(useAppearanceStore.getState().contentFont).toEqual(defaults)
  expect(content.getByRole('region', { name: '字体预览' }).querySelector('[style]')).toHaveStyle({
    fontFamily: "'Segoe UI', '霞鹜文楷', 'Microsoft YaHei', sans-serif",
  })
  fireEvent.click(content.getByRole('button', { name: '保存' }))
  expect(useAppearanceStore.getState().contentFont).toEqual({ latin: 'local:Segoe UI', cjk: 'local:霞鹜文楷' })

  fireEvent.click(screen.getByRole('button', { name: '设置代码字体' }))
  const code = within(screen.getByRole('dialog', { name: '代码字体' }))
  fireEvent.change(code.getByRole('combobox', { name: '搜索英文字体' }), { target: { value: 'designer' } })
  fireEvent.click(code.getByRole('option', { name: "Designer, Studio's Mono" }))
  fireEvent.click(code.getByRole('tab', { name: '中文字体' }))
  fireEvent.click(code.getByRole('option', { name: '霞鹜文楷' }))
  expect(useAppearanceStore.getState().codeFont).toEqual(defaults)
  fireEvent.click(code.getByRole('button', { name: '保存' }))
  expect(queryLocalFonts).toHaveBeenCalledTimes(1)

  const vars = compileTokens(buildUserTokens(useAppearanceStore.getState()))
  expect(vars['--t-root-font']).toMatch(/^'Segoe UI', '霞鹜文楷', /)
  expect(vars['--t-code-font']).toMatch(/^'Designer, Studio\\27 s Mono', '霞鹜文楷', /)
  expect(vars['--t-inline-code-font']).toBe(vars['--t-code-font'])
  const saved = localStorage.getItem(storageKey)
  expect(saved).toContain('local:Designer, Studio')
  await act(() => useAppearanceStore.setState({ contentFont: defaults, codeFont: defaults }))
  localStorage.setItem(storageKey, saved!)
  await act(() => useAppearanceStore.persist.rehydrate())
  expect(useAppearanceStore.getState().codeFont).toEqual({ latin: "local:Designer, Studio's Mono", cjk: 'local:霞鹜文楷' })
  expect(useAppearanceStore.getState().contentFont).toEqual({ latin: 'local:Segoe UI', cjk: 'local:霞鹜文楷' })
})

it('旧预设迁移为两槽，系统字体目录不可用时可独立恢复其中一槽', async () => {
  localStorage.setItem(storageKey, JSON.stringify({ state: { contentFont: 'segoe', codeFont: 'consolas' }, version: 0 }))
  await act(() => useAppearanceStore.persist.rehydrate())
  expect(useAppearanceStore.getState().contentFont).toEqual({ latin: 'local:Segoe UI', cjk: 'local:Microsoft YaHei' })
  expect(useAppearanceStore.getState().codeFont).toEqual({ latin: 'local:Consolas', cjk: 'theme' })

  localStorage.setItem(storageKey, JSON.stringify({ state: { contentFont: 'local:旧字体', codeFont: 'consolas' }, version: 0 }))
  await act(() => useAppearanceStore.persist.rehydrate())
  expect(useAppearanceStore.getState().contentFont).toEqual({ latin: 'local:旧字体', cjk: 'theme' })
  useAppearanceStore.getState().setContentFont({ latin: 'local:旧字体', cjk: 'local:SimSun' })
  vi.stubGlobal('queryLocalFonts', vi.fn().mockRejectedValue(new Error('permission denied')))
  render(<AppearanceSection />)

  expect(screen.getByRole('button', { name: '设置内容字体' })).toHaveTextContent('旧字体')
  expect(screen.getByRole('button', { name: '设置代码字体' })).toHaveTextContent('Consolas')
  fireEvent.click(screen.getByRole('button', { name: '设置内容字体' }))
  expect(await screen.findByText('无法读取系统字体，重新打开重试')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('option', { name: 'Inter · 默认' }))
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  const userTokens = buildUserTokens(useAppearanceStore.getState())
  expect(Object.keys(userTokens)).not.toContain('root.fontLatin')
  expect(userTokens['root.fontCjk']).toBe("'SimSun'")
  expect(Object.keys(userTokens)).not.toContain('codeBlock.fontCjk')
})

it('取消、关闭和 Escape 都丢弃草稿，再次打开仍显示已保存的字体', async () => {
  vi.stubGlobal('queryLocalFonts', vi.fn().mockResolvedValue([]))
  render(<AppearanceSection />)
  const originalStorage = localStorage.getItem(storageKey)
  for (const action of ['取消', 'Close', 'Escape']) {
    fireEvent.click(screen.getByRole('button', { name: '设置内容字体' }))
    const dialog = screen.getByRole('dialog', { name: '内容字体' })
    const picker = within(dialog)
    expect(picker.getByLabelText('已选英文字体')).toHaveTextContent('Inter')
    fireEvent.click(picker.getByRole('option', { name: 'Georgia' }))
    expect(picker.getByLabelText('已选英文字体')).toHaveTextContent('Georgia')
    if (action === 'Escape') fireEvent.keyDown(picker.getByRole('combobox', { name: '搜索英文字体' }), { key: 'Escape', code: 'Escape' })
    else fireEvent.click(picker.getByRole('button', { name: action }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '内容字体' })).not.toBeInTheDocument())
    expect(useAppearanceStore.getState().contentFont).toEqual(defaults)
    expect(localStorage.getItem(storageKey)).toBe(originalStorage)
  }
})

it('默认值回显当前样式的真实配置，明暗切换后更新且不把默认值固化为自选字体', () => {
  vi.stubGlobal('queryLocalFonts', vi.fn().mockResolvedValue([]))
  useThemeStore.getState().importTheme(JSON.stringify({
    version: 1, id: 'custom-fonts', name: '阅读样式',
    tokens: { 'root.fontLatin': 'Georgia', 'root.fontCjk': 'SimSun', 'codeBlock.fontLatin': 'Consolas' },
    dark: { 'root.fontLatin': 'Arial', 'root.fontCjk': 'Microsoft YaHei', 'codeBlock.fontLatin': 'Cascadia Code' },
  }))
  render(<AppearanceSection />)
  expect(screen.getByRole('button', { name: '设置内容字体' })).toHaveTextContent('Georgia / SimSun')
  fireEvent.click(screen.getByRole('button', { name: '设置内容字体' }))
  const picker = within(screen.getByRole('dialog', { name: '内容字体' }))
  expect(picker.getByText('默认字体来自「对话内容」样式：阅读样式。')).toBeInTheDocument()
  expect(picker.getByRole('option', { name: 'Georgia · 默认' })).toHaveAttribute('aria-selected', 'true')
  act(() => useAppearanceStore.getState().setColorMode('dark'))
  expect(picker.getByLabelText('已选英文字体')).toHaveTextContent('Arial')
  expect(picker.getByLabelText('已选中文字体')).toHaveTextContent('Microsoft YaHei')
  expect(picker.getByRole('option', { name: 'Arial · 默认' })).toBeInTheDocument()
  fireEvent.click(picker.getByRole('button', { name: '保存' }))
  expect(useAppearanceStore.getState().contentFont).toEqual(defaults)
  expect(screen.getByRole('button', { name: '设置代码字体' })).toHaveTextContent('Cascadia Code')
})
