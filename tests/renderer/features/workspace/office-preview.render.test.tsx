/** Office入口验证不可信ZIP预算和原始字节异步代次；版式由各格式真实库/Electron验收。 */
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import OfficePreview, { validateOfficeArchive } from '@/features/home/files/visual/OfficePreview'

vi.mock('@/features/home/files/visual/DocxPreview', () => ({ default: ({ buffer }: { buffer: ArrayBuffer }) => <p>文档字节 {new Uint8Array(buffer)[0]}</p> }))
afterEach(() => vi.unstubAllGlobals())
const props = { name: 'a.docx', tabId: 'office', active: true, onOpenUrl: vi.fn() }
const archive = () => zipSync({ 'word/document.xml': strToU8('<document/>') }).buffer

describe('Office视觉入口', () => {
  it('扫描真实ZIP目录而不展开；坏包、大成员和过多条目明确拒绝', () => {
    expect(() => validateOfficeArchive(archive(), 'a.docx')).not.toThrow()
    expect(() => validateOfficeArchive(new ArrayBuffer(4), 'a.docx')).toThrow()
    const big = zipSync({ 'word/large.xml': new Uint8Array(33 * 1024 ** 2) })
    expect(() => validateOfficeArchive(big.buffer, 'a.docx')).toThrow('预算')
    const many = zipSync(Object.fromEntries(Array.from({ length: 4001 }, (_, i) => [String(i), new Uint8Array()])))
    expect(() => validateOfficeArchive(many.buffer, 'a.xlsx')).toThrow('预算')
    expect(() => validateOfficeArchive(new ArrayBuffer(4), 'legacy.doc')).not.toThrow()
  })
  it('替换URL中止旧fetch，迟到的旧字节不能覆盖新文件', async () => {
    let complete!: (response: Response) => void
    let signal!: AbortSignal
    vi.stubGlobal('fetch', vi.fn((url: string, options: RequestInit) => {
      if (url === 'blob:first') { signal = options.signal as AbortSignal; return new Promise(resolve => { complete = resolve }) }
      return Promise.resolve(new Response(archive()))
    }))
    const view = render(<OfficePreview {...props} url="blob:first" />)
    view.rerender(<OfficePreview {...props} url="blob:second" />)
    expect(signal.aborted).toBe(true)
    await screen.findByText('文档字节 80')
    await act(async () => { complete(new Response('old-broken')); await Promise.resolve() })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('文档字节 80')).toBeInTheDocument()
  })
  it('字节读取失败显示诊断，不显示空白成功查看器', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })))
    render(<OfficePreview {...props} url="blob:bad" />)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('字节加载失败'))
    expect(screen.queryByText(/文档字节/)).toBeNull()
  })
})
