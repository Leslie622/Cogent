/** 标题设置只提供开关；读取不回写，持久化成功才更新，失败可重试。 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionTitleSettings } from '@/features/settings/SessionTitleSettings'

const previous = window.cogent
const request = vi.fn()
beforeEach(() => {
  request.mockReset().mockResolvedValue({ enabled: true })
  window.cogent = { ...previous, engineRequest: request } as typeof window.cogent
})
afterEach(() => { window.cogent = previous })

it('首次只读取 Host；仅提供开关，关闭与开启保存成功后回显', async () => {
  const user = userEvent.setup()
  render(<SessionTitleSettings />)
  const toggle = screen.getByRole('switch', { name: '自动生成会话名称' })
  await waitFor(() => expect(toggle).toBeChecked())
  expect(request).toHaveBeenCalledExactlyOnceWith('session.titleSettings.get', {})
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  expect(screen.queryByText('标题模型')).not.toBeInTheDocument()
  request.mockResolvedValueOnce({ enabled: false })
  await user.click(toggle)
  expect(request).toHaveBeenLastCalledWith('session.titleSettings.set', { enabled: false })
  await waitFor(() => expect(toggle).not.toBeChecked())
  request.mockResolvedValueOnce({ enabled: true })
  await user.click(toggle)
  expect(request).toHaveBeenLastCalledWith('session.titleSettings.set', { enabled: true })
  await waitFor(() => expect(toggle).toBeChecked())
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

it('初次读取失败允许重试；旧响应的模型字段不展示也不随开关回写', async () => {
  request.mockRejectedValueOnce(new Error('Host 尚未就绪'))
  render(<SessionTitleSettings />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Host 尚未就绪')
  request.mockResolvedValueOnce({ enabled: true, model: { provider: 'missing', id: 'removed' } })
  fireEvent.click(screen.getByRole('button', { name: '重新读取' }))
  const toggle = screen.getByRole('switch', { name: '自动生成会话名称' })
  await waitFor(() => expect(toggle).toBeChecked())
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  expect(screen.queryByText(/missing/)).not.toBeInTheDocument()
  request.mockResolvedValueOnce({ enabled: false })
  fireEvent.click(toggle)
  await waitFor(() => expect(toggle).not.toBeChecked())
  expect(request).toHaveBeenLastCalledWith('session.titleSettings.set', { enabled: false })
})
