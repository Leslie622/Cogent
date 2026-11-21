/** 测试入口共享于内置/自定义模型行，反馈必须带身份，并在请求中阻止重复触发。 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { ProviderModelRow } from '@/features/settings/ProviderModelRow'
import { useEngineStore } from '@/stores/engine'

vi.mock('sonner', () => ({ toast: { loading: vi.fn(() => 'probe'), success: vi.fn(), error: vi.fn() } }))
const previous = window.cogent
const original = useEngineStore.getState()
const request = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  useEngineStore.setState({ ...original, customProviders: [], models: [] })
  window.cogent = { ...previous, engineRequest: request } as typeof window.cogent
})
afterEach(() => { window.cogent = previous; useEngineStore.setState(original) })

function row(providerId = 'deepseek', enabled = true) {
  return render(<ProviderModelRow providerId={providerId} def={{ id: 'mock' }} enabled={enabled}
    onToggle={() => {}} onEdit={() => {}} />)
}

it('点击测试传供应商/模型双键，等待中禁止重复，成功反馈有耗时', async () => {
  let finish!: (value: { elapsedMs: number }) => void
  request.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  row()
  const button = screen.getByRole('button', { name: '测试模型 mock' })
  fireEvent.click(button)
  expect(button).toBeDisabled()
  fireEvent.click(button)
  await act(async () => { await Promise.resolve() })
  expect(request).toHaveBeenCalledExactlyOnceWith('models.test', { providerId: 'deepseek', modelId: 'mock' })
  await act(async () => { finish({ elapsedMs: 1250 }); await Promise.resolve() })
  expect(button).toBeEnabled()
  expect(toast.success).toHaveBeenCalledWith('模型连接成功：DeepSeek / mock', expect.objectContaining({ description: '耗时 1.25 秒' }))
})

it('失败显示接口错误，并可重新测试', async () => {
  request.mockRejectedValueOnce(new Error('403 Forbidden')).mockResolvedValueOnce({ elapsedMs: 20 })
  row()
  const button = screen.getByRole('button', { name: '测试模型 mock' })
  await act(async () => { fireEvent.click(button); await Promise.resolve() })
  expect(toast.error).toHaveBeenCalledWith('模型测试失败：DeepSeek / mock', expect.objectContaining({ description: '403 Forbidden' }))
  expect(button).toBeEnabled()
  await act(async () => { fireEvent.click(button); await Promise.resolve() })
  expect(toast.success).toHaveBeenCalledTimes(1)
})

it('禁用模型或供应商时不能发起探测', () => {
  const view = row('deepseek', false)
  expect(screen.getByRole('button', { name: '测试模型 mock' })).toBeDisabled()
  view.unmount()
  useEngineStore.setState({ customProviders: [{ id: 'custom/mock', name: 'Mock', baseUrl: '', models: ['mock'], disabled: true }] })
  row('custom/mock')
  expect(screen.getByRole('button', { name: '测试模型 mock' })).toBeDisabled()
  expect(request).not.toHaveBeenCalled()
})
