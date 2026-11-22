/** 真产品文件渲染回归；合成OOXML字节通过文件导航、main授权和Host读取，禁止向store灌预览。 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import electron from 'electron'

const fixturesOnly = process.argv.includes('--fixtures-only')
if (!fixturesOnly) for (const entry of ['out/main/index.js', 'out/renderer/index.html']) {
  if (!existsSync(resolve(entry))) throw new Error('缺少产品构建：' + entry + '；请先npm run build')
}
const evidence = resolve(process.env.FILE_RENDERERS_EVIDENCE ?? 'tmp/file-renderers-electron')
const preserved = join(evidence, 'fixtures')
const root = mkdtempSync(join(tmpdir(), 'cogent-file-renderers-'))
const home = join(root, 'home'), workspace = join(root, 'workspace')
for (const directory of [home, workspace, preserved]) mkdirSync(directory, { recursive: true })
writeFileSync(join(home, 'settings.json'), JSON.stringify({ version: 1, closeBehavior: 'quit', soundEnabled: false, toastEnabled: false }))
const sourcePaths = {
  image: 'reference/pi/packages/ai/test/data/red-circle.png',
  pptx: 'reference/zcode/apps/zcode-cli/packages/office-runtime/fixtures/launch.pptx',
  pdf: 'reference/zcode/apps/zcode-cli/packages/office-runtime/fixtures/paper.pdf'
}
const sourceRecords = Object.entries(sourcePaths).map(([kind, path]) => ({ kind, path, sha256: createHash('sha256').update(readFileSync(resolve(path))).digest('hex') }))
const png = readFileSync(resolve(sourcePaths.image))
const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const chartXml = (sheet = 'Summary') => `<?xml version="1.0"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Visual Revenue Chart</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>Revenue series</c:v></c:tx><c:spPr><a:solidFill><a:srgbClr val="2563EB"/></a:solidFill></c:spPr><c:cat><c:strRef><c:f>${sheet}!$B$3:$D$3</c:f><c:strCache><c:ptCount val="3"/><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt><c:pt idx="2"><c:v>Q3</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>${sheet}!$B$4:$D$4</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="3"/><c:pt idx="0"><c:v>100</c:v></c:pt><c:pt idx="1"><c:v>110</c:v></c:pt><c:pt idx="2"><c:v>120</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart><c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="b"/><c:crossAx val="2"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="l"/><c:crossAx val="1"/></c:valAx></c:plotArea><c:legend><c:legendPos val="b"/></c:legend></c:chart></c:chartSpace>`

async function makeDocx() {
  const zip = new JSZip()
  const paragraph = (text, size = 22) => `<w:p><w:r><w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="Microsoft YaHei"/><w:sz w:val="${size}"/></w:rPr><w:t>${text}</w:t></w:r></w:p>`
  const section = margin => `<w:sectPr><w:headerReference w:type="default" r:id="header"/><w:footerReference w:type="default" r:id="footer"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="${margin}" w:right="${margin}" w:bottom="${margin}" w:left="${margin}" w:header="360" w:footer="360"/></w:sectPr>`
  const table = `<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="8"/><w:bottom w:val="single" w:sz="8"/><w:left w:val="single" w:sz="8"/><w:right w:val="single" w:sz="8"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="3200"/><w:gridCol w:w="2000"/></w:tblGrid>${[['Region', 'Revenue'], ['North', '330'], ['South', '265']].map(row => `<w:tr>${row.map(text => `<w:tc><w:tcPr/><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`
  const image = `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="1371600" cy="1371600"/><wp:docPr id="7" name="Fixture red circle"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="8" name="red-circle.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="image"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1371600" cy="1371600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
  zip.file('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)
  zip.file('_rels/.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="document" Type="${rel}/officeDocument" Target="word/document.xml"/></Relationships>`)
  zip.file('word/_rels/document.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="header" Type="${rel}/header" Target="header.xml"/><Relationship Id="footer" Type="${rel}/footer" Target="footer.xml"/><Relationship Id="image" Type="${rel}/image" Target="media/red-circle.png"/></Relationships>`)
  zip.file('word/header.xml', `<w:hdr xmlns:w="${word}">${paragraph('Renderer header: preserved', 18)}</w:hdr>`)
  zip.file('word/footer.xml', `<w:ftr xmlns:w="${word}">${paragraph('Renderer footer: preserved', 18)}</w:ftr>`)
  zip.file('word/media/red-circle.png', png)
  zip.file('word/document.xml', `<w:document xmlns:w="${word}" xmlns:r="${rel}"><w:body>${paragraph('DOCX Visual Renderer — Section A', 36)}${paragraph('Paper, text, table and embedded picture')}${table}${image}<w:p><w:pPr>${section(720)}</w:pPr></w:p>${paragraph('DOCX Section B — 独立页边距', 32)}${paragraph('Second section keeps its own margins. 第二页正文。')}${table}${image}${section(1440)}</w:body></w:document>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}

async function makeXlsx() {
  const workbook = new ExcelJS.Workbook()
  const summary = workbook.addWorksheet('Summary'), notes = workbook.addWorksheet('Notes')
  summary.columns = [{ width: 23 }, { width: 13 }, { width: 13 }, { width: 13 }, { width: 16 }, { width: 13 }, { width: 13 }, { width: 13 }, { width: 13 }, { width: 13 }]
  summary.mergeCells('A1:F1'); summary.getCell('A1').value = 'XLSX Visual Renderer — merged heading'
  summary.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE68A' } }
  summary.getCell('A1').font = { size: 18, bold: true, color: { argb: 'FF1E3A8A' } }; summary.getRow(1).height = 35
  summary.getRow(3).values = ['Region', 'Q1', 'Q2', 'Q3', 'Total']
  summary.getRow(3).eachCell(cell => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E40AF' } }; cell.font = { bold: true, color: { argb: 'FFFFFFFF' } } })
  summary.getRow(4).values = ['North', 100, 110, 120, { formula: 'SUM(B4:D4)', result: 330 }]
  summary.getRow(5).values = ['South', 80, 90, 95, { formula: 'SUM(B5:D5)', result: 265 }]
  for (let row = 7; row <= 75; row++) summary.getCell(row, 1).value = 'Reading row ' + row
  const image = workbook.addImage({ buffer: png, extension: 'png' })
  summary.addImage(image, { tl: { col: 0, row: 7 }, ext: { width: 110, height: 110 } })
  notes.columns = [{ width: 38 }, { width: 20 }]
  notes.addRows([['Notes worksheet', 'Value'], ['Growth assumption', 0.12], ['Second independent sheet', 'RENDERER_NOTES']])
  notes.getCell('A1').font = { bold: true, size: 16 }; notes.getCell('B2').numFmt = '0%'
  const zip = await JSZip.loadAsync(await workbook.xlsx.writeBuffer())
  const drawing = zip.file('xl/drawings/drawing1.xml')
  if (drawing === null) throw new Error('ExcelJS没有生成图片drawing，不能生成虚假的图形夹具')
  const graphic = `<xdr:twoCellAnchor><xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>7</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>10</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>24</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="501" name="Visual Revenue Chart"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${rel}" r:id="rIdVisualChart"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`
  zip.file('xl/drawings/drawing1.xml', (await drawing.async('string')).replace('</xdr:wsDr>', graphic + '</xdr:wsDr>'))
  const relPath = 'xl/drawings/_rels/drawing1.xml.rels'
  zip.file(relPath, (await zip.file(relPath).async('string')).replace('</Relationships>', `<Relationship Id="rIdVisualChart" Type="${rel}/chart" Target="../charts/chart1.xml"/></Relationships>`))
  zip.file('xl/charts/chart1.xml', chartXml())
  zip.file('[Content_Types].xml', (await zip.file('[Content_Types].xml').async('string')).replace('</Types>', '<Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>'))
  return zip.generateAsync({ type: 'nodebuffer' })
}

async function makePptx() {
  const zip = await JSZip.loadAsync(readFileSync(resolve(sourcePaths.pptx)))
  const shape = (id, title, text, x, y, width, height, fill = 'FFFFFF', size = 2400) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${title}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${fill}"/></a:solidFill></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="${size}"><a:solidFill><a:srgbClr val="17315C"/></a:solidFill><a:latin typeface="Arial"/></a:rPr><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`
  const picture = `<p:pic><p:nvPicPr><p:cNvPr id="60" name="Renderer red circle"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdVisualImage"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="457200" y="4114800"/><a:ext cx="1645920" cy="1645920"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  const chart = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="61" name="Visual Revenue Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="4114800" y="2286000"/><a:ext cx="4114800" cy="3657600"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rIdVisualChart"/></a:graphicData></a:graphic></p:graphicFrame>`
  const tree = `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shape(50, 'Renderer title', 'PPTX Visual Renderer', 457200, 365760, 8000000, 800000, 'FFFFFF', 3600)}${shape(51, 'Renderer subtitle', 'Text, vector shape, embedded picture and chart', 457200, 1280160, 8000000, 600000, 'FFFFFF', 1800)}${shape(52, 'Renderer colored shape', 'Shape and text retained', 457200, 2286000, 3000000, 1200000, 'F59E0B', 2400)}${picture}${chart}</p:spTree>`
  zip.file('ppt/slides/slide1.xml', (await zip.file('ppt/slides/slide1.xml').async('string')).replace(/<p:spTree>[\s\S]*?<\/p:spTree>/, tree))
  const relPath = 'ppt/slides/_rels/slide1.xml.rels'
  zip.file(relPath, (await zip.file(relPath).async('string')).replace('</Relationships>', `<Relationship Id="rIdVisualImage" Type="${rel}/image" Target="../media/renderer.png"/><Relationship Id="rIdVisualChart" Type="${rel}/chart" Target="../charts/chart1.xml"/></Relationships>`))
  zip.file('ppt/media/renderer.png', png); zip.file('ppt/charts/chart1.xml', chartXml())
  const types = await zip.file('[Content_Types].xml').async('string')
  zip.file('[Content_Types].xml', types.replace('</Types>', `${types.includes('Extension="png"') ? '' : '<Default Extension="png" ContentType="image/png"/>'}<Override PartName="/ppt/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`))
  return zip.generateAsync({ type: 'nodebuffer' })
}

const files = {
  'visual.docx': await makeDocx(), 'visual.xlsx': await makeXlsx(), 'visual.pptx': await makePptx(),
  'visual.pdf': readFileSync(resolve(sourcePaths.pdf)),
  'visual.md': Buffer.from('# Markdown Visual Renderer\n\n$$E=mc^2$$\n\n```mermaid\nflowchart TD\nA[Start] --> B[Done]\n```\n'),
  'visual.svg': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" rx="24" fill="#FDE68A"/><circle cx="130" cy="180" r="75" fill="#EF4444"/><text x="245" y="185" font-family="Arial,sans-serif" font-size="25" fill="#17315C">SVG Preview Fixture</text></svg>')
}
const fixtures = Object.entries(files).map(([name, bytes]) => {
  writeFileSync(join(workspace, name), bytes); writeFileSync(join(preserved, name), bytes)
  return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
})
const manifest = { sources: sourceRecords, fixtures, generation: { docx: 'JSZip OOXML: two equal-size sections, 36pt/72pt margins, header/footer, table and PNG', xlsx: 'ExcelJS: two sheets, styles, merged A1:F1, cached formulas, PNG; OOXML bar-chart drawing added to package', pptx: 'Readonly copy of Zcode launch.pptx; slide1 replaced with explicit text/shape/PNG/chart, original slides2/3 retained', pdf: 'Readonly copy of Zcode paper.pdf (two pages)', markdown: 'Math block and Mermaid flowchart', svg: 'Static SVG with native text, circle and rectangle' } }
writeFileSync(join(evidence, 'fixtures.json'), JSON.stringify(manifest, null, 2))

async function driver(config) {
  const { app, dialog, ipcMain } = await import('electron')
  const { writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const childProcess = (await import('node:child_process')).default
  const owned = new Set([process.pid]), leases = new Set(), inFlight = new Set()
  const writePids = () => writeFileSync(join(config.evidence, 'owned-pids.json'), JSON.stringify([...owned]))
  writePids()
  const originalSpawn = childProcess.spawn
  childProcess.spawn = (...args) => { const child = originalSpawn(...args); if (child.pid) { owned.add(child.pid); writePids() }; return child }
  ;(await import('node:module')).syncBuiltinESMExports()
  app.setPath('userData', config.profile)
  const created = new Promise(done => app.once('browser-window-created', (_event, window) => done(window)))
  const checks = [], errors = [], requests = [], measurements = {}, pickers = []
  const projectName = '文件渲染验收项目'
  const originalHandle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, handler) => originalHandle(channel, channel !== 'fileViews:request' ? handler : async (event, payload) => {
    const token = {}; inFlight.add(token)
    try {
      const result = await handler(event, payload)
      if (payload.method === 'fileViews.acquire') leases.add(result.leaseId)
      if (payload.method === 'fileViews.release') leases.delete(payload.params.leaseId)
      requests.push({ method: payload.method, ...(payload.method === 'fileViews.acquire' ? { source: payload.params.source.kind, path: result.descriptor.path, kind: result.descriptor.kind } : {}) })
      return result
    } finally { inFlight.delete(token) }
  })
  dialog.showOpenDialog = async (_window, options) => {
    if (options.title !== '选择项目文件夹' || !options.properties.includes('openDirectory')) throw new Error('非预期选择器：' + JSON.stringify(options))
    pickers.push({ title: options.title, selected: config.workspace })
    return { canceled: false, filePaths: [config.workspace] }
  }
  let win, stage = '启动', passed = false, failure
  const evaluate = (fn, ...args) => win.webContents.executeJavaScript('(' + fn.toString() + ')(' + args.map(value => JSON.stringify(value)).join(',') + ')', true)
  const wait = async (condition, label) => {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      if (await condition()) {
        for (const metric of app.getAppMetrics()) owned.add(metric.pid)
        writePids(); checks.push(label); console.log('[验收] ' + label); return
      }
      await new Promise(done => setTimeout(done, 40))
    }
    throw new Error('超时：' + label)
  }
  const settle = () => evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  const click = async selector => {
    await wait(() => evaluate(selector => { const el = document.querySelector(selector); return !!el && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && el.getBoundingClientRect().width > 0 }, selector), '控件可点击 ' + selector)
    const point = await evaluate(selector => {
      const el = document.querySelector(selector); el.scrollIntoView({ block: 'center', inline: 'nearest' })
      const r = el.getBoundingClientRect(), x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2), hit = document.elementFromPoint(x, y)
      if (hit !== el && !el.contains(hit)) throw new Error('点击被遮挡：' + selector)
      return { x, y }
    }, selector)
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
    await settle()
  }
  const clickText = async (text, selector = '[data-workspace] button') => {
    await wait(() => evaluate((text, selector) => [...document.querySelectorAll(selector)].some(el => el.textContent.trim() === text), text, selector), '显示入口 ' + text)
    await evaluate((text, selector) => { document.querySelector('[data-renderer-target]')?.removeAttribute('data-renderer-target'); [...document.querySelectorAll(selector)].find(el => el.textContent.trim() === text).setAttribute('data-renderer-target', '') }, text, selector)
    await click('[data-renderer-target]')
    await evaluate(() => document.querySelector('[data-renderer-target]')?.removeAttribute('data-renderer-target'))
  }
  const type = async (selector, value) => {
    await click(selector)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] })
    await win.webContents.insertText(value)
    await settle()
  }
  const panel = '[data-workspace-panel]:not([hidden])'
  const openFile = async name => {
    const existing = await evaluate(name => [...document.querySelectorAll('[aria-label=工作区标签页] [role=tab]')].some(tab => tab.textContent.trim() === name), name)
    if (existing) await clickText(name, '[aria-label=工作区标签页] [role=tab]')
    else {
      const empty = await evaluate(() => !!document.querySelector('[data-workspace-panel]:not([hidden])[data-tab-kind=files]'))
      if (!empty) { await click('[aria-label=新建标签页]'); await click('[aria-label=打开文件导航]') }
      await clickText(name, '[data-file-navigator] [role=treeitem]')
    }
    await wait(() => evaluate((panel, name) => {
      const preview = document.querySelector(panel + ' [data-file-preview]')
      const toolbars = [...document.querySelectorAll('[data-file-toolbar]')].filter(toolbar => !toolbar.closest('[hidden],[inert]') && toolbar.getBoundingClientRect().width > 0)
      return !!preview && toolbars.length === 1 && !preview.contains(toolbars[0]) && toolbars[0].querySelector('[aria-label="文件位置"] [aria-current=page]')?.textContent.trim() === name
    }, panel, name), '真实文件入口打开且唯一工具行面包屑切换 ' + name)
  }
  const snapshot = async name => {
    await settle()
    await evaluate(() => Promise.allSettled(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished)))
    await win.webContents.capturePage()
    // 采集已提交的合成帧；跨路由显隐后的首个capture可能仍返回旧surface。
    await new Promise(done => setTimeout(done, 120))
    const image = await win.webContents.capturePage(); writeFileSync(join(config.evidence, name + '.png'), image.toPNG())
  }
  const colorMode = async label => {
    await click('[aria-label=设置]')
    await clickText('设置', '[role=menuitem]')
    await clickText('外观', '[data-sidebar-clip] button')
    await click('[aria-label=深色浅色]')
    await clickText(label, '[role=option]')
    await click('[aria-label=首页]')
    await wait(() => evaluate(() => document.querySelector('[data-workspace]')?.inert === false), '设置返回真实工作区')
  }
  const canvasPixels = selector => evaluate(selector => [...document.querySelectorAll(selector)].filter(canvas => canvas.width > 0 && canvas.height > 0).map(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    let nonwhite = 0, blue = 0, amber = 0, red = 0
    for (let i = 0; i < data.length; i += 16) {
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3]
      if (a > 100 && Math.min(r, g, b) < 225) nonwhite++
      if (a > 100 && b > r + 35 && b > g + 15) blue++
      if (a > 100 && r > 220 && g > 130 && g < 245 && b < 180) amber++
      if (a > 100 && r > g + 50 && r > b + 50) red++
    }
    return { width: canvas.width, height: canvas.height, nonwhite, blue, amber, red }
  }), selector)
  try {
    await import(config.main)
    win = await created; win.setSize(1500, 1000); win.show()
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
    await wait(() => evaluate(() => !!document.querySelector('[data-home-split]') && typeof window.cogent === 'object'), '完整产品首页与preload就绪')
    const before = await evaluate(() => window.cogent.engineRequest('session.list', {}))
    // 树只浏览项目目录；项目创建、目录信任与草稿绑定均走真实产品UI。
    await clickText('选择项目', 'button')
    await clickText('新建项目', '[data-slot=popover-content] button')
    await clickText('下一步', '[role=dialog] button')
    await type('[role=dialog] input[placeholder="项目名称"]', projectName)
    await clickText('添加文件夹', '[role=dialog] button')
    await clickText('创建项目', '[role=dialog] button')
    await clickText('信任文件夹', '[role=dialog] button')
    await wait(() => evaluate(projectName => document.querySelectorAll('[role=dialog]').length === 0 && [...document.querySelectorAll('button')].some(button => button.textContent.trim() === projectName), projectName), '项目经真实表单创建并绑定未发送草稿')
    await click('[aria-label=展开标签页区]'); await click('[aria-label=打开文件导航]')
    await wait(() => evaluate(projectName => document.querySelector('[data-file-navigator] [data-file-root-label]')?.textContent === projectName && [...document.querySelectorAll('[role=treeitem]')].some(el => el.textContent.includes('visual.docx')), projectName), '项目目录经真实main/Host上下文列出夹具并显示项目名')
    await click('[aria-label=展开工作区]')

    stage = 'DOCX分页与版式'
    await openFile('visual.docx')
    await wait(() => evaluate(panel => {
      const root = document.querySelector(panel + ' [data-docx-document]')
      return !!root && root.querySelectorAll('section').length === 2 && [...root.querySelectorAll('img')].every(image => image.naturalWidth > 0)
    }, panel), 'DOCX真实生成双section页面且包内图片完成解码')
    measurements.docx = await evaluate(panel => {
      const root = document.querySelector(panel + ' [data-docx-document]'), pages = [...root.querySelectorAll('section')]
      return { pages: pages.map(page => ({ padding: page.style.paddingLeft, width: page.style.width, height: page.style.minHeight, rect: { width: page.getBoundingClientRect().width, height: page.getBoundingClientRect().height } })), headers: root.querySelectorAll('header').length, footers: root.querySelectorAll('footer').length, tables: root.querySelectorAll('table').length, images: root.querySelectorAll('img').length, text: root.textContent }
    }, panel)
    if (measurements.docx.pages[0].padding !== '36pt' || measurements.docx.pages[1].padding !== '72pt' || measurements.docx.headers !== 2 || measurements.docx.footers !== 2 || measurements.docx.tables !== 2 || measurements.docx.images !== 2 || !measurements.docx.text.includes('North')) throw new Error('DOCX分页/页边距/非文本内容不完整')
    checks.push('DOCX保留两节不同pgMar、页眉页脚、表格和图片，非文字提取页')
    await snapshot('docx-section-a-light')
    await clickText('下一页', panel + ' [data-visual-docx] button')
    await wait(() => evaluate(panel => document.querySelector(panel + ' [aria-label=文档页码]')?.textContent.includes('2 / 2'), panel), 'DOCX页导航进入第二节')
    await snapshot('docx-section-b-light')
    const docxId = await evaluate(panel => document.querySelector(panel + ' [data-docx-document]').dataset.docxDocument, panel)

    stage = 'XLSX网格、样式与图形'
    await openFile('visual.xlsx')
    await wait(() => evaluate(panel => {
      const root = document.querySelector(panel + ' [data-xlsx-preview]')
      return !!root && root.querySelector('canvas')?.width > 0 && root.querySelectorAll('[role=tablist] [role=tab]').length === 2
    }, panel), 'XLSX真实WASM工作簿与两张工作表就绪')
    await wait(() => evaluate(panel => {
      const root = document.querySelector(panel + ' [data-xlsx-preview]')
      return root.querySelector('svg[role=img]')?.querySelectorAll('rect,path,circle').length > 2
    }, panel), 'XLSX真实SVG图表可见')
    // 只读Canvas路径会把普通包内图片烘焙到网格；不能用不存在的DOM img误判图片丢失。
    await wait(async () => (await canvasPixels(panel + ' [data-xlsx-preview] canvas')).some(sample => sample.nonwhite > 100 && sample.blue > 10 && sample.amber > 10 && sample.red > 10), 'XLSX Canvas实际绘制蓝色表头、合并填充和已知红色包内图片')
    measurements.xlsx = { pixels: await canvasPixels(panel + ' [data-xlsx-preview] canvas') }
    measurements.xlsx.chart = await evaluate(panel => document.querySelector(panel + ' [data-xlsx-preview] svg[role=img]')?.getAttribute('aria-label'), panel)
    checks.push('XLSX Canvas保留已知样式填充，图表有真实SVG几何')
    await snapshot('xlsx-summary-light')
    await clickText('Notes', panel + ' [role=tablist][aria-label=工作表] [role=tab]')
    await wait(() => evaluate(panel => [...document.querySelectorAll(panel + ' [aria-label=工作表] [role=tab]')].some(tab => tab.textContent === 'Notes' && tab.getAttribute('aria-selected') === 'true'), panel), '真实点击切换Notes工作表')
    await snapshot('xlsx-notes-light')
    await clickText('visual.docx', '[aria-label=工作区标签页] [role=tab]')
    if (await evaluate(panel => document.querySelector(panel + ' [data-docx-document]')?.dataset.docxDocument, panel) !== docxId) throw new Error('切换文件重新排版了DOCX')
    await clickText('visual.xlsx', '[aria-label=工作区标签页] [role=tab]')
    if (!await evaluate(panel => [...document.querySelectorAll(panel + ' [aria-label=工作表] [role=tab]')].some(tab => tab.textContent === 'Notes' && tab.getAttribute('aria-selected') === 'true'), panel)) throw new Error('工作簿切换丢失当前工作表')
    checks.push('文件切换保留DOCX生成根和XLSX当前工作表')
    await clickText('Summary', panel + ' [role=tablist][aria-label=工作表] [role=tab]')
    await colorMode('深色')
    await wait(() => evaluate(() => document.documentElement.classList.contains('dark')), '真实主题控件切入暗色')
    await wait(async () => (await canvasPixels(panel + ' [data-xlsx-preview] canvas')).some(sample => sample.blue > 10 && sample.amber > 10 && sample.red > 10), '路由隐藏与暗色切换后XLSX Canvas实际重绘')
    await snapshot('xlsx-summary-dark')
    await colorMode('浅色')

    stage = 'PPTX真实幻灯片'
    await openFile('visual.pptx')
    await wait(() => evaluate(panel => {
      const root = document.querySelector(panel + ' [data-pptx-ready=true]')
      return !!root && root.textContent.includes('PPTX Visual Renderer') && root.querySelector('[data-pptx-surface] img')?.naturalWidth > 0 && root.querySelector('[data-pptx-surface] [_echarts_instance_] canvas')?.width > 0
    }, panel), 'PPTX文字、图片与原生ECharts图表实际完成绘制')
    await wait(async () => (await canvasPixels(panel + ' [data-pptx-surface] canvas')).some(sample => sample.nonwhite > 100), 'PPTX图表Canvas有实际绘制像素')
    measurements.pptx = { pixels: await canvasPixels(panel + ' [data-pptx-surface] canvas'), shapes: await evaluate(panel => document.querySelectorAll(panel + ' [data-pptx-surface] svg path').length, panel) }
    if (!measurements.pptx.pixels.some(sample => sample.nonwhite > 100) || measurements.pptx.shapes === 0) throw new Error('PPTX图表/矢量形状没有真实绘制')
    await snapshot('pptx-slide-one-light')
    await click(panel + ' [aria-label=下一张幻灯片]')
    await wait(() => evaluate(panel => document.querySelector(panel + ' [data-pptx-ready=true]')?.textContent.includes('Timeline') && document.querySelector(panel + ' [data-pptx-slide]')?.dataset.pptxPage === '2', panel), 'PPTX页导航进入原始第二张幻灯片')
    await snapshot('pptx-slide-two-light')

    stage = 'PDF Canvas与可选择文字层'
    await openFile('visual.pdf')
    await wait(() => evaluate(panel => {
      const root = document.querySelector(panel + ' [data-pdf-viewport]')
      return root?.querySelector('canvas')?.width > 0 && root.querySelector('.react-pdf__Page__textContent')?.textContent.includes('Research Paper')
    }, panel), 'react-pdf真实Canvas与Research Paper文字层就绪')
    await wait(async () => (await canvasPixels(panel + ' [data-pdf-viewport] canvas')).some(sample => sample.nonwhite > 100), 'PDF页面Canvas有实际绘制像素')
    measurements.pdf = { pixels: await canvasPixels(panel + ' [data-pdf-viewport] canvas') }
    const selectionPoints = await evaluate(panel => {
      const span = [...document.querySelectorAll(panel + ' .react-pdf__Page__textContent span')].find(span => span.textContent.includes('Research Paper'))
      span.scrollIntoView({ block: 'center' }); const r = span.getBoundingClientRect()
      return { start: { x: Math.round(r.left + 2), y: Math.round(r.top + r.height / 2) }, end: { x: Math.round(r.right - 2), y: Math.round(r.top + r.height / 2) } }
    }, panel)
    measurements.pdf.selectionPoints = selectionPoints
    measurements.pdf.selectionDom = await evaluate(point => {
      const hit = document.elementFromPoint(point.x, point.y)
      return { hit: hit?.outerHTML.slice(0, 1000), userSelect: hit && getComputedStyle(hit).userSelect, focused: document.hasFocus() }
    }, selectionPoints.start)
    win.webContents.focus()
    win.webContents.sendInputEvent({ type: 'mouseMove', ...selectionPoints.start })
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...selectionPoints.start })
    for (let step = 1; step <= 8; step++) {
      win.webContents.sendInputEvent({ type: 'mouseMove', modifiers: ['leftButtonDown'], x: Math.round(selectionPoints.start.x + (selectionPoints.end.x - selectionPoints.start.x) * step / 8), y: selectionPoints.start.y })
      await new Promise(done => setTimeout(done, 16))
    }
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...selectionPoints.end })
    await wait(() => evaluate(() => (window.getSelection()?.toString().trim().length ?? 0) >= 5), '真实鼠标拖动可以选择PDF文字')
    measurements.pdf.selection = await evaluate(() => window.getSelection().toString())
    await snapshot('pdf-canvas-text-selection')
    await click(panel + ' [data-pdf-toolbar] [aria-label=下一页]')
    await wait(() => evaluate(panel => document.querySelector(panel + ' .react-pdf__Page__textContent')?.textContent.includes('Method') && document.querySelector(panel + ' [aria-label=PDF页码]')?.value === '2', panel), 'PDF切换实际第二页Canvas与文字层')
    await snapshot('pdf-page-two')
    if (!await evaluate(() => [...document.querySelectorAll('[data-pptx-surface]')].every(surface => surface.childElementCount === 0))) throw new Error('隐藏PPTX仍保留活动页面绘制')
    checks.push('隐藏PPTX释放绘制handle与活动页面')

    stage = 'Markdown数学与Mermaid'
    await openFile('visual.md')
    await wait(() => evaluate(panel => {
      const root = document.querySelector(panel + ' [data-file-preview]')
      return root?.querySelector('.katex')?.getBoundingClientRect().width > 0 && [...root.querySelectorAll('svg')].some(svg => svg.textContent.includes('Start') && svg.textContent.includes('Done') && !!svg.querySelector('path'))
    }, panel), 'Markdown公式生成KaTeX，Mermaid生成实际流程图SVG')
    await snapshot('markdown-math-mermaid')

    stage = 'SVG预览与源码'
    await openFile('visual.svg')
    await wait(() => evaluate(panel => [...document.querySelectorAll(panel + ' [data-file-preview] img')].some(image => image.naturalWidth === 640), panel), 'SVG经原生img解码，未内联执行SVG脚本')
    await snapshot('svg-visual')
    const sourceLabel = await evaluate(panel => [...document.querySelectorAll(panel + ' [role=tab], ' + panel + ' button')].find(el => /^(SVG源码|源码|查看源码)$/.test(el.textContent.trim()))?.textContent.trim(), panel)
    if (!sourceLabel) throw new Error('SVG没有源码切换入口')
    await clickText(sourceLabel, panel + ' [role=tab], ' + panel + ' button')
    await wait(() => evaluate(panel => {
      const root = document.querySelector(panel + ' [data-code-preview]')
      if (!root) return false
      const text = node => (node.textContent ?? '') + [...node.querySelectorAll('*')].filter(el => el.shadowRoot).map(el => text(el.shadowRoot)).join('')
      return root.getBoundingClientRect().height > 0 && text(root).includes('<svg') && text(root).includes('SVG Preview Fixture') && [...document.querySelectorAll(panel + ' [data-svg-preview] [role=tab]')].some(tab => tab.textContent.trim() === '源码' && tab.getAttribute('aria-selected') === 'true')
    }, panel), 'SVG源码实际进入Pierre内容渲染与shadow DOM')
    await wait(() => evaluate(panel => {
      const shadow = document.querySelector(panel + ' [data-code-preview] diffs-container')?.shadowRoot
      return !!shadow && new Set([...shadow.querySelectorAll('[data-line] span')].map(token => getComputedStyle(token).color)).size > 1
    }, panel), 'SVG源码通过Shiki WASM实际产生多色XML语法token')
    await snapshot('svg-source')
    const previewLabel = await evaluate(panel => [...document.querySelectorAll(panel + ' [role=tab], ' + panel + ' button')].find(el => /^(SVG预览|预览|查看预览)$/.test(el.textContent.trim()))?.textContent.trim(), panel)
    if (!previewLabel) throw new Error('SVG没有返回预览入口')
    await clickText(previewLabel, panel + ' [role=tab], ' + panel + ' button')
    await wait(() => evaluate(panel => [...document.querySelectorAll(panel + ' img')].some(image => image.naturalWidth === 640), panel), 'SVG可从源码返回同一文件预览')

    stage = '资源清理'
    const after = await evaluate(() => window.cogent.engineRequest('session.list', {}))
    if (before.length !== after.length) throw new Error('文件浏览创建了聊天session')
    if (requests.filter(request => request.method === 'fileViews.acquire').length < 6 || requests.filter(request => request.method === 'fileViews.readChunk').length < 4) throw new Error('未观察到所需main/preload/Host真实字节读取链')
    checks.push('六种文件均由真实文件入口读取，空白对话未暗建session')
    await click('[aria-label=标签页列表]'); await clickText('关闭全部标签页', '[data-slot=popover-content] button')
    await wait(() => evaluate(() => document.querySelector('[data-workspace]')?.inert === true && document.querySelectorAll('[data-workspace-panel]').length === 0), '全部关闭后所有文件查看器从产品树移除')
    await wait(() => Promise.resolve(leases.size === 0 && inFlight.size === 0), '本轮IPC文件租约与在途操作清零')
    passed = true
  } catch (error) {
    failure = { error: String(error), stack: error.stack }
    if (win && !win.isDestroyed()) {
      await snapshot('failure').catch(() => {})
      measurements.failureDom = await evaluate(() => ({ text: document.body.innerText.slice(-14000), alerts: [...document.querySelectorAll('[role=alert]')].map(el => el.textContent) })).catch(() => null)
    }
  } finally {
    for (const metric of app.getAppMetrics()) owned.add(metric.pid)
    writePids()
    const result = { passed, stage, checks, errors, measurements, pickers, requests, leases: leases.size, inFlight: inFlight.size, ownedPids: [...owned], electron: process.versions.electron, chromium: process.versions.chrome, ...failure, boundaries: ['正常GPU隔离Windows产品窗口；不代表其他平台', '合成DOCX/XLSX/PPTX原件；未验证真实OLE .doc/.xls', '样本和来源哈希另存fixtures.json；没有直接改store或伪造文件预览内容'] }
    writeFileSync(join(config.evidence, 'result.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify({ passed, stage, checks: checks.length, error: failure?.error }, null, 2))
    app.quit(); setTimeout(() => app.exit(2), 7000).unref()
  }
}

function checkedRoot() {
  const path = relative(resolve(tmpdir()), resolve(root))
  if (isAbsolute(path) || path.startsWith('..') || !path.startsWith('cogent-file-renderers-')) throw new Error('临时根边界错误')
  return root
}
if (fixturesOnly) {
  console.log(JSON.stringify({ generated: fixtures, evidence, launchedElectron: false }, null, 2))
  rmSync(checkedRoot(), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
} else {
  const config = { profile: join(root, 'profile'), workspace, evidence, main: pathToFileURL(resolve('out/main/index.js')).href }
  const driverPath = join(root, 'driver.mjs'), resultPath = join(evidence, 'result.json'), pidsPath = join(evidence, 'owned-pids.json')
  writeFileSync(driverPath, '(' + driver.toString() + ')(' + JSON.stringify(config) + ');')
  for (const path of [resultPath, pidsPath]) rmSync(path, { force: true })
  const env = { ...process.env, COGENT_HOME: home, USERPROFILE: home, HOME: home }
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  let child, timer, timedOut = false
  const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
  try {
    child = spawn(electron, [driverPath], { cwd: process.cwd(), env, stdio: 'inherit', windowsHide: true })
    timer = setTimeout(() => { timedOut = true; child.kill() }, 240000)
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done) })
    clearTimeout(timer)
    const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : { passed: false, error: 'Electron未返回验收结果' }
    const ownedPids = existsSync(pidsPath) ? JSON.parse(readFileSync(pidsPath, 'utf8')) : [child.pid]
    const deadline = Date.now() + 5000
    while (ownedPids.some(alive) && Date.now() < deadline) await new Promise(done => setTimeout(done, 100))
    const forcedPids = ownedPids.filter(alive)
    // 正常产品退出优先；故障时仅结束本轮登记的PID，不按electron/node进程名全杀。
    for (const pid of forcedPids) { try { process.kill(pid) } catch {} }
    const forceDeadline = Date.now() + 5000
    while (ownedPids.some(alive) && Date.now() < forceDeadline) await new Promise(done => setTimeout(done, 100))
    result.cleanup = { ownedPids, remainingPids: ownedPids.filter(alive), forcedPids, exitCode: code, timedOut }
    if (code !== 0 || timedOut || forcedPids.length > 0 || result.cleanup.remainingPids.length > 0) result.passed = false
    result.fixtures = manifest
    writeFileSync(resultPath, JSON.stringify(result, null, 2)); process.exitCode = result.passed ? 0 : 1
  } finally {
    clearTimeout(timer)
    if (child && child.exitCode === null) child.kill()
    const pids = existsSync(pidsPath) ? JSON.parse(readFileSync(pidsPath, 'utf8')) : []
    if (pids.some(alive)) console.error('自有进程尚存，保留临时profile：' + root)
    else rmSync(checkedRoot(), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}
