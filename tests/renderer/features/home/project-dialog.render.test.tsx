/** 创建项目失败走全局提示，保留表单与目录。 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { showErrorToast } from '@/components/ui/sonner'
import { ProjectDialog } from '@/features/home/ProjectDialog'
import { useProjectStore } from '@/stores/project'

vi.mock('@/components/ui/sonner', () => ({ showErrorToast: vi.fn() }))

const initialProject = useProjectStore.getState()
afterEach(() => {
  useProjectStore.setState(initialProject, true)
  vi.unstubAllGlobals()
})

it('创建写入失败保留表单，重试成功后才通知新项目并关闭', async () => {
  const path = 'C:/workspace'
  const request = vi.fn()
    .mockRejectedValueOnce(new Error('项目无法写入'))
    .mockResolvedValueOnce({ summary: { id: 'created', name: '当前项目', cwds: [path], createdAt: 1, updatedAt: 1 } })
  vi.stubGlobal('cogent', { pickDirectory: () => Promise.resolve(path), engineRequest: request })
  const onOpenChange = vi.fn()
  const onCreated = vi.fn()
  render(<ProjectDialog open onOpenChange={onOpenChange} onCreated={onCreated} />)

  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  fireEvent.change(screen.getByPlaceholderText('项目名称'), { target: { value: '当前项目' } })
  fireEvent.click(screen.getByRole('button', { name: '添加文件夹' }))
  await screen.findByRole('button', { name: `移除 ${path}` })
  fireEvent.click(within(screen.getByRole('dialog', { name: '创建项目' })).getByRole('button', { name: '创建项目' }))
  fireEvent.click(screen.getByRole('button', { name: '信任文件夹' }))

  await waitFor(() => expect(showErrorToast).toHaveBeenCalledExactlyOnceWith('项目无法写入'))
  expect(screen.getByPlaceholderText('项目名称')).toHaveValue('当前项目')
  expect(screen.getByRole('button', { name: `移除 ${path}` })).toBeInTheDocument()
  expect(onCreated).not.toHaveBeenCalled()
  expect(onOpenChange).not.toHaveBeenCalled()
  expect(useProjectStore.getState().projects).toEqual([])

  fireEvent.click(within(screen.getByRole('dialog', { name: '创建项目' })).getByRole('button', { name: '创建项目' }))
  fireEvent.click(screen.getByRole('button', { name: '信任文件夹' }))
  await waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith('created'))
  expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false)
})
