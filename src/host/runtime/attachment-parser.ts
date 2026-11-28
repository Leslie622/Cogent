/** 文档解析运行在受限 worker；只返回结构文字，不执行宏、外链或页面脚本。 */
import { access, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, extname, join } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import ExcelJS from 'exceljs'
import { xmlNodes, workbookBytes, relationshipTarget, relationshipsPath, type XmlNode } from './attachment-ooxml'

export interface ParseRequest { path: string; name: string; cursor: number; sheet?: string; range?: string }
export interface ParsedAttachment { text: string; source: string; warnings: string[]; nextCursor?: number; total?: number; requiresVisual?: boolean }
const MAX_CHARS = 24_000
const MAX_UNZIP = 128 * 1024 * 1024
function children(node: XmlNode, tag: string): XmlNode[] { return node[tag] as XmlNode[] }
function xmlText(nodes: XmlNode[]): string {
  let result = ''
  for (const node of nodes) {
    for (const [tag, value] of Object.entries(node)) {
      if (tag === '#text') { result += String(value); continue }
      if (tag === ':@' || tag.startsWith('?')) continue
      const text = Array.isArray(value) ? xmlText(value as XmlNode[]) : ''
      if (tag === 'tab') result += '\t'
      else if (tag === 'br') result += '\n'
      else if (tag === 'tc') result += text.trim() + '\t'
      else if (tag === 'p' || tag === 'tr') result += text + '\n'
      else result += text
    }
  }
  return result
}
function named(nodes: XmlNode[], tag: string): XmlNode[] {
  const found: XmlNode[] = []
  for (const node of nodes) {
    if (tag in node) found.push(node)
    for (const [key, value] of Object.entries(node)) if (key !== ':@' && Array.isArray(value)) found.push(...named(value as XmlNode[], tag))
  }
  return found
}
function bounded(text: string, source: string, warnings: string[], cursor: number): ParsedAttachment {
  if (cursor > text.length) throw new Error('读取位置超过文档范围')
  const end = Math.min(text.length, cursor + MAX_CHARS)
  return { text: text.slice(cursor, end), source, warnings, total: text.length,
    ...(end < text.length && { nextCursor: end }) }
}
function unpack(bytes: Uint8Array, binary: boolean): Record<string, Uint8Array> {
  let total = 0; let count = 0
  // 先扫描目录而不分配解压结果；库解析前限制总展开量与条目数。
  unzipSync(bytes, { filter: (entry) => {
    total += entry.originalSize; count++
    if (total > MAX_UNZIP || count > 10_000 || entry.originalSize > 32 * 1024 * 1024) throw new Error('文档解压预算超限')
    return false
  } })
  return unzipSync(bytes, { filter: (entry) => binary || /\.xml$|\.rels$/i.test(entry.name) })
}

