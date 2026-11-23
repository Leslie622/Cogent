/** 真实库读样本；结构、中文、公式缓存与失败不可被空文本掩盖。 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import ExcelJS from 'exceljs'
import { parseAttachment } from '../../../src/host/runtime/attachment-parser'

const roots: string[] = []
function fixture(name: string, bytes: Uint8Array | string): string {
  const root = mkdtempSync(join(tmpdir(), 'cogent-parser-test-')); roots.push(root)
  const path = join(root, name); writeFileSync(path, bytes); return path
}
function xmlFixture(name: string, parts: Record<string, string>): string {
  return fixture(name, zipSync(Object.fromEntries(Object.entries(parts).map(([path, xml]) => [path, strToU8(xml)]))))
}
const read = (path: string, name: string, extra = {}) => parseAttachment({ path, name, cursor: 0, ...extra })
const compatibility = (name: string) => resolve('tests/fixtures/附件兼容', name)
function modifiedPresentation(change: (xml: string) => string, part = 'ppt/_rels/presentation.xml.rels'): string {
  const parts = unzipSync(new Uint8Array(readFileSync(compatibility('通用关系与绝对路径.pptx'))))
  parts[part] = strToU8(change(strFromU8(parts[part])))
  return fixture('changed.pptx', zipSync(parts))
}
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })) })
describe('本地文档读取', () => {
  it('中文 PDF 使用磁盘离线 CMap，保留宋体行', async () => {
    const result = await read(compatibility('中文离线映射.pdf'), '中文.pdf')
    expect(result.text).toContain('中文排版测试'); expect(result.text).toContain('宋体')
    expect(result.source).toContain('PDF.js')
  })
  it('PDF 损坏显式失败', async () => {
    await expect(read(fixture('bad.pdf', '%PDF-broken'), 'bad.pdf')).rejects.toThrow()
  })
  it('DOCX 保留标题、段落、表格行与中文', async () => {
    const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
    const relationships = 'http://schemas.openxmlformats.org/package/2006/relationships'
    const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    const path = xmlFixture('a.docx', {
      '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
      '_rels/.rels': `<Relationships xmlns="${relationships}"><Relationship Id="document" Type="${office}/officeDocument" Target="word/document.xml"/></Relationships>`,
      'word/_rels/document.xml.rels': `<Relationships xmlns="${relationships}"><Relationship Id="styles" Type="${office}/styles" Target="styles.xml"/></Relationships>`,
      'word/styles.xml': `<w:styles xmlns:w="${word}"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`,
      'word/document.xml': `<w:document xmlns:w="${word}"><w:body>
        <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>中文标题</w:t></w:r></w:p>
        <w:p><w:r><w:t>正文段落</w:t></w:r></w:p>
        <w:tbl><w:tr><w:tc><w:p><w:r><w:t>甲</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>乙</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      </w:body></w:document>`
    })
    const result = await read(path, 'a.docx')
    expect(result.text).toContain('[标题] 中文标题'); expect(result.text).toContain('[表格]'); expect(result.text).toContain('甲\t乙')
    expect(result.text).toContain('正文段落')
  })
  it('XLSX 目录、工作表范围、已缓存及未计算公式', async () => {
    const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('中文表')
    sheet.getCell('A1').value = '名称'; sheet.getCell('B2').value = { formula: '1+2', result: 3 }
    sheet.getCell('B3').value = { formula: '4+5' }
    const path = fixture('a.xlsx', new Uint8Array(await book.xlsx.writeBuffer()))
    expect((await read(path, 'a.xlsx')).text).toContain('中文表')
    const result = await read(path, 'a.xlsx', { sheet: '中文表', range: 'A1:B3' })
    expect(result.text).toContain('缓存=3'); expect(result.text).toContain('公式=4+5；缓存=未计算')
    await expect(read(path, 'a.xlsx', { sheet: '中文表', range: 'A1:Z999' })).rejects.toThrow('5000')
  })
  it('PPTX 按关联顺序读取文字、备注与表格', async () => {
    const result = await read(compatibility('通用关系与绝对路径.pptx'), 'a.pptx')
    expect(result.text).toContain('幻灯片 1'); expect(result.text.length).toBeGreaterThan(30)
    expect(result.warnings.join()).toContain('未分析图片')
  })
  it('真实带命名空间前缀的XLSX保留工作表、公式缓存且不改写原件', async () => {
    const path = compatibility('命名空间前缀.xlsx'); const original = readFileSync(path)
    expect((await read(path, 'a.xlsx')).text).toContain('销售')
    const result = await read(path, 'a.xlsx', { sheet: '销售', range: 'A1:C3' })
    expect(result.text).toContain('C2: 公式=B2*F2；缓存=42')
    expect(result.text).toContain('C3: 公式=B3*F3；缓存=40')
    expect(readFileSync(path)).toEqual(original)
  })
  it('PPTX通用关系ID和包内绝对路径读取页序、表格与备注', async () => {
    const path = compatibility('通用关系与绝对路径.pptx'); const original = readFileSync(path)
    expect((await read(path, 'a.pptx')).text).toContain('NOTE-A17-4682')
    expect((await read(path, 'a.pptx', { cursor: 1 })).text).toContain('NOTE-B28-5927')
    const alias = modifiedPresentation((xml) => xml.replaceAll('xmlns:r=', 'xmlns:links=').replaceAll('r:id=', 'links:id='), 'ppt/presentation.xml')
    expect((await read(alias, 'a.pptx')).text).toContain('第一页 A17')
    const reordered = modifiedPresentation((xml) => {
      const slides = xml.match(/<p:sldId\b[^>]*\/>/g)!
      return xml.replace(slides[0], '<swap/>').replace(slides[1], slides[0]).replace('<swap/>', slides[1])
    }, 'ppt/presentation.xml')
    expect((await read(reordered, 'a.pptx')).text).toContain('第二页 B28')
    expect(readFileSync(path)).toEqual(original)
  })
  it.each(['../../outside.xml', '/../../outside.xml', '%2e%2e/%2e%2e/outside.xml', 'https://example.test/a.xml', '\\\\server\\share\\a.xml'])('PPTX危险关系不进入包外读取：%s', async (target) => {
    const path = modifiedPresentation((xml) => xml.replace('Target="/ppt/slides/slide1.xml"', `Target="${target}"`))
    await expect(read(path, 'a.pptx')).rejects.toThrow(/关系/)
  })
  it('外部关系和XLSX实体声明均明确拒绝', async () => {
    const external = modifiedPresentation((xml) => xml.replace('Target="/ppt/slides/slide1.xml"', 'TargetMode="External" Target="/ppt/slides/slide1.xml"'))
    await expect(read(external, 'a.pptx')).rejects.toThrow('外部')
    const parts = unzipSync(new Uint8Array(readFileSync(compatibility('命名空间前缀.xlsx'))))
    parts['xl/workbook.xml'] = strToU8('<!DOCTYPE a [<!ENTITY x "bad">]>' + strFromU8(parts['xl/workbook.xml']).replace(/<\?xml[^>]+>/, ''))
    await expect(read(fixture('entity.xlsx', zipSync(parts)), 'entity.xlsx')).rejects.toThrow('实体')
  })
  it('文本按字符分页、UTF16可读、错误编码和二进制显式失败', async () => {
    const path = fixture('a.txt', '你'.repeat(25_000))
    const first = await read(path, 'a.txt'); expect(first.text).toHaveLength(24_000); expect(first.nextCursor).toBe(24_000)
    expect((await read(path, 'a.txt', { cursor: first.nextCursor })).text).toHaveLength(1000)
    expect((await read(fixture('u.txt', Buffer.concat([Buffer.from([255, 254]), Buffer.from('中文', 'utf16le')])), 'u.txt')).text).toBe('中文')
    await expect(read(fixture('x.bin', new Uint8Array([0, 3, 5])), 'x.bin')).rejects.toThrow('二进制')
    await expect(read(fixture('x.txt', new Uint8Array([255, 255])), 'x.txt')).rejects.toThrow('编码')
  })
  it('XML 实体与展开预算不进入解析器', async () => {
    const malicious = xmlFixture('x.docx', { 'word/document.xml': '<!DOCTYPE a [<!ENTITY x "evil">]><document>&x;</document>' })
    await expect(read(malicious, 'x.docx')).rejects.toThrow('实体')
    const zip = fixture('big.docx', zipSync({ 'huge.xml': new Uint8Array(33 * 1024 * 1024) }))
    await expect(read(zip, 'big.docx')).rejects.toThrow('预算')
  })
})
