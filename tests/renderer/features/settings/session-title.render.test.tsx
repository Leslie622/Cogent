/** 真实标题控件读取 Host 策略，持久化成功才更新；同名模型按双键选择。 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionTitleSettings } from '@/features/settings/SessionTitleSettings'
import { useEngineStore } from '@/stores/engine'

const previous = window.cogent
const original = useEngineStore.getState()
const request = vi.fn()
beforeEach(() => {
  request.mockReset().mockResolvedValue({ enabled: true })
  window.cogent = { ...previous, engineRequest: request } as typeof window.cogent
  useEngineStore.setState({ customProviders: [], models: ['a', 'b'].map((name) => ({
    provider: `custom/${name}`, id: 'same', name: 'same', reasoning: false, thinkingLevels: ['off'], contextWindow: 8192, maxTokens: 256
  })) })
})
afterEach(() => { window.cogent = previous; useEngineStore.setState(original) })

it('首次只读取 Host；开关与模型保存成功后回显', async () => {
  const user = userEvent.setup()
  render(<SessionTitleSettings />)
  const toggle = screen.getByRole('switch', { name: '自动生成会话名称' })
  await waitFor(() => expect(toggle).toBeChecked())
  expect(request).toHaveBeenCalledExactlyOnceWith('session.titleSettings.get', {})
  const select = screen.getByRole('combobox', { name: '标题模型' })
  await user.click(select)
  request.mockResolvedValueOnce({ enabled: true, model: { provider: 'custom/b', id: 'same' } })
  await user.click(await screen.findByRole('option', { name: 'custom/b / same' }))
  expect(request).toHaveBeenLastCalledWith('session.titleSettings.set', { enabled: true, model: { provider: 'custom/b', id: 'same' } })
  await waitFor(() => expect(select).toHaveTextContent('custom/b / same'))
  request.mockResolvedValueOnce({ enabled: false, model: { provider: 'custom/b', id: 'same' } })
  await user.click(toggle)
  await waitFor(() => expect(toggle).not.toBeChecked())
  expect(select).toBeDisabled()
})

it('保存挂起时阻止重复，失败保持旧值并显示原因，能重新读取', async () => {
  render(<SessionTitleSettings />)
  const toggle = screen.getByRole('switch', { name: '自动生成会话名称' })
  await waitFor(() => expect(toggle).toBeChecked())
  let fail!: (reason: Error) => void
  request.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
  fireEvent.click(toggle)
  expect(toggle).toHaveAttribute('aria-disabled', 'true')
  expect(toggle).toBeChecked()
  await act(async () => { fail(new Error('磁盘只读')); await Promise.resolve() })
  expect(toggle).toBeChecked()
  expect(screen.getByRole('alert')).toHaveTextContent('磁盘只读')
  fireEvent.click(screen.getByRole('button', { name: '重新读取' }))
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
})

it('初次读取失败允许重试；旧配置模型被删除时不假装选中跟随模型', async () => {
  request.mockRejectedValueOnce(new Error('Host 尚未就绪'))
  render(<SessionTitleSettings />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Host 尚未就绪')
  request.mockResolvedValueOnce({ enabled: true, model: { provider: 'missing', id: 'removed' } })
  fireEvent.click(screen.getByRole('button', { name: '重新读取' }))
  await waitFor(() => expect(screen.getByRole('combobox', { name: '标题模型' })).toHaveTextContent('missing / removed（不可用）'))
})
