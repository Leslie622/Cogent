/** PDF滚动条/缩放稳定性真产品回归；独立资料与原生指针，按实际Page/Canvas身份与加载过程判定。 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import electron from 'electron'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(repository)
for (const entry of ['out/main/index.js', 'out/main/host.js', 'out/preload/index.cjs', 'out/renderer/index.html']) {
  assert.ok(existsSync(resolve(entry)), '缺少产品构建：' + entry + '；本脚本不自动build')
}
const temporary = mkdtempSync(join(tmpdir(), 'cogent-pdf-stability-'))
const evidence = resolve(process.env.PDF_STABILITY_EVIDENCE ?? 'tmp/pdf-stability-electron')
const home = join(temporary, 'home'), external = join(temporary, 'outside-workspace', 'nested')
for (const path of [home, external, evidence]) mkdirSync(path, { recursive: true })
writeFileSync(join(home, 'settings.json'), JSON.stringify({ version: 1, closeBehavior: 'quit', soundEnabled: false, toastEnabled: false }))
function fixturePdf() {
  const content = page => 'BT /F1 18 Tf 32 700 Td (Stable PDF page ' + page + ') Tj ET\n'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    ...[5, 6].map(stream => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents ' + stream + ' 0 R >>'),
    ...[1, 2].map(page => '<< /Length ' + Buffer.byteLength(content(page)) + ' >>\nstream\n' + content(page) + 'endstream'),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let value = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(value)); value += (index + 1) + ' 0 obj\n' + object + '\nendobj\n' }
  const xref = Buffer.byteLength(value)
  value += 'xref\n0 ' + offsets.length + '\n0000000000 65535 f \n' + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')
  return Buffer.from(value + 'trailer\n<< /Size ' + offsets.length + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n')
}
const pdfPath = join(external, 'external-two-pages.pdf')
writeFileSync(pdfPath, fixturePdf())
const widths = (process.env.PDF_STABILITY_WIDTHS ?? '480,560,640').split(',').map(Number)
assert.ok(widths.length > 0 && widths.every(width => Number.isFinite(width) && width >= 400 && width <= 800), '验收宽度必须在400–800之间')

async function driver(config) {
  const { app, dialog, ipcMain, nativeTheme, shell } = await import('electron')
  const { writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const childProcess = (await import('node:child_process')).default
  const ownedPids = new Set([process.pid]), checks = [], requests = [], errors = [], measurements = { matrix: [] }, leases = new Set()
  let win, stage = '启动产品', passed = false, failure, finishing = false
  const started = Date.now()
  const systemOpens = []
  shell.openPath = async path => { systemOpens.push(path); return '' }
  const savePids = () => writeFileSync(join(config.evidence, 'owned-pids.json'), JSON.stringify([...ownedPids]))
  const originalSpawn = childProcess.spawn
  childProcess.spawn = (...args) => { const child = originalSpawn(...args); if (child.pid) { ownedPids.add(child.pid); savePids() } return child }
  ;(await import('node:module')).syncBuiltinESMExports()
  savePids()
  app.setPath('userData', config.profile)
  app.commandLine.appendSwitch('force-device-scale-factor', '1')
  nativeTheme.themeSource = 'light'
  const created = new Promise(done => app.once('browser-window-created', (_event, value) => done(value)))
  dialog.showOpenDialog = async (_window, options) => {
    if (!options.properties.includes('openFile')) throw new Error('局部PDF验收不选择目录：' + JSON.stringify(options))
    return { canceled: false, filePaths: [config.pdfPath] }
  }
  const originalHandle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, listener) => originalHandle(channel, async (event, ...args) => {
    if (channel !== 'fileViews:request') return listener(event, ...args)
    const payload = args[0], item = { method: payload.method, params: payload.params, stage, at: Date.now() - started }
    requests.push(item)
    try {
      const value = await listener(event, ...args)
      if (payload.method === 'fileViews.acquire') leases.add(value.leaseId)
      if (payload.method === 'fileViews.release') leases.delete(payload.params.leaseId)
      item.ok = true
      return value
    } catch (error) { item.error = String(error); throw error }
  })
  const pidTimer = setInterval(() => { if (app.isReady()) for (const item of app.getAppMetrics()) ownedPids.add(item.pid); savePids() }, 250)
  pidTimer.unref()
  const record = label => { checks.push(label); console.log('[PDF稳定验收] ' + label) }
  const require = (condition, label, value) => { if (!condition) throw new Error(label + '：' + JSON.stringify(value)); record(label) }
  const evaluate = (fn, ...args) => win.webContents.executeJavaScript('(' + fn.toString() + ')(' + args.map(value => JSON.stringify(value)).join(',') + ')', true)
  const wait = async (condition, label, milliseconds = 20000) => {
    const deadline = Date.now() + milliseconds
    while (Date.now() < deadline) { if (await condition()) { record(label); return } await new Promise(done => setTimeout(done, 40)) }
    throw new Error('超时：' + label)
  }
  const settle = () => evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  const click = async selector => {
    let point
    await wait(async () => {
      point = await evaluate(selector => {
        const element = document.querySelector(selector)
        if (!element || element.disabled || element.closest('[inert]')) return null
        element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
        const rect = element.getBoundingClientRect(), x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2), hit = document.elementFromPoint(x, y)
        return rect.width > 0 && rect.height > 0 && (hit === element || element.contains(hit)) ? { x, y } : null
      }, selector)
      return point !== null
    }, '原生指针可命中 ' + selector)
    win.show(); win.focus(); win.webContents.focus()
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
    await settle()
  }
  const clickText = async (text, selector) => {
    await wait(() => evaluate((text, selector) => [...document.querySelectorAll(selector)].some(element => element.textContent.trim() === text), text, selector), '显示入口 ' + text)
    await evaluate((text, selector) => {
      document.querySelector('[data-pdf-text-target]')?.removeAttribute('data-pdf-text-target')
      ;[...document.querySelectorAll(selector)].find(element => element.textContent.trim() === text).setAttribute('data-pdf-text-target', '')
    }, text, selector)
    await click('[data-pdf-text-target]')
    await evaluate(() => document.querySelector('[data-pdf-text-target]')?.removeAttribute('data-pdf-text-target'))
  }
  const type = async (selector, value) => {
    await click(selector)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] })
    await win.webContents.insertText(value)
    await settle()
  }
  const snapshot = async name => writeFileSync(join(config.evidence, name + '.png'), (await win.webContents.capturePage()).toPNG())
  const panel = '[data-workspace-panel]:not([hidden])', toolbar = panel + ' [data-pdf-toolbar]'
  const maskDirection = value => ({ left: value.mask !== 'none' && value.leftFade > 0, right: value.mask !== 'none' && value.rightFade > 0 })
  const mark = label => evaluate(label => { window.__pdfProbe.mark(label) }, label)
  const stable = async (label, page, zoom) => {
    let state
    try {
      await wait(async () => {
        state = await evaluate(() => window.__pdfProbe.current())
        const elapsed = state.now - state.phaseStarted
        if (elapsed > 1500 && state.phaseCanvasMounts > 6 && state.phaseLoadingEntries > 3) throw new Error('PDF连续重建Canvas并反复Loading：' + JSON.stringify(state))
        return state.ready && state.page === String(page) && state.zoom === zoom + '%' && state.now - state.lastChangeAt >= 1000
      }, '同一已绘制PDF Canvas与宽度连续稳定1秒 ' + label, 6500)
    } finally {
      state = await evaluate(() => window.__pdfProbe.current())
      measurements.matrix.push({ label, expected: { page, zoom }, ...state })
    }
    return state
  }
  const resizePanel = async target => {
    const drag = await evaluate(target => {
      const element = document.querySelector('[aria-label=调整工作区宽度]'), handle = element.getBoundingClientRect(), panel = document.querySelector('[data-workspace]').getBoundingClientRect()
      const from = { x: Math.round(handle.x + handle.width / 2), y: Math.round(handle.y + 100) }
      const hit = document.elementFromPoint(from.x, from.y)
      if (hit !== element) throw new Error('工作区把手被遮挡：' + hit?.outerHTML.slice(0, 500))
      return { from, to: { x: from.x + panel.width - target, y: from.y }, width: panel.width }
    }, target)
    if (Math.abs(drag.width - target) < 1) return
    win.show(); win.focus(); win.webContents.focus()
    win.webContents.sendInputEvent({ type: 'mouseMove', ...drag.from })
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...drag.from })
    for (let step = 1; step <= 8; step++) {
      win.webContents.sendInputEvent({ type: 'mouseMove', modifiers: ['leftButtonDown'], x: Math.round(drag.from.x + (drag.to.x - drag.from.x) * step / 8), y: drag.from.y })
      await new Promise(done => setTimeout(done, 16))
    }
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...drag.to })
    await wait(() => evaluate(target => Math.abs(document.querySelector('[data-workspace]').getBoundingClientRect().width - target) < 1, target), '真实拖动工作区宽度到 ' + target)
  }
  const finish = async () => {
    if (finishing) return
    finishing = true; clearInterval(pidTimer); clearTimeout(watchdog)
    if (win && !win.isDestroyed()) measurements.timeline = await evaluate(() => window.__pdfProbe?.dump() ?? null).catch(error => ({ error: String(error) }))
    if (app.isReady()) for (const item of app.getAppMetrics()) ownedPids.add(item.pid)
    savePids()
    writeFileSync(join(config.evidence, 'result.json'), JSON.stringify({ passed, stage, coreOnly: config.coreOnly, checks, measurements, requests, errors, leases: [...leases], ownedPids: [...ownedPids], elapsedMs: Date.now() - started, electron: process.versions.electron, chromium: process.versions.chrome, ...failure }, null, 2))
    console.log(JSON.stringify({ passed, checks: checks.length, error: failure?.error, result: join(config.evidence, 'result.json') }))
    app.quit(); setTimeout(() => app.exit(2), 7000).unref()
  }
  const watchdog = setTimeout(() => { failure = { error: 'PDF稳定性150秒watchdog', failedStage: stage }; void finish() }, 150000)
  process.on('uncaughtException', error => { failure = { error: String(error), stack: error.stack, failedStage: stage }; void finish() })
  process.on('unhandledRejection', error => { failure = { error: String(error), stack: error?.stack, failedStage: stage }; void finish() })
  try {
    await import(config.main)
    win = await created
    win.setSize(1500, 740); win.show(); win.focus()
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push({ stage, message }) })
    await wait(() => evaluate(() => !!document.querySelector('[data-chat-header]') && typeof window.cogent?.fileViewsRequest === 'function'), '真实产品首页与文件preload就绪')
    await click('[aria-label=设置]')
    await clickText('设置', '[role=menuitem]')
    await clickText('外观', '[data-sidebar-clip] button')
    await click('[aria-label=深色浅色]')
    await clickText('跟随系统', '[role=option]')
    await click('[aria-label=首页]')
    await wait(() => evaluate(() => !!document.querySelector('[data-chat-header]') && !document.documentElement.classList.contains('dark')), '通过真实外观设置启用系统明暗并回到首页')
    await click('[aria-label=展开标签页区]')
    await click('[aria-label=打开文件导航]')
    await wait(() => evaluate(() => !!document.querySelector('[data-file-navigator]')), '未绑定项目的真实文件工作面就绪')
    if (!config.coreOnly) {
      measurements.shortBreadcrumb = await evaluate(() => {
        const nav = document.querySelector('[data-file-workspace]:not([hidden]) [aria-label=文件位置]')
        return { text: nav.textContent, mask: getComputedStyle(nav).maskImage, scrollbarWidth: getComputedStyle(nav).scrollbarWidth, clientWidth: nav.clientWidth, scrollWidth: nav.scrollWidth }
      })
      require(measurements.shortBreadcrumb.scrollWidth <= measurements.shortBreadcrumb.clientWidth && measurements.shortBreadcrumb.mask === 'none' && measurements.shortBreadcrumb.scrollbarWidth === 'none', '短面包屑无溢出、无渐隐且隐藏滚动条', measurements.shortBreadcrumb)
      const empty = await evaluate(() => {
        const sidebar = document.querySelector('[data-file-navigator]'), nav = document.querySelector('[aria-label=文件位置]'), rect = nav.getBoundingClientRect()
        return { text: sidebar.textContent, buttons: [...sidebar.querySelectorAll('button')].map(button => button.getAttribute('aria-label')), point: { x: Math.round(rect.right - 10), y: Math.round(rect.y + rect.height / 2) } }
      })
      require(empty.text.includes('当前目录为空') && !/未绑定项目|打开文件可|打开文件按钮/.test(empty.text) && empty.buttons.length === 0, '空列表仅显示当前目录为空且没有右上打开文件图标', empty)
      win.webContents.sendInputEvent({ type: 'mouseMove', ...empty.point })
      await new Promise(done => setTimeout(done, 470))
      require(await evaluate(() => ![...document.querySelectorAll('[data-slot=tooltip-content]')].some(node => node.getBoundingClientRect().width > 0 && getComputedStyle(node).visibility !== 'hidden')), '面包屑空白占位区停留不触发Tooltip')
    }
    await click('[aria-label=打开文件]')
    await wait(() => evaluate(panel => !!document.querySelector(panel + ' [data-pdf-viewport]'), panel), '仅选择外部PDF形成真实文件标签')
    await evaluate(panel => {
      const root = document.querySelector(panel + ' [data-pdf-viewport]'), ids = new WeakMap()
      let nextId = 0, stopped = false, frame, previousKey = '', previousLoading = false, previousCanvas = null, previousPage = null
      const id = element => { if (!element) return null; if (!ids.has(element)) ids.set(element, ++nextId); return ids.get(element) }
      const state = { phase: 'initial', phaseStarted: performance.now(), started: performance.now(), lastChangeAt: performance.now(), canvasMounts: 0, pageMounts: 0, loadingEntries: 0, resizeEvents: 0, mutationBatches: 0, phaseBase: { canvasMounts: 0, loadingEntries: 0 }, timeline: [] }
      const sample = reason => {
        const canvas = root.querySelector('canvas'), pageElement = root.querySelector('.react-pdf__Page'), text = root.querySelector('.react-pdf__Page__textContent')?.textContent ?? '', pageInput = root.parentElement.querySelector('[aria-label=PDF页码]')
        const canvasId = id(canvas), pageId = id(pageElement), loading = /Loading page|正在加载PDF/i.test(root.textContent)
        const value = { page: pageInput?.value, zoom: root.parentElement.querySelector('[aria-label=适配]')?.textContent, viewportWidth: root.getBoundingClientRect().width, clientWidth: root.clientWidth, offsetWidth: root.offsetWidth, scrollWidth: root.scrollWidth, clientHeight: root.clientHeight, scrollHeight: root.scrollHeight, scrollTop: root.scrollTop, scrollLeft: root.scrollLeft, canvasId, pageId, canvasWidth: canvas?.width ?? 0, canvasHeight: canvas?.height ?? 0, canvasVisibility: canvas ? getComputedStyle(canvas).visibility : null, loading, text: text.slice(0, 100) }
        value.ready = !!canvas && canvas.width > 0 && canvas.height > 0 && value.canvasVisibility !== 'hidden' && !loading && text.includes('Stable PDF page ' + value.page)
        if (canvasId !== null && canvasId !== previousCanvas) { state.canvasMounts++; previousCanvas = canvasId }
        if (pageId !== null && pageId !== previousPage) { state.pageMounts++; previousPage = pageId }
        if (loading && !previousLoading) state.loadingEntries++
        previousLoading = loading
        const key = JSON.stringify(value), now = performance.now()
        if (key !== previousKey) {
          previousKey = key; state.lastChangeAt = now
          if (state.timeline.length < 5000) state.timeline.push({ at: now - state.started, phase: state.phase, reason, ...value, canvasMounts: state.canvasMounts, pageMounts: state.pageMounts, loadingEntries: state.loadingEntries })
        }
        state.latest = value
      }
      const resize = new ResizeObserver(() => { state.resizeEvents++; sample('resize') }); resize.observe(root)
      const mutations = new MutationObserver(() => { state.mutationBatches++; sample('mutation') }); mutations.observe(root, { childList: true, subtree: true, attributes: true, characterData: true })
      const tick = () => { if (!stopped) { sample('frame'); frame = requestAnimationFrame(tick) } }; tick()
      window.__pdfProbe = {
        mark: phase => { sample('before-phase'); state.phase = phase; state.phaseStarted = performance.now(); state.phaseBase = { canvasMounts: state.canvasMounts, loadingEntries: state.loadingEntries }; state.lastChangeAt = state.phaseStarted },
        current: () => { sample('poll'); return { ...state.latest, now: performance.now(), phase: state.phase, phaseStarted: state.phaseStarted, lastChangeAt: state.lastChangeAt, canvasMounts: state.canvasMounts, pageMounts: state.pageMounts, loadingEntries: state.loadingEntries, phaseCanvasMounts: state.canvasMounts - state.phaseBase.canvasMounts, phaseLoadingEntries: state.loadingEntries - state.phaseBase.loadingEntries, resizeEvents: state.resizeEvents, mutationBatches: state.mutationBatches } },
        dump: () => ({ ...state, timeline: state.timeline }),
        stop: () => { stopped = true; cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect() }
      }
    }, panel)
    await stable('初次打开', 1, 100)
    if (!config.coreOnly) {
      measurements.openGroup = await evaluate(() => {
        const group = document.querySelector('[aria-label=文件打开操作]'), buttons = [...group.querySelectorAll('button')]
        const rects = buttons.map(button => { const r = button.getBoundingClientRect(); return { x: r.x, right: r.right, height: r.height, y: r.y, label: button.getAttribute('aria-label') } })
        return { count: buttons.length, rects, chevron: !!buttons[1].querySelector('svg.lucide-chevron-down') }
      })
      const group = measurements.openGroup
      require(group.count === 2 && group.chevron && Math.abs(group.rects[0].right - group.rects[1].x) < 1 && group.rects.every(rect => rect.height === group.rects[0].height && rect.y === group.rects[0].y), '打开与下拉菜单共用相邻等高的shadcn按钮组', group)
      await click('[data-file-toolbar] [aria-label=系统打开]')
      await wait(() => Promise.resolve(systemOpens.length === 1), '主打开动作经过真实租约到系统打开出口')
      require(systemOpens[0].replaceAll('\\', '/') === config.pdfPath.replaceAll('\\', '/'), '系统打开目标为当前预览PDF', systemOpens)
      await click('[data-file-toolbar] [aria-label=文件操作]')
      await wait(() => evaluate(() => [...document.querySelectorAll('[role=menuitem]')].some(item => item.textContent === '打开本地文件…') && [...document.querySelectorAll('[role=menuitem]')].some(item => item.textContent === '文件信息')), '融合下拉菜单保留本地文件选择与已有文件动作')
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      await settle()
    }
    measurements.external = await evaluate(pdfPath => {
      const scope = document.querySelector('[data-file-workspace]:not([hidden])'), breadcrumb = scope.querySelector('[aria-label=文件位置]')
      return { expectedPath: pdfPath.replaceAll('\\', '/'), breadcrumb: breadcrumb.textContent.replaceAll('\\', '/'), parts: [...breadcrumb.querySelectorAll('li')].map(item => item.textContent), treeItems: [...scope.querySelectorAll('[role=treeitem]')].map(item => item.getAttribute('aria-label')), rootLabel: scope.querySelector('[data-file-root-label]')?.textContent, text: scope.querySelector('[data-file-navigator]').textContent }
    }, config.pdfPath)
    if (!config.coreOnly) {
      require(measurements.external.treeItems.length === 0, '未绑定workspace的外部文件不充当文件树根', measurements.external)
      const expectedParts = config.pdfPath.replaceAll('\\', '/').split('/').filter(Boolean)
      require(expectedParts.every(part => measurements.external.parts.some(value => value.includes(part))), '外部文件面包屑包含盘符到文件名的完整路径', measurements.external)
      const breadcrumbGeometry = () => evaluate(() => {
        const nav = document.querySelector('[data-file-workspace]:not([hidden]) [aria-label=文件位置]'), current = nav.querySelector('[aria-current=page]'), first = nav.querySelector('[data-slot=breadcrumb-item]')
        const rect = element => { const value = element.getBoundingClientRect(); return { x: value.x, y: value.y, right: value.right, bottom: value.bottom, width: value.width, height: value.height } }
        const navRect = rect(nav), currentRect = rect(current), firstRect = rect(first), style = getComputedStyle(nav), header = nav.closest('[data-file-toolbar]'), headerRect = rect(header)
        const buttons = [...header.querySelectorAll('button')].map(button => { const value = rect(button); return { label: button.getAttribute('aria-label'), centerY: value.y + value.height / 2, ...value } })
        return { workspaceWidth: document.querySelector('[data-workspace]').getBoundingClientRect().width, nav: navRect, current: { text: current.textContent, ...currentRect }, first: { text: first.textContent, ...firstRect }, clientWidth: nav.clientWidth, scrollWidth: nav.scrollWidth, scrollLeft: nav.scrollLeft, clientHeight: nav.clientHeight, offsetHeight: nav.offsetHeight, overflowX: style.overflowX, scrollbarWidth: style.scrollbarWidth, mask: style.maskImage, leftFade: parseFloat(style.getPropertyValue('--scroll-fade-left')), rightFade: parseFloat(style.getPropertyValue('--scroll-fade-right')), header: headerRect, headerCenterY: headerRect.y + headerRect.height / 2, textCenterY: currentRect.y + currentRect.height / 2, buttons, currentFullyVisible: currentRect.x >= navRect.x - 1 && currentRect.right <= navRect.right + 1, firstFullyVisible: firstRect.x >= navRect.x - 1 && firstRect.right <= navRect.right + 1, title: nav.getAttribute('title') }
      })
      const verifyBreadcrumb = async (label, expected) => {
        let value
        await wait(async () => { value = await breadcrumbGeometry(); const direction = maskDirection(value); return direction.left === expected.left && direction.right === expected.right }, '面包屑渐隐方向随实际可滚动方向更新 ' + label)
        require(value.scrollbarWidth === 'none' && value.offsetHeight - value.clientHeight < 1 && value.header.height === 40 && Math.abs(value.textCenterY - value.headerCenterY) < 1 && value.buttons.every(button => Math.abs(button.centerY - value.headerCenterY) < 1), '面包屑无滚动条、不挤压40px工具行并保持文字按钮居中 ' + label, value)
        require(value.mask.startsWith('linear-gradient(') && value.leftFade === (expected.left ? 24 : 0) && value.rightFade === (expected.right ? 24 : 0), '只有仍可滚动的边缘启用共享24px mask ' + label, value)
        return value
      }
      const initial = await breadcrumbGeometry()
      require(Math.abs(initial.workspaceWidth - 480) < 1 && initial.scrollWidth > initial.clientWidth && initial.currentFullyVisible && initial.current.text === 'external-two-pages.pdf', '480px工作区长路径初始滚到末尾且当前文件名完整可见', initial)
      await verifyBreadcrumb('浅色初始末尾', { left: true, right: false })
      // 只操作实际DOM滚动节点，验证长路径可以回看盘符；不注入工作区或文件store。
      await evaluate(() => { document.querySelector('[data-file-workspace]:not([hidden]) [aria-label=文件位置]').scrollLeft = 0 })
      await wait(() => evaluate(() => document.querySelector('[data-file-workspace]:not([hidden]) [aria-label=文件位置]').scrollLeft === 0), '面包屑可以横向滚回完整路径起点')
      const front = await verifyBreadcrumb('浅色起点', { left: false, right: true })
      require(front.firstFullyVisible && front.first.text === expectedParts[0] && !front.currentFullyVisible, '长路径前部保留原段宽并完整显示盘符', front)
      await snapshot('breadcrumb-path-start-480')
      await evaluate(() => { const nav = document.querySelector('[data-file-workspace]:not([hidden]) [aria-label=文件位置]'); nav.scrollLeft = (nav.scrollWidth - nav.clientWidth) / 2 })
      const middle = await verifyBreadcrumb('浅色中间', { left: true, right: true })
      await snapshot('breadcrumb-path-middle-light')
      await evaluate(() => { const nav = document.querySelector('[data-file-workspace]:not([hidden]) [aria-label=文件位置]'); nav.scrollLeft = nav.scrollWidth })
      await wait(async () => (await breadcrumbGeometry()).currentFullyVisible, '面包屑可以再次滚回末尾完整文件名')
      const end = await verifyBreadcrumb('浅色末尾', { left: true, right: false })
      require(end.scrollLeft > front.scrollLeft && end.currentFullyVisible && end.current.text === initial.current.text, '横向往返不截断或压缩当前文件名', end)
      measurements.breadcrumb = { initial, front, middle, end, dark: [] }
      await snapshot('breadcrumb-path-end-480')
      nativeTheme.themeSource = 'dark'
      await wait(() => evaluate(() => document.documentElement.classList.contains('dark')), '真实系统深色主题生效')
      await new Promise(done => setTimeout(done, 150))
      for (const position of [{ name: 'start', ratio: 0, left: false, right: true }, { name: 'middle', ratio: 0.5, left: true, right: true }, { name: 'end', ratio: 1, left: true, right: false }]) {
        await evaluate(ratio => { const nav = document.querySelector('[data-file-workspace]:not([hidden]) [aria-label=文件位置]'); nav.scrollLeft = (nav.scrollWidth - nav.clientWidth) * ratio }, position.ratio)
        measurements.breadcrumb.dark.push({ position: position.name, ...await verifyBreadcrumb('深色' + position.name, position) })
        await snapshot('breadcrumb-path-' + position.name + '-dark')
      }
      nativeTheme.themeSource = 'light'
      await wait(() => evaluate(() => !document.documentElement.classList.contains('dark')), '真实系统浅色主题恢复')
      await new Promise(done => setTimeout(done, 150))
      const hover = await evaluate(() => {
        const nav = document.querySelector('[data-file-workspace]:not([hidden]) [aria-label=文件位置]'), filename = nav.querySelector('[aria-current=page]'), rect = filename.getBoundingClientRect()
        const x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2), hit = document.elementFromPoint(x, y)
        return { point: { x, y }, hit: filename === hit || filename.contains(hit), title: filename.getAttribute('title'), navTrigger: nav.hasAttribute('data-base-ui-tooltip-trigger') }
      })
      require(hover.hit && hover.title === null && !hover.navTrigger, '完整路径Tooltip只绑定实际文件名，不绑定整个面包屑占位区', hover)
      const hoveredAt = Date.now()
      win.webContents.sendInputEvent({ type: 'mouseMove', ...hover.point })
      await new Promise(done => setTimeout(done, 460))
      await wait(() => evaluate(expected => [...document.querySelectorAll('[data-slot=tooltip-content]')].some(element => element.getBoundingClientRect().width > 0 && getComputedStyle(element).visibility !== 'hidden' && element.textContent.replaceAll('\\', '/').includes(expected.replaceAll('\\', '/'))), config.pdfPath), '真实指针停留后Tooltip仍显示完整绝对路径', 5000)
      measurements.breadcrumb.tooltip = { dwellMs: Date.now() - hoveredAt, text: await evaluate(() => [...document.querySelectorAll('[data-slot=tooltip-content]')].map(element => element.textContent).join('\n')) }
      await new Promise(done => setTimeout(done, 130))
      await snapshot('breadcrumb-full-path-tooltip')
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 4, y: 4 })
      await wait(() => evaluate(() => [...document.querySelectorAll('[data-slot=tooltip-content]')].every(element => element.getBoundingClientRect().width === 0 || getComputedStyle(element).visibility === 'hidden')), '面包屑Tooltip在指针离开后退场', 5000)
    }
    measurements.pageInput = await evaluate(toolbar => {
      const root = document.querySelector(toolbar), input = root.querySelector('[aria-label=PDF页码]'), rect = input.getBoundingClientRect(), controls = [...root.querySelectorAll('button,input')].map(element => { const value = element.getBoundingClientRect(); return { label: element.getAttribute('aria-label'), width: value.width, height: value.height, centerY: value.y + value.height / 2 } })
      const count = input.nextElementSibling.getBoundingClientRect(), next = root.querySelector('[aria-label=下一页]').getBoundingClientRect()
      return { width: rect.width, height: rect.height, toolbarWidth: root.clientWidth, scrollWidth: root.scrollWidth, controls, leftGap: count.left - rect.right, rightGap: next.left - count.right }
    }, toolbar)
    if (!config.coreOnly) require(measurements.pageInput.height <= 28 && measurements.pageInput.width <= 48 && measurements.pageInput.controls.every(control => Math.abs(control.centerY - measurements.pageInput.controls[0].centerY) < 1), '页码使用紧凑高度并与图标同一行居中', measurements.pageInput)
    if (!config.coreOnly) require(measurements.pageInput.leftGap >= 5.5 && measurements.pageInput.rightGap >= 5.5 && Math.abs(measurements.pageInput.leftGap - measurements.pageInput.rightGap) < 1, '页码输入与总页数两侧留出一致6px间距', measurements.pageInput)
    await snapshot('external-pdf-initial')
    for (const width of config.widths) {
      stage = 'PDF稳定性宽' + width
      await mark('宽' + width + '-适配')
      await click(toolbar + ' [aria-label=适配]')
      await resizePanel(width)
      await stable('宽' + width + '-100%', 1, 100)
      for (const zoom of [125, 150, 175, 200, 225, 250, 275, 300]) {
        await mark('宽' + width + '-放大至' + zoom + '%')
        await click(toolbar + ' [aria-label=放大]')
        const result = await stable('宽' + width + '-' + zoom + '%', 1, zoom)
        if (zoom === 150 || zoom === 300) await snapshot('pdf-width-' + width + '-zoom-' + zoom)
        require(result.ready && result.phaseCanvasMounts <= 3, '单次放大完成后不反复重建Page ' + width + '/' + zoom, result)
      }
    }
    stage = '翻页与真实文本选中'
    await mark('重置适配')
    await click(toolbar + ' [aria-label=适配]')
    await stable('适配重置', 1, 100)
    await mark('下一页')
    await click(toolbar + ' [aria-label=下一页]')
    await stable('真实翻页到第2页', 2, 100)
    await mark('页码输入')
    await type(toolbar + ' [aria-label=PDF页码]', '1')
    await stable('原生页码输入回第1页', 1, 100)
    const selection = await evaluate(panel => {
      const span = [...document.querySelectorAll(panel + ' .react-pdf__Page__textContent span')].find(element => element.textContent.includes('Stable PDF page 1'))
      span.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      const rect = span.getBoundingClientRect()
      return { from: { x: Math.round(rect.left + 2), y: Math.round(rect.top + rect.height / 2) }, to: { x: Math.round(rect.right - 2), y: Math.round(rect.top + rect.height / 2) } }
    }, panel)
    win.webContents.focus()
    win.webContents.sendInputEvent({ type: 'mouseMove', ...selection.from })
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...selection.from })
    for (let step = 1; step <= 8; step++) {
      win.webContents.sendInputEvent({ type: 'mouseMove', modifiers: ['leftButtonDown'], x: Math.round(selection.from.x + (selection.to.x - selection.from.x) * step / 8), y: selection.from.y })
      await new Promise(done => setTimeout(done, 16))
    }
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...selection.to })
    await wait(() => evaluate(() => (window.getSelection()?.toString().trim().length ?? 0) >= 5), '真实鼠标拖动选择PDF文字')
    measurements.selection = { ...selection, text: await evaluate(() => window.getSelection().toString()) }
    await snapshot('pdf-selected-text')
    await evaluate(() => { window.__pdfProbe.stop() })
    if (!config.coreOnly) {
      stage = '标签栏边缘渐隐'
      for (let index = 0; index < 6; index++) await click('[aria-label=新建标签页]')
      measurements.tabFade = []
      for (const theme of ['light', 'dark']) {
        nativeTheme.themeSource = theme
        await wait(() => evaluate(dark => document.documentElement.classList.contains('dark') === dark, theme === 'dark'), '标签栏真实主题生效 ' + theme)
        for (const position of [{ name: 'start', ratio: 0, left: false, right: true }, { name: 'middle', ratio: 0.5, left: true, right: true }, { name: 'end', ratio: 1, left: true, right: false }]) {
          await evaluate(ratio => { const list = document.querySelector('[aria-label=工作区标签页]'); list.scrollLeft = (list.scrollWidth - list.clientWidth) * ratio }, position.ratio)
          let value
          await wait(async () => {
            value = await evaluate(() => {
              const list = document.querySelector('[aria-label=工作区标签页]'), style = getComputedStyle(list)
              return { clientWidth: list.clientWidth, scrollWidth: list.scrollWidth, scrollLeft: list.scrollLeft, clientHeight: list.clientHeight, offsetHeight: list.offsetHeight, scrollbarWidth: style.scrollbarWidth, mask: style.maskImage, leftFade: parseFloat(style.getPropertyValue('--scroll-fade-left')), rightFade: parseFloat(style.getPropertyValue('--scroll-fade-right')) }
            })
            return value.leftFade === (position.left ? 24 : 0) && value.rightFade === (position.right ? 24 : 0)
          }, '标签栏仅可继续滚动的一侧渐隐 ' + theme + '/' + position.name)
          require(value.scrollWidth > value.clientWidth && value.scrollbarWidth === 'none' && value.offsetHeight - value.clientHeight < 1 && value.mask.startsWith('linear-gradient('), '溢出标签栏隐藏滚动条并使用共享渐隐 ' + theme + '/' + position.name, value)
          measurements.tabFade.push({ theme, position: position.name, ...value })
          await snapshot('tabs-fade-' + theme + '-' + position.name)
        }
      }
    }
    await click('[aria-label=标签页列表]')
    await evaluate(() => { const button = [...document.querySelectorAll('[data-slot=popover-content] button')].find(element => element.textContent === '关闭全部标签页'); if (!button) throw new Error('关闭全部入口缺失'); button.setAttribute('data-pdf-close-all', '') })
    await click('[data-pdf-close-all]')
    await wait(() => Promise.resolve(leases.size === 0), '关闭文件后真实Host租约归零')
    require(errors.length === 0, 'renderer没有控制台错误', errors)
    passed = true
  } catch (error) {
    failure = { error: String(error), stack: error.stack, failedStage: stage }
    if (win && !win.isDestroyed()) {
      await snapshot('failure').catch(() => {})
      failure.dom = await evaluate(() => ({ text: document.body.innerText.slice(-10000), focus: document.activeElement?.outerHTML.slice(0, 1200) })).catch(() => null)
    }
  } finally { await finish() }
}

let child, timer, interrupted = false
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const stop = () => { interrupted = true; if (child && child.exitCode === null) child.kill() }
process.once('SIGINT', stop); process.once('SIGTERM', stop)
try {
  const config = { main: pathToFileURL(resolve('out/main/index.js')).href, profile: join(temporary, 'profile'), evidence, pdfPath, widths, coreOnly: process.argv.includes('--pdf-only') }
  const driverPath = join(temporary, 'driver.mjs'), resultPath = join(evidence, 'result.json'), pidsPath = join(evidence, 'owned-pids.json')
  writeFileSync(driverPath, '(' + driver.toString() + ')(' + JSON.stringify(config) + ');')
  for (const path of [resultPath, pidsPath]) rmSync(path, { force: true })
  const env = { ...process.env, COGENT_HOME: home, HOME: home, USERPROFILE: home, NODE_ENV: 'production' }
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  let timedOut = false
  child = spawn(electron, [driverPath], { cwd: repository, env, stdio: 'inherit', windowsHide: true })
  timer = setTimeout(() => { timedOut = true; child.kill() }, 180000)
  const exitCode = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done) })
  clearTimeout(timer)
  const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : { passed: false, error: 'Electron未写入结果' }
  const ownedPids = [...new Set([child.pid, ...(existsSync(pidsPath) ? JSON.parse(readFileSync(pidsPath, 'utf8')) : [])])].filter(Boolean)
  const deadline = Date.now() + 5000
  while (ownedPids.some(alive) && Date.now() < deadline) await new Promise(done => setTimeout(done, 100))
  const forcedPids = ownedPids.filter(alive)
  for (const pid of forcedPids) { try { process.kill(pid) } catch {} }
  const forceDeadline = Date.now() + 5000
  while (ownedPids.some(alive) && Date.now() < forceDeadline) await new Promise(done => setTimeout(done, 100))
  result.cleanup = { exitCode, timedOut, interrupted, ownedPids, forcedPids, remainingPids: ownedPids.filter(alive) }
  if (exitCode !== 0 || timedOut || interrupted || forcedPids.length > 0 || result.cleanup.remainingPids.length > 0) result.passed = false
  writeFileSync(resultPath, JSON.stringify(result, null, 2))
  if (!result.passed) process.exitCode = 1
} finally {
  clearTimeout(timer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop)
  if (child && child.exitCode === null) child.kill()
  const safe = relative(resolve(tmpdir()), resolve(temporary))
  assert.ok(!isAbsolute(safe) && !safe.startsWith('..') && safe.startsWith('cogent-pdf-stability-'), '只删除本次生成的系统临时目录')
  const resultPath = join(evidence, 'result.json'), result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : { passed: false }
  const remainingPids = result.cleanup?.remainingPids ?? (child?.pid && alive(child.pid) ? [child.pid] : [])
  if (remainingPids.length === 0) rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  const summary = { passed: result.passed === true && remainingPids.length === 0, checks: result.checks?.length ?? 0, temporaryProfileRemoved: remainingPids.length === 0, remainingPids, result: resultPath }
  writeFileSync(join(evidence, 'summary.json'), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary, null, 2))
  if (!summary.passed) process.exitCode = 1
}