export async function parseAttachment(request: ParseRequest): Promise<ParsedAttachment> {
  const extension = extname(request.name).toLowerCase()
  const bytes = new Uint8Array(await readFile(request.path))
  if (extension === '.pdf') {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
    await Promise.all(['cmaps', 'standard_fonts', 'wasm'].map((directory) => access(join(root, directory))))
    const resource = (name: string): string => join(root, name).replace(/\\/g, '/') + '/'
    const task = getDocument({ data: bytes, cMapUrl: resource('cmaps'),
      standardFontDataUrl: resource('standard_fonts'), wasmUrl: resource('wasm'),
      useWorkerFetch: false, verbosity: 1 })
    const pdf = await task.promise
    try {
      const pageNumber = request.cursor + 1
      if (pageNumber > pdf.numPages) throw new Error('PDF 页码超过范围')
      const page = await pdf.getPage(pageNumber)
      const content = await page.getTextContent()
      const text = content.items.map((item) => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('')
      const warnings = ['仅提取页面文字；未分析图片、图表和排版。']
      if (text.trim() === '') warnings.push('本页未提取到文字，可能是空白页或扫描件。')
      return { text: `第 ${pageNumber} / ${pdf.numPages} 页\n${text}`, source: '本地 PDF.js 文字提取', warnings, requiresVisual: text.trim() === '',
        total: pdf.numPages, ...(pageNumber < pdf.numPages && { nextCursor: pageNumber }) }
    } finally { await task.destroy() }
  }
  if (['.docx', '.xlsx', '.pptx'].includes(extension)) {
    const archive = unpack(bytes, extension === '.xlsx')
    const xml = (path: string): XmlNode[] => {
      if (!Object.hasOwn(archive, path)) throw new Error(`文档缺少 ${path}（文件损坏或加密）`)
      return xmlNodes(strFromU8(archive[path]))
    }
    if (extension === '.docx') {
      const nodes = xml('word/document.xml')
      const body = named(nodes, 'body').at(0)
      if (body === undefined) throw new Error('DOCX 缺少正文')
      const blocks = children(body, 'body').map((node) => {
        if ('tbl' in node) return '[表格]\n' + xmlText([node])
        const heading = named([node], 'pStyle').map((n) => n[':@'] as Record<string, string>).find((a) => /heading|标题/i.test(a['@_val']))
        return (heading === undefined ? '' : '[标题] ') + xmlText([node])
      }).join('\n')
      return bounded(blocks, '本地 DOCX 段落/标题/表格', ['未分析嵌图、修订、批注与页面排版。'], request.cursor)
    }
    if (extension === '.pptx') {
      const presentation = xml('ppt/presentation.xml')
      const relations = new Map<string, Record<string, string>>()
      for (const n of named(xml('ppt/_rels/presentation.xml.rels'), 'Relationship')) {
        const attributes = n[':@'] as Record<string, string>
        if (relations.has(attributes['@_Id'])) throw new Error('PPTX 关系ID重复')
        relations.set(attributes['@_Id'], attributes)
      }
      const slides = named(presentation, 'sldId').map((n) => {
        const attributes = n[':@'] as Record<string, string>
        const relation = relations.get(attributes['@_relationshipId'])
        if (relation === undefined || !relation['@_Type'].endsWith('/slide')) throw new Error('PPTX 幻灯片关联不合法')
        return relationshipTarget('ppt/presentation.xml', relation['@_Target'], relation['@_TargetMode'] === 'External')
      })
      const slideIndex = request.cursor
      if (slideIndex >= slides.length) throw new Error('幻灯片编号超过范围')
      const target = slides[slideIndex]
      const slide = xml(target)
      if (!slide.some((node) => 'sld' in node)) throw new Error('PPTX 幻灯片部件类型不合法')
      let text = `幻灯片 ${slideIndex + 1} / ${slides.length}\n${xmlText(slide)}`
      const slideRels = relationshipsPath(target)
      if (Object.hasOwn(archive, slideRels)) {
        for (const node of named(xml(slideRels), 'Relationship')) {
          const a = node[':@'] as Record<string, string>
          if (a['@_Type'].endsWith('/notesSlide')) {
            const notes = xml(relationshipTarget(target, a['@_Target'], a['@_TargetMode'] === 'External'))
            if (!notes.some((node) => 'notes' in node)) throw new Error('PPTX 备注部件类型不合法')
            text += `\n[备注]\n${xmlText(notes)}`
          }
        }
      }
      return { text, source: '本地 PPTX 文字/表格/备注', warnings: ['未分析图片、SmartArt、动画与版式。'], total: slides.length,
        ...(slideIndex + 1 < slides.length && { nextCursor: slideIndex + 1 }) }
    }
    const workbook = new ExcelJS.Workbook()
    const projected = workbookBytes(archive, bytes)
    await workbook.xlsx.load(projected.buffer.slice(projected.byteOffset, projected.byteOffset + projected.byteLength) as ArrayBuffer)
    if (request.sheet === undefined) return { text: workbook.worksheets.map((s) => `${s.name}: ${s.rowCount} 行 × ${s.columnCount} 列`).join('\n') + '\n使用 sheet 指定工作表，range 指定 A1:D20。', source: '本地 XLSX 工作表目录', warnings: ['未重算公式；缓存值可能过期。'] }
    const sheet = workbook.getWorksheet(request.sheet)
    if (sheet === undefined) throw new Error(`工作表不存在：${request.sheet}`)
    const range = request.range ?? `A${request.cursor + 1}:Z${request.cursor + 50}`
    if (!/^[A-Z]{1,3}[1-9]\d*:[A-Z]{1,3}[1-9]\d*$/.test(range)) throw new Error('range 必须为 A1:D20 形式')
    const [start, end] = range.split(':').map((address) => {
      const cell = sheet.getCell(address); return { row: Number(cell.row), col: Number(cell.col) }
    })
    if (end.row < start.row || end.col < start.col || (end.row - start.row + 1) * (end.col - start.col + 1) > 5000) throw new Error('单次最多读取 5000 个单元格')
    let text = `[${sheet.name} ${range}]\n`
    for (let row = start.row; row <= Math.min(end.row, sheet.rowCount); row++) {
      for (let col = start.col; col <= end.col; col++) {
        const cell = sheet.getCell(row, col)
        if (cell.value === null) continue
        const value = cell.value
        const formula = typeof value === 'object' && 'formula' in value
        text += `${cell.address}: ${formula ? `公式=${value.formula}；缓存=${value.result === undefined ? '未计算' : JSON.stringify(value.result)}` : cell.text}\n`
      }
    }
    return { text, source: '本地 XLSX 值/公式/缓存', warnings: ['缓存可能过期，未重算、刷新外链或读取图表。'],
      ...(request.range === undefined && end.row < sheet.rowCount && { nextCursor: end.row }) }
  }
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : 'utf-8'
  if (encoding === 'utf-8' && bytes.includes(0)) throw new Error('没有该二进制格式的内置解析器；原件仍可通过文件路径访问')
  let text: string
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes) }
  catch { throw new Error('文本编码无法读取，请转换成 UTF-8 后重新附加') }
  return bounded(text, `本地文本 ${encoding}`, [], request.cursor)
}
