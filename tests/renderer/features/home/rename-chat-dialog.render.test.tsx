/** 重命名草稿、取消与外部保存失败的交互边界。 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { RenameChatDialog } from '@/features/home/RenameChatDialog'
import { useChatStore } from '@/stores/chat'

const initial = useChatStore.getState()
const chat = { id: 'chat', title: '原名称', createdAt: 1, updatedAt: 2 }
afterEach(() => useChatStore.setState(initial, true))

it('空白禁用，取消不提交', async () => {
  const rename = vi.fn()
  const close = vi.fn()
  useChatStore.setState({ rename })
  render(<RenameChatDialog chat={chat} onClose={close} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '  ' } })
  expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
  await userEvent.click(screen.getByRole('button', { name: '取消' }))
  expect(close).toHaveBeenCalledOnce()
  expect(rename).not.toHaveBeenCalled()
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
  fireEvent.submit(screen.getByRole('textbox').closest('form')!)
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(rename).toHaveBeenCalledTimes(2)
})
