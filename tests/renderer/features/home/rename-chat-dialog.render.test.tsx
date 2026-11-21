/** 重命名草稿、取消、外部保存失败与成功 toast 反馈的交互边界。 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { RenameChatDialog } from '@/features/home/RenameChatDialog'
import { useChatStore } from '@/stores/chat'

// 类型化 mock（hoisted：vi.mock 工厂提升到 import 前，普通 const 引用不到）
const { toastSuccess } = vi.hoisted(() => ({
  toastSuccess: vi.fn<(message: string, options?: unknown) => string | number>()
}))
vi.mock('sonner', () => ({ toast: { success: toastSuccess } }))

const initial = useChatStore.getState()
const chat = { id: 'chat', title: '原名称', createdAt: 1, updatedAt: 2 }
afterEach(() => {
  useChatStore.setState(initial, true)
  toastSuccess.mockClear()
})

it('空白禁用，取消不提交、不弹 toast', async () => {
  const rename = vi.fn()
  const close = vi.fn()
  useChatStore.setState({ rename })
  render(<RenameChatDialog chat={chat} onClose={close} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '  ' } })
  expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
  await userEvent.click(screen.getByRole('button', { name: '取消' }))
  expect(close).toHaveBeenCalledOnce()
  expect(rename).not.toHaveBeenCalled()
  expect(toastSuccess).not.toHaveBeenCalled()
})

it('保存失败保留草稿并展示错误，可重试，保存中不重复提交', async () => {
  let reject!: (error: Error) => void
  const rename = vi.fn().mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail }))
    .mockResolvedValueOnce(undefined)
  const close = vi.fn()
  useChatStore.setState({ rename })
  render(<RenameChatDialog chat={chat} onClose={close} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '新名称' } })
  fireEvent.submit(screen.getByRole('textbox').closest('form')!)
  expect(screen.getByRole('button', { name: '保存中…' })).toBeDisabled()
  reject(new Error('磁盘写入失败'))
  await screen.findByRole('alert')
  expect(screen.getByRole('alert')).toHaveTextContent('磁盘写入失败')
  expect(screen.getByRole('textbox')).toHaveValue('新名称')
  expect(close).not.toHaveBeenCalled()
  expect(toastSuccess).not.toHaveBeenCalled()
  fireEvent.submit(screen.getByRole('textbox').closest('form')!)
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(rename).toHaveBeenCalledTimes(2)
})

it('保存成功弹「重命名成功」短语 toast，不带详情', async () => {
  const rename = vi.fn().mockResolvedValue(undefined)
  const close = vi.fn()
  useChatStore.setState({ rename })
  render(<RenameChatDialog chat={chat} onClose={close} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '新名称' } })
  fireEvent.submit(screen.getByRole('textbox').closest('form')!)
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(toastSuccess).toHaveBeenCalledTimes(1)
  const [message, options] = toastSuccess.mock.calls[0]
  expect(message).toBe('重命名成功')
  expect((options as { description?: string } | undefined)?.description).toBeUndefined()
})
