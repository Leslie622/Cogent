/** 真实 docx-preview 解析 OOXML：验收分页版式、非文本内容与文档链接边界。 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import DocxPreview from '@/features/home/files/visual/DocxPreview'
import { useWorkspaceStore } from '@/stores/workspace'
import { useFilePreviewStore } from '@/stores/file-preview'

const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const relationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const paragraph = (text: string) => `<w:p><w:r><w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="Microsoft YaHei"/></w:rPr><w:t>${text}</w:t></w:r></w:p>`
const section = (margin: number) => `<w:sectPr><w:headerReference w:type="default" r:id="header"/><w:footerReference w:type="default" r:id="footer"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="${margin}" w:right="${margin}" w:bottom="${margin}" w:left="${margin}"/></w:sectPr>`
async function fixture() {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)
  zip.file('_rels/.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="document" Type="${relationships}/officeDocument" Target="word/document.xml"/></Relationships>`)
  zip.file('word/_rels/document.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="header" Type="${relationships}/header" Target="header.xml"/><Relationship Id="footer" Type="${relationships}/footer" Target="footer.xml"/><Relationship Id="web" Type="${relationships}/hyperlink" Target="https://example.com/doc" TargetMode="External"/><Relationship Id="script" Type="${relationships}/hyperlink" Target="javascript:alert(1)" TargetMode="External"/><Relationship Id="file" Type="${relationships}/hyperlink" Target="file:///C:/private.txt" TargetMode="External"/><Relationship Id="html" Type="${relationships}/aFChunk" Target="unsafe.html"/><Relationship Id="image" Type="${relationships}/image" Target="media/pixel.png"/></Relationships>`)
  const image = `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="9525" cy="9525"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="image"/></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9525" cy="9525"/></a:xfrm></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
  zip.file('word/document.xml', `<w:document xmlns:w="${word}" xmlns:r="${relationships}"><w:body>${paragraph('Cover page')}<w:p><w:pPr>${section(0)}</w:pPr></w:p>${paragraph('正文保留独立页边距')}<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc><w:tcPr/><w:p><w:r><w:t>真实表格单元格</w:t></w:r></w:p></w:tc></w:tr></w:tbl>${image}<w:p><w:bookmarkStart w:id="1" w:name="bookmark"/><w:r><w:t>本文件书签</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p><w:p><w:hyperlink r:id="web"><w:r><w:t>安全外链</w:t></w:r></w:hyperlink><w:hyperlink r:id="script"><w:r><w:t>脚本外链</w:t></w:r></w:hyperlink><w:hyperlink r:id="file"><w:r><w:t>本机外链</w:t></w:r></w:hyperlink><w:hyperlink w:anchor="bookmark"><w:r><w:t>跳到书签</w:t></w:r></w:hyperlink></w:p><w:altChunk r:id="html"/>${section(1440)}</w:body></w:document>`)
  zip.file('word/header.xml', `<w:hdr xmlns:w="${word}">${paragraph('Header preserved')}</w:hdr>`)
  zip.file('word/footer.xml', `<w:ftr xmlns:w="${word}">${paragraph('Footer preserved')}</w:ftr>`)
  zip.file('word/unsafe.html', '<script>window.docxUnsafe=true</script><iframe src="https://example.invalid"></iframe><p>不应注入的HTML</p>')
  zip.file('word/media/pixel.png', 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jT6kAAAAASUVORK5CYII=', { base64: true })
  return zip.generateAsync({ type: 'arraybuffer' })
}
function tab() {
  return useWorkspaceStore.getState().openFile({ scope: { sessionId: 'docx-render', refs: [] }, target: 'document.docx' }, 'docx-render')
}
beforeEach(() => {
  window.cogent = { fileViewsRequest: vi.fn().mockResolvedValue({ ok: true }) } as unknown as typeof window.cogent
  useFilePreviewStore.getState().resetAll(); useWorkspaceStore.getState().reset()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('CSS', { escape: (value: string) => value })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() })
})
afterEach(() => { cleanup(); useWorkspaceStore.getState().reset(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('DOCX 真实内容渲染', () => {
  it('损坏字节显示真实解析错误，不把提取文本或空页称为成功预览', async () => {
    render(<DocxPreview buffer={new ArrayBuffer(4)} name="broken.docx" tabId={tab()} active onOpenUrl={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/无法预览 broken.docx/)
    expect(document.querySelector('[data-docx-document] section')).toBeNull()
  })

  it('双section即使纸张相同也独立分页，并保留页边距、表格、页眉页脚、字体和包内图片', async () => {
    const view = render(<DocxPreview buffer={await fixture()} name="双section.docx" tabId={tab()} active onOpenUrl={vi.fn()} />)
    await screen.findByText('正文保留独立页边距')
    const pages = [...view.container.querySelectorAll<HTMLElement>('[data-docx-document] section')]
    expect(pages).toHaveLength(2)
    expect(pages[0].style.paddingLeft).toBe('0pt')
    expect(pages[1].style.paddingLeft).toBe('72pt')
    expect(pages[0].style.width).toBe('612pt')
    expect(pages[1].style.minHeight).toBe('792pt')
    expect(view.container.querySelector('table td')).toHaveTextContent('真实表格单元格')
    expect(view.container.querySelectorAll('header')).toHaveLength(2)
    expect(view.container.querySelectorAll('footer')).toHaveLength(2)
    expect(view.container.querySelector('span[style*="font-family"]')?.getAttribute('style')).toContain('Arial')
    expect(view.container.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
    expect(view.container.querySelector('iframe,script')).toBeNull()
    expect(screen.queryByText('不应注入的HTML')).toBeNull()
    expect(screen.getByLabelText('文档页码')).toHaveTextContent('1 / 2')
  })

  it('文件作者的链接统一走宿主校验，书签限定当前文档，不导航主renderer', async () => {
    const open = vi.fn()
    const foreign = document.createElement('div'); foreign.id = 'bookmark'; document.body.append(foreign)
    const foreignScroll = vi.fn(); foreign.scrollIntoView = foreignScroll
    const view = render(<DocxPreview buffer={await fixture()} name="links.docx" tabId={tab()} active onOpenUrl={open} />)
    fireEvent.click(await screen.findByText('安全外链'))
    expect(open).toHaveBeenCalledExactlyOnceWith('https://example.com/doc')
    fireEvent.click(screen.getByText('脚本外链')); fireEvent.click(screen.getByText('本机外链'))
    expect(open).toHaveBeenCalledTimes(1)
    const local = view.container.querySelector<HTMLElement>('[id="bookmark"]')!
    const localScroll = vi.fn(); local.scrollIntoView = localScroll
    fireEvent.click(screen.getByText('跳到书签'))
    await waitFor(() => expect(localScroll).toHaveBeenCalled())
    expect(foreignScroll).not.toHaveBeenCalled()
    foreign.remove()
  })
})
