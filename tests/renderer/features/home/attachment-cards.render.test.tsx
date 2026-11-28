/** 图片卡不显示文件详情，历史按图片/文件分行并保持用户消息的右侧对齐。 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AttachmentCards, isReferenceOnlyAttachment } from '@/features/home/AttachmentCards'
import { AttachmentRejections } from '@/features/home/AttachmentRejections'
import { MessageRow } from '@/features/home/MessageRow'
import type { DraftAttachment } from '@/stores/attachments'
import type { AttachmentRef, DirectoryRef } from '@shared/attachments'

const previous = window.cogent
const image: AttachmentRef = { id: '11111111-1111-1111-1111-111111111111', name: '截图.png', size: 4096, mime: 'image/png', sha256: 'a'.repeat(64) }
const file: AttachmentRef = { ...image, id: '22222222-2222-2222-2222-222222222222', name: '说明.txt', mime: 'text/plain' }
const item = (ref: AttachmentRef): DraftAttachment => ({ key: ref.id, ref, name: ref.name, size: ref.size, status: 'ready' })
const request = vi.fn()
beforeEach(() => {
  request.mockReset().mockResolvedValue({ ref: image, path: 'managed' })
  window.cogent = { ...previous, engineRequest: request, attachmentPreview: () => Promise.resolve('data:image/png;base64,cGljdHVyZQ==') } as typeof window.cogent
})
afterEach(() => { cleanup(); window.cogent = previous })

describe('附件图片布局', () => {
  it('目录卡显示文件夹与路径，无大小/另存，纯目录消息不会落空白气泡', async () => {
    const directory: DirectoryRef = { kind: 'directory', name: '资料.png', path: 'C:/资料.png' }
    request.mockResolvedValue(directory)
    const openPath = vi.fn().mockResolvedValue(null); window.cogent.openPath = openPath
    const { container } = render(<MessageRow message={{ id: 'dir-u', role: 'user', content: '', timestamp: 1, directories: [directory] }} />)
    expect(screen.getByText(directory.name)).toBeInTheDocument()
    expect(screen.getByText(directory.path)).toBeInTheDocument()
    expect(container.querySelector('[data-slot=attachment]')).toHaveAttribute('data-variant','file')
    expect(container.querySelector('[data-slot=bubble]')).toBeNull()
    expect(screen.queryByText('0 B')).not.toBeInTheDocument()
    expect(screen.queryByRole('button',{name:/另存/})).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button',{name:'打开文件夹 资料.png'})); await waitFor(() => expect(openPath).toHaveBeenCalledWith(directory.path))
  })
  it('未添加反馈能展开看到每个文件及原因，清除只处理提示', async () => {
    const clear = vi.fn()
    render(<AttachmentRejections items={[{ name: '超额图片.png', reason: '每条消息最多添加 20 张图片' },{ name: '过大.txt', reason: '单文件超限' }]} onClear={clear} />)
    expect(screen.getByRole('alert')).toHaveTextContent('2 个文件未添加')
    fireEvent.click(screen.getByRole('button',{ name: '查看未添加的文件' }))
    expect(await screen.findByText('超额图片.png')).toBeInTheDocument()
    expect(screen.getByText('过大.txt')).toBeInTheDocument()
    expect(screen.getByText(/每条消息最多添加 20 张图片/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button',{ name: '清除未添加提示' })); expect(clear).toHaveBeenCalledOnce()
  })
  it.each([false, true])('文件卡仅显示名称与大小，不展示内部处理说明（历史=%s）', async (history) => {
    const { container } = render(<AttachmentCards items={[item(file)]} history={history} />)
    await waitFor(() => expect(request).toHaveBeenCalled())
    expect(screen.getByText(file.name)).toBeInTheDocument()
    const description = container.querySelector('[data-slot=attachment-description]')!
    expect(description).toHaveTextContent(/^4\.1 KB$/)
    expect(description).not.toHaveAttribute('title')
    expect(screen.queryByText(/已保存|文档工具|按需|读取过程|未解析/)).not.toBeInTheDocument()
  })
  it('输入图片只显示方形缩略图和移除操作，不显示文件详情', async () => {
    const remove = vi.fn()
    const { container } = render(<AttachmentCards items={[item(image)]} onRemove={remove} />)
    await screen.findByAltText(image.name)
    expect(container.querySelector('[data-slot=attachment]')).toHaveAttribute('data-variant', 'image')
    expect(container.querySelector('[data-slot=attachment-content]')).toBeNull()
    expect(screen.queryByText('截图.png')).not.toBeInTheDocument()
    expect(screen.queryByText(/KB|图片随消息发送/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '移除 截图.png' }))
    expect(remove).toHaveBeenCalledWith(image.id)
  })
  it('历史图片和普通文件分行靠右，正文仍在附件下方', async () => {
    const { container } = render(<MessageRow message={{ id: 'u1', role: 'user', content: '这两张是什么？', timestamp: 1,
      attachments: [image, { ...image, id: '33333333-3333-3333-3333-333333333333', name: '另一张.png' }, file] }} />)
    await screen.findByAltText(image.name)
    const group = container.querySelector('[data-slot=message-attachments]')!
    expect(group).toHaveClass('self-end')
    const rows = group.querySelectorAll('[data-slot=attachment-group]')
    expect(rows).toHaveLength(2)
    for (const row of rows) { expect(row).toHaveAttribute('data-layout', 'wrap'); expect(row).toHaveAttribute('data-align', 'end') }
    expect(rows[0].querySelectorAll('[data-variant=image][data-slot=attachment]')).toHaveLength(2)
    expect(rows[1]).toHaveTextContent(file.name)
    expect(group.nextElementSibling).toHaveAttribute('data-slot', 'bubble')
    expect(screen.queryByRole('button', { name: '定位 截图.png' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '定位 说明.txt' })).toBeInTheDocument()
  })
  it('导入中和失败图片也保持方形，失败原因和重试仍可访问', async () => {
    const retry = vi.fn()
    const pending: DraftAttachment = { key: 'pending', name: '未完成.png', size: 0, status: 'importing' }
    const { container, rerender } = render(<AttachmentCards items={[pending]} onRetry={retry} />)
    expect(container.querySelector('[data-slot=attachment]')).toHaveAttribute('data-variant', 'image')
    expect(screen.getByRole('status')).toHaveTextContent('导入中')
    rerender(<AttachmentCards items={[{ ...pending, status: 'error', error: '图片格式损坏' }]} onRetry={retry} />)
    expect(screen.getByRole('alert')).toHaveAttribute('title', '图片格式损坏')
    fireEvent.click(screen.getByRole('button', { name: '重试 未完成.png' }))
    expect(retry).toHaveBeenCalledWith('pending')
    await waitFor(() => expect(container.querySelector('[data-slot=attachment-content]')).toBeNull())
  })
})

describe('“作为文件发送”按事实判定', () => {
  it('模型不能原生接收且宿主没有本地解析器时为真；原生图片和可本地提取的文档为假', () => {
    const video: AttachmentRef = { ...image, name: '片段.mp4', mime: 'video/mp4' }
    const pdf: AttachmentRef = { ...image, name: '说明.pdf', mime: 'application/pdf' }
    expect(isReferenceOnlyAttachment(image, false)).toBe(true)
    expect(isReferenceOnlyAttachment(image, true)).toBe(false)
    expect(isReferenceOnlyAttachment(video, true)).toBe(true)
    expect(isReferenceOnlyAttachment(file, false)).toBe(false)
    expect(isReferenceOnlyAttachment(pdf, false)).toBe(false)
  })
})
