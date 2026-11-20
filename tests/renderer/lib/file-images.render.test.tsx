/** 本地图片必须保留目标进入文件委托，不能被 Streamdown 的图片 URL 清洗静默丢弃。 */
import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
vi.mock('@/features/home/files/FileImage', () => ({ FileImage: ({ target }: { target: string }) => <span data-testid="local-image">{target}</span> }))
import { Markdown } from '@/components/ui/markdown'
import { FileLinkContext } from '@/features/home/files/FileLink'
it('相对图片进入本地委托；预览中的外部图片保持未加载', () => {
  render(<FileLinkContext.Provider value={{ sessionId: 's', turnId: 't', refs: [], preview: true, relativeTo: 'file' }}><Markdown content={'![本地图](./picture.png)\n\n![外部](https://example.com/a.png)'} /></FileLinkContext.Provider>)
  expect(screen.getByTestId('local-image')).toHaveTextContent('./picture.png')
  expect(screen.getByText('外部（外部资源未自动加载）')).toBeInTheDocument()
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
})
