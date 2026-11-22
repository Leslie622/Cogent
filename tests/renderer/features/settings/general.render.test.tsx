/** 常规对话偏好的真实控件接线、即时消费与持久化边界。 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GeneralSection } from '@/features/settings/GeneralSection'
import { RunTrace, WorkingLine } from '@/components/ui/run-trace'
import { MessageScrollerProvider } from '@/components/ui/message-scroller'
import { Reasoning } from '@/components/ui/reasoning'
import { UsageLine } from '@/features/home/MessageRow'
import { useAppearanceStore } from '@/stores/appearance'

const storageKey = 'cogent-appearance'
const defaults = { outputVerbosity: 'high', durationPrecision: 2 } as const

beforeEach(() => {
  useAppearanceStore.setState(defaults)
})

afterEach(() => {
  cleanup()
  useAppearanceStore.setState(defaults)
  localStorage.removeItem(storageKey)
  vi.useRealTimers()
})

it('对话区块缺省详细 / 两位小数，实际选择即时保存，重读后仍保留', async () => {
  const user = userEvent.setup()
  const openOptions = async (trigger: HTMLElement) => {
    await user.click(trigger)
    // Base UI 将鼠标打开排到下一动画帧；点击完成不代表 listbox 已经提交。
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'true'))
    return within(await screen.findByRole('listbox'))
  }
  const closed = async (trigger: HTMLElement) => {
    await waitFor(() => {
      expect(trigger).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    })
  }
  render(<GeneralSection />)
  expect(screen.getByRole('heading', { name: '对话' })).toBeVisible()
  const verbosity = screen.getByRole('combobox', { name: '输出详细程度' })
  const precision = screen.getByRole('combobox', { name: '耗时显示格式' })
  expect(verbosity).toHaveTextContent('详细')
  expect(precision).toHaveTextContent('2 位小数')

  const verbosityOptions = await openOptions(verbosity)
  expect(verbosityOptions.getAllByRole('option').map((option) => option.textContent)).toEqual(['简洁', '详细'])
  await user.click(await verbosityOptions.findByRole('option', { name: '简洁' }))
  await closed(verbosity)
  expect(verbosity).toHaveTextContent('简洁')
  expect(useAppearanceStore.getState().outputVerbosity).toBe('low')
  for (const [label, value] of [['整数', 0], ['1 位小数', 1], ['2 位小数', 2]] as const) {
    const precisionOptions = await openOptions(precision)
    await user.click(await precisionOptions.findByRole('option', { name: label }))
    await closed(precision)
    expect(precision).toHaveTextContent(label)
    expect(useAppearanceStore.getState().durationPrecision).toBe(value)
  }
  const precisionOptions = await openOptions(precision)
  await user.click(await precisionOptions.findByRole('option', { name: '整数' }))
  await closed(precision)
  const saved = localStorage.getItem(storageKey)!
  expect(JSON.parse(saved)).toMatchObject({ state: { outputVerbosity: 'low', durationPrecision: 0 } })
  act(() => { useAppearanceStore.setState(defaults) })
  localStorage.setItem(storageKey, saved)
  await act(() => useAppearanceStore.persist.rehydrate())
  expect(verbosity).toHaveTextContent('简洁')
  expect(precision).toHaveTextContent('整数')
})

it.each([
  [{}, defaults],
  [{ outputVerbosity: 'unknown', durationPrecision: 3 }, defaults],
  [{ outputVerbosity: null, durationPrecision: '1' }, defaults],
  [{ outputVerbosity: 'low', durationPrecision: 0 }, { outputVerbosity: 'low', durationPrecision: 0 }],
  [{ outputVerbosity: 'high', durationPrecision: 1 }, { outputVerbosity: 'high', durationPrecision: 1 }],
])('旧档 / 非法值与合法值重读遵循受控值域：%j', async (stored, expected) => {
  localStorage.setItem(storageKey, JSON.stringify({ state: stored, version: 0 }))
  await act(() => useAppearanceStore.persist.rehydrate())
  expect(useAppearanceStore.getState()).toMatchObject(expected)
})

it('精度切换同步更新完成头条、思考和模型 / 工具统计；长耗时自动换单位', () => {
  render(<>
    <RunTrace phase="done" durationMs={65_350} />
    <Reasoning text="思考内容" running={false} durationMs={2_350} />
    <UsageLine durationMs={65_350} toolMs={3_725_350} />
  </>)
  expect(screen.getByText('已工作 1m 5.35s')).toBeVisible()
  expect(screen.getByText('持续了 2.35s')).toBeVisible()
  expect(screen.getByText('1m 5.35s 模型 · 1h 2m 工具')).toBeVisible()
  act(() => useAppearanceStore.getState().setDurationPrecision(0))
  expect(screen.getByText('已工作 1m 5s')).toBeVisible()
  expect(screen.getByText('持续了 2s')).toBeVisible()
  expect(screen.getByText('1m 5s 模型 · 1h 2m 工具')).toBeVisible()
})

it('进行中的码表也消费精度，切档不重置计时起点', () => {
  vi.useFakeTimers()
  vi.setSystemTime(65_350)
  render(<MessageScrollerProvider><WorkingLine startTs={0} /></MessageScrollerProvider>)
  expect(screen.getByText('1m 5.35s')).toBeVisible()
  act(() => useAppearanceStore.getState().setDurationPrecision(1))
  expect(screen.getByText('1m 5.4s')).toBeVisible()
  act(() => { vi.advanceTimersByTime(1_000) })
  expect(screen.getByText('1m 6.4s')).toBeVisible()
})

it.each([false, true])('简洁模式移除思考全文和流式摘要，切回详细恢复（running=%s）', (running) => {
  const { container } = render(<Reasoning
    text="思考详情第一行\n最新思考摘要" running={running} defaultOpen={!running} durationMs={2_350}
  />)
  expect(container).toHaveTextContent('思考详情第一行')
  act(() => useAppearanceStore.getState().setOutputVerbosity('low'))
  expect(screen.getByText(running ? '正在思考' : '思考')).toBeVisible()
  expect(container).not.toHaveTextContent('最新思考摘要')
  expect(container).not.toHaveTextContent('思考详情第一行')
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  expect(container.querySelector('[data-slot="trace-collapsible-content"]')).toBeNull()
  act(() => useAppearanceStore.getState().setOutputVerbosity('high'))
  expect(screen.getByRole('button', { name: /思考/ })).toBeVisible()
  expect(container).toHaveTextContent('思考详情第一行')
  expect(container).toHaveTextContent('最新思考摘要')
})

it('简洁模式隐藏单条与回合聚合统计，包括 token、缓存、成本和模型 / 工具耗时', () => {
  const usage = { input: 120, output: 50, cacheRead: 80, cacheWrite: 20, totalTokens: 270, totalCost: 0.0012 }
  const { container } = render(<>
    <UsageLine usage={usage} durationMs={2_350} />
    <UsageLine usage={usage} durationMs={65_350} toolMs={3_725_350} />
  </>)
  expect(container).toHaveTextContent('↑ 120')
  expect(container).toHaveTextContent('↓ 50')
  expect(container).toHaveTextContent('缓存读 80')
  expect(container).toHaveTextContent('$0.0012')
  expect(container).toHaveTextContent('1h 2m 工具')
  act(() => useAppearanceStore.getState().setOutputVerbosity('low'))
  expect(container).toBeEmptyDOMElement()
  act(() => useAppearanceStore.getState().setOutputVerbosity('high'))
  expect(container).toHaveTextContent('↑ 120')
  expect(container).toHaveTextContent('缓存写 20')
  expect(container).toHaveTextContent('$0.0012')
  expect(container).toHaveTextContent('1h 2m 工具')
})
