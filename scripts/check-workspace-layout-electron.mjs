/** 标签工作区布局验收：真实产品与原生输入；仅替代原生文件选择，profile、Host、端口和进程隔离。 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import electron from 'electron'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(repository)
for (const entry of ['out/main/index.js', 'out/main/host.js', 'out/preload/index.cjs', 'out/renderer/index.html']) {
  assert.ok(existsSync(resolve(entry)), '缺少产品构建：' + entry + '；脚本不自动build')
}
const temporary = mkdtempSync(join(tmpdir(), 'cogent-workspace-layout-'))
const evidence = resolve(process.env.WORKSPACE_LAYOUT_EVIDENCE ?? 'tmp/workspace-layout-electron')
const home = join(temporary, 'home'), workspace = join(temporary, 'layout-fixture')
for (const directory of [home, workspace, evidence]) mkdirSync(directory, { recursive: true })
writeFileSync(join(home, 'settings.json'), JSON.stringify({ version: 1, closeBehavior: 'quit', soundEnabled: false, toastEnabled: false }))
writeFileSync(join(workspace, 'readme.md'), '# 文件布局验收\n\n' + Array.from({ length: 100 }, (_, index) => '## 章节 ' + index + '\n\n文件树与正文应左右并排。收起文件树应保留文件节点、租约与阅读位置。\n\n').join(''))
writeFileSync(join(workspace, 'notes.txt'), 'Native file picker fixture\n')
// 自有两页PDF夹具固定文字与页数，避免借用上游样本的版权、页数或字体依赖。
function twoPagePdf() {
  const pageText = page => 'BT /F1 18 Tf 32 700 Td (Workspace PDF page ' + page + ') Tj ET\n'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    ...[1, 2].map(page => '<< /Length ' + Buffer.byteLength(pageText(page)) + ' >>\nstream\n' + pageText(page) + 'endstream'),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let text = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(text)); text += (index + 1) + ' 0 obj\n' + object + '\nendobj\n'
  }
  const xref = Buffer.byteLength(text)
  text += 'xref\n0 ' + offsets.length + '\n0000000000 65535 f \n' + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')
  return Buffer.from(text + 'trailer\n<< /Size ' + offsets.length + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n')
}
writeFileSync(join(workspace, 'two-pages.pdf'), twoPagePdf())

async function driver(config) {
  const { app, dialog, ipcMain, nativeTheme, webContents } = await import('electron')
  const { writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const childProcess = (await import('node:child_process')).default
  const ownedPids = new Set([process.pid]), checks = [], measurements = {}, requests = [], errors = [], nativePickers = []
  const fileLeases = new Set(), browserLeases = new Set()
  const projectName = '布局验收项目'
  const started = Date.now()
  let win, stage = '启动真实产品', passed = false, failure, finishing = false
  const savePids = () => writeFileSync(join(config.evidence, 'owned-pids.json'), JSON.stringify([...ownedPids]))
  const originalSpawn = childProcess.spawn
  childProcess.spawn = (...args) => {
    const child = originalSpawn(...args)
    if (child.pid) { ownedPids.add(child.pid); savePids() }
    return child
  }
  ;(await import('node:module')).syncBuiltinESMExports()
  savePids()
  app.setPath('userData', config.profile)
  app.commandLine.appendSwitch('force-device-scale-factor', '1')
  nativeTheme.themeSource = 'light'
  const created = new Promise(done => app.once('browser-window-created', (_event, value) => done(value)))
  const filePickerQueue = ['notes.txt', 'two-pages.pdf']
  dialog.showOpenDialog = async (_window, options) => {
    const directory = options.properties.includes('openDirectory'), file = options.properties.includes('openFile')
    if (!directory && !file) throw new Error('验收未计划的原生选择器：' + JSON.stringify(options))
    if (directory && options.title !== '选择项目文件夹') throw new Error('目录只能经真实项目创建入口选择：' + JSON.stringify(options))
    const name = directory ? null : filePickerQueue.shift()
    if (!directory && name === undefined) throw new Error('验收未计划的额外文件选择')
    const selected = directory ? config.workspace : join(config.workspace, name)
    nativePickers.push({ title: options.title, properties: options.properties, selected })
    return { canceled: false, filePaths: [selected] }
  }
  const originalHandle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, listener) => originalHandle(channel, async (event, ...args) => {
    if (channel !== 'fileViews:request' && channel !== 'cogent:browser:request') return listener(event, ...args)
    const payload = args[0], item = { channel, method: payload.method, params: payload.params, stage, at: Date.now() - started }
    requests.push(item)
    try {
      const result = await listener(event, ...args)
      if (payload.method === 'fileViews.acquire') fileLeases.add(result.leaseId)
      if (payload.method === 'fileViews.release') fileLeases.delete(payload.params.leaseId)
      if (payload.method === 'reserve') browserLeases.add(result.lease)
      if (payload.method === 'release' || payload.method === 'close' && result.closed && !result.keepMounted) browserLeases.delete(payload.params.lease)
      item.ok = true
      return result
    } catch (error) { item.error = String(error); throw error }
  })
  const pidTimer = setInterval(() => {
    if (app.isReady()) for (const metric of app.getAppMetrics()) ownedPids.add(metric.pid)
    savePids()
  }, 250)
  pidTimer.unref()
  const record = name => { checks.push(name); console.log('[布局验收] ' + name) }
  const require = (condition, label, value) => { if (!condition) throw new Error(label + (value === undefined ? '' : '：' + JSON.stringify(value))); record(label) }
  const evaluate = (fn, ...args) => win.webContents.executeJavaScript('(' + fn.toString() + ')(' + args.map(value => JSON.stringify(value)).join(',') + ')', true)
  const wait = async (condition, label, milliseconds = 30000) => {
    const end = Date.now() + milliseconds
    while (Date.now() < end) {
      if (await condition()) { record(label); return }
      await new Promise(done => setTimeout(done, 40))
    }
    throw new Error('超时：' + label)
  }
  const settle = () => evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  const click = async (selector, clickCount = 1) => {
    await wait(() => evaluate(selector => {
      const element = document.querySelector(selector)
      return !!element && !element.disabled && element.getAttribute('aria-disabled') !== 'true' && !element.closest('[inert]') && element.getBoundingClientRect().width > 0
    }, selector), '控件就绪 ' + selector)
    let point
    await wait(async () => {
      point = await evaluate(selector => {
        const element = document.querySelector(selector)
        if (!element) return null
        element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
        const rect = element.getBoundingClientRect(), tablist = element.closest('[role=tablist]')?.getBoundingClientRect()
        const left = Math.max(rect.left, tablist?.left ?? 0), right = Math.min(rect.right, tablist?.right ?? innerWidth)
        const x = Math.round((left + right) / 2), y = Math.round(rect.y + rect.height / 2), hit = document.elementFromPoint(x, y)
        return right > left && (hit === element || element.contains(hit)) ? { x, y } : null
      }, selector)
      return point !== null
    }, '原生指针命中 ' + selector)
    win.show(); win.focus(); win.webContents.focus()
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount, ...point })
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount, ...point })
    await settle()
  }
  const clickText = async (text, selector) => {
    await wait(() => evaluate((text, selector) => [...document.querySelectorAll(selector)].some(element => element.textContent.trim() === text), text, selector), '显示入口 ' + text)
    await evaluate((text, selector) => {
      document.querySelector('[data-layout-target]')?.removeAttribute('data-layout-target')
      ;[...document.querySelectorAll(selector)].find(element => element.textContent.trim() === text).setAttribute('data-layout-target', '')
    }, text, selector)
    await click('[data-layout-target]')
    await evaluate(() => document.querySelector('[data-layout-target]')?.removeAttribute('data-layout-target'))
  }
  const key = async keyCode => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
    await settle()
  }
  const type = async (selector, value) => {
    await click(selector)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] })
    await win.webContents.insertText(value)
    await settle()
  }
  const hint = async (selector, expected) => {
    // 原生点击标签头留白解除键盘焦点提示，使这次证据只来自指针停留。
    const neutral = await evaluate(() => {
      const header = document.querySelector('[data-workspace-header]'), rect = header.getBoundingClientRect()
      const x = Math.round(rect.right - 4), y = Math.round(rect.top + 2), hit = document.elementFromPoint(x, y)
      if (!header.contains(hit) || hit.closest('button,[role=tab]')) throw new Error('标签头中性点击点被交互控件占据')
      return { x, y }
    })
    win.show(); win.focus(); win.webContents.focus()
    win.webContents.sendInputEvent({ type: 'mouseMove', ...neutral })
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...neutral })
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...neutral })
    await settle()
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 4, y: 4 })
    await wait(() => evaluate(() => [...document.querySelectorAll('[data-slot=tooltip-content]')].every(element => element.getBoundingClientRect().width === 0 || getComputedStyle(element).visibility === 'hidden')), '旧Tooltip已退场', 5000)
    const target = await evaluate(selector => {
      const element = document.querySelector(selector)
      if (!element) throw new Error('Tooltip目标不存在：' + selector)
      element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
      const rect = element.getBoundingClientRect(), list = element.closest('[role=tablist]')?.getBoundingClientRect()
      const left = Math.max(rect.left, list?.left ?? 0), right = Math.min(rect.right, list?.right ?? innerWidth)
      const x = Math.round((left + right) / 2), y = Math.round(rect.y + rect.height / 2), hit = document.elementFromPoint(x, y)
      return { point: { x, y }, title: element.getAttribute('title'), hit: right > left && (hit === element || element.contains(hit)) }
    }, selector)
    require(target.title === null && target.hit, 'Tooltip使用无原生title的实际可命中控件 ' + selector, target)
    win.show(); win.focus(); win.webContents.focus()
    const started = Date.now()
    win.webContents.sendInputEvent({ type: 'mouseMove', ...target.point })
    // 真实指针停留跨过项目400ms提示延迟，不通过focus或直接修改Tooltip状态。
    await new Promise(done => setTimeout(done, 460))
    await wait(() => evaluate(expected => [...document.querySelectorAll('[data-slot=tooltip-content]')].some(element => element.getBoundingClientRect().width > 0 && getComputedStyle(element).visibility !== 'hidden' && element.textContent.includes(expected)), expected), 'shadcn Tooltip显示 ' + expected, 5000)
    ;(measurements.tooltips ??= []).push({ selector, expected, dwellMs: Date.now() - started })
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 4, y: 4 })
    await wait(() => evaluate(() => [...document.querySelectorAll('[data-slot=tooltip-content]')].every(element => element.getBoundingClientRect().width === 0 || getComputedStyle(element).visibility === 'hidden')), 'Tooltip指针移开后退场', 5000)
  }
  const snapshot = async name => {
    await settle()
    await evaluate(() => Promise.allSettled(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished)))
    await win.webContents.capturePage()
    // 明暗切换与Popover动画后的首个capture可能仍取到旧合成帧。
    await new Promise(done => setTimeout(done, 120))
    writeFileSync(join(config.evidence, name + '.png'), (await win.webContents.capturePage()).toPNG())
  }
  const activePanel = '[data-workspace-panel]:not([hidden])'
  const popover = '[data-slot=popover-content]'
  const geometry = () => evaluate(() => {
    const rect = selector => {
      const element = document.querySelector(selector), value = element.getBoundingClientRect()
      return { x: value.x, y: value.y, width: value.width, height: value.height, right: value.right, bottom: value.bottom, inert: element.inert }
    }
    const workspace = document.querySelector('[data-workspace]')
    return { viewport: innerWidth, frame: rect('[data-workspace-frame]'), workspace: rect('[data-workspace]'), chat: rect('[data-chat-header]'), header: rect('[data-workspace-header]'), mode: workspace.dataset.workspaceMode, overflow: document.documentElement.scrollWidth > innerWidth, workspaceHeaders: workspace.querySelectorAll('[data-workspace-header]').length, chatToggle: !!document.querySelector('[data-chat-header] [aria-label=展开标签页区]'), back: !!workspace.querySelector('[aria-label=返回对话]') }
  })
  const verifySplit = async label => {
    await wait(() => evaluate(() => document.querySelector('[data-workspace]')?.dataset.workspaceMode === 'split' && document.querySelector('[data-workspace-header]')?.getBoundingClientRect().height === 48), '并排布局就绪 ' + label)
    const value = await geometry()
    require(value.mode === 'split' && value.workspace.width < value.frame.width && value.workspace.width > 0 && Math.abs(value.workspace.right - value.frame.right) < 1 && !value.overflow, '窗口宽度不自动覆盖对话 ' + label, value)
    require(value.workspaceHeaders === 1 && value.header.height === 48 && value.chat.height === 48 && Math.abs(value.header.y - value.chat.y) < 1 && !value.chatToggle && !value.back, '单行标签栏与对话头部对齐 ' + label, value)
    return value
  }
  const verifyAutomaticCollapse = async label => {
    await wait(() => evaluate(() => {
      const sidebar = document.querySelector('[data-sidebar-clip]'), workspace = document.querySelector('[data-workspace]')
      return sidebar.inert && sidebar.getBoundingClientRect().width === 0 && workspace.inert && getComputedStyle(workspace).visibility === 'hidden' && !!document.querySelector('[aria-label=展开标签页区]')
    }), '跨760px会话侧栏与工作区同时自动隐藏 ' + label)
    const value = await evaluate(() => ({ viewport: innerWidth, sidebarWidth: document.querySelector('[data-sidebar-clip]').getBoundingClientRect().width, sidebarInert: document.querySelector('[data-sidebar-clip]').inert, workspaceInert: document.querySelector('[data-workspace]').inert, workspaceVisibility: getComputedStyle(document.querySelector('[data-workspace]')).visibility }))
    ;(measurements.automaticCollapse ??= []).push({ label, ...value })
  }
  const finish = async () => {
    if (finishing) return
    finishing = true; clearInterval(pidTimer); clearTimeout(watchdog)
    if (app.isReady()) for (const metric of app.getAppMetrics()) ownedPids.add(metric.pid)
    savePids()
    writeFileSync(join(config.evidence, 'result.json'), JSON.stringify({ passed, stage, checks, measurements, requests, nativePickers, errors, fileLeases: [...fileLeases], browserLeases: [...browserLeases], ownedPids: [...ownedPids], elapsedMs: Date.now() - started, electron: process.versions.electron, chromium: process.versions.chrome, ...failure }, null, 2))
    console.log(JSON.stringify({ passed, checks: checks.length, error: failure?.error, result: join(config.evidence, 'result.json') }))
    app.quit(); setTimeout(() => app.exit(2), 7000).unref()
  }
  const watchdog = setTimeout(() => { failure = { error: '布局验收210秒watchdog', failedStage: stage }; void finish() }, 210000)
  process.on('uncaughtException', error => { failure = { error: String(error), stack: error.stack, failedStage: stage }; void finish() })
  process.on('unhandledRejection', error => { failure = { error: String(error), stack: error?.stack, failedStage: stage }; void finish() })
  try {
    await import(config.main)
    win = await created
    win.setSize(1500, 1000); win.show(); win.focus()
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push({ stage, message }) })
    await wait(() => evaluate(() => !!document.querySelector('[data-chat-header]') && typeof window.cogent?.engineRequest === 'function'), '真实产品首页与preload就绪')
    await click('[aria-label=设置]')
    await clickText('设置', '[role=menuitem]')
    await clickText('外观', '[data-sidebar-clip] button')
    await click('[aria-label=深色浅色]')
    await clickText('跟随系统', '[role=option]')
    await click('[aria-label=首页]')
    await wait(() => evaluate(() => !!document.querySelector('[data-chat-header]')), '从真实外观设置启用跟随系统并回到首页')
    const sessionsBefore = await evaluate(() => window.cogent.engineRequest('session.list', {}))
    await click('[aria-label=展开标签页区]')
    await wait(() => evaluate(() => !!document.querySelector('[data-workspace-launcher]')), '真实新标签页水合')
    await wait(() => evaluate(() => document.activeElement?.matches('[role=tab][aria-selected=true]')), '展开入口消失后焦点交给活动标签')
    measurements.initial = await verifySplit('1500px初始')
    measurements.launcher = await evaluate(() => {
      const root = document.querySelector('[data-workspace-launcher]'), title = root.querySelector('h1').getBoundingClientRect()
      const items = [...root.querySelectorAll('[data-slot=item]')].map(item => {
        const value = element => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right } }
        return { media: value(item.querySelector('[data-slot=item-media]')), content: value(item.querySelector('[data-slot=item-content]')), action: value(item.querySelector('button')) }
      })
      return { title: { x: title.x, y: title.y, height: title.height }, items, heading: root.querySelector('h1').textContent }
    })
    require(measurements.launcher.heading === '新标签页' && measurements.launcher.items.length === 2 && measurements.launcher.items.every(item => item.media.right <= item.content.x && item.content.right <= item.action.x + 1) && measurements.launcher.items[0].media.y > measurements.launcher.title.y + measurements.launcher.title.height && measurements.launcher.items[1].media.y > measurements.launcher.items[0].media.y, '启动器为标题与纵向图标/说明/打开操作', measurements.launcher)
    require(await evaluate(() => {
      const launcher = document.querySelector('[data-workspace-launcher]')
      return launcher.querySelectorAll('button').length === 2 && !/临时浏览|最近关闭/.test(launcher.textContent)
    }), '新标签页仅有文件与浏览器，不显示临时浏览或最近关闭')
    const order = await evaluate(() => {
      const header = document.querySelector('[data-workspace-header]')
      return ['[aria-label=标签页列表]', '[aria-label=工作区标签页]', '[aria-label=新建标签页]', '[aria-label=展开工作区]', '[aria-label=收起工作区]'].map(selector => { const value = header.querySelector(selector).getBoundingClientRect(); return { selector, x: value.x, right: value.right } })
    })
    measurements.headerOrder = order
    require(order.every((item, index) => index === 0 || item.x >= order[index - 1].right - 1), '标签栏顺序为列表/标签/新建/占满/折叠', order)
    await hint('[aria-label=工作区标签页] [role=tab][aria-selected=true]', '新标签页')
    await hint('[aria-label=新建标签页]', '新建标签页（Ctrl+T）')
    await snapshot('launcher-light-wide')

    stage = '窄窗任意展开与原生拖动折叠'
    win.setSize(760, 1000)
    await verifyAutomaticCollapse('首次从宽窗进入断点')
    await snapshot('launcher-auto-hidden-760')
    win.setSize(850, 1000)
    await verifySplit('自动收起后放宽恢复原开态')
    measurements.narrow = []
    for (const width of [850, 760, 680, 600]) {
      win.setSize(width, 1000)
      await wait(() => evaluate(width => innerWidth === width, win.getContentBounds().width), '窗口实际缩至 ' + width)
      if (width === 760) await verifyAutomaticCollapse('850px缩至760px')
      else await click('[aria-label=收起工作区]')
      await click('[aria-label=展开标签页区]')
      measurements.narrow.push({ requested: width, ...await verifySplit(width + 'px重新展开') })
      if (width === 680) await snapshot('launcher-light-narrow')
    }
    win.setSize(1500, 1000)
    await wait(() => evaluate(width => innerWidth === width, win.getContentBounds().width), '恢复宽窗')
    await verifySplit('拖动前')
    const drag = await evaluate(() => {
      const handle = document.querySelector('[aria-label=调整工作区宽度]').getBoundingClientRect(), panel = document.querySelector('[data-workspace]').getBoundingClientRect()
      return { from: { x: Math.round(handle.x + handle.width / 2), y: Math.round(handle.y + handle.height / 2) }, to: { x: Math.round(panel.right - 120), y: Math.round(handle.y + handle.height / 2) }, before: panel.width, requested: 120 }
    })
    measurements.drag = drag
    win.webContents.sendInputEvent({ type: 'mouseMove', ...drag.from })
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...drag.from })
    for (let step = 1; step <= 12; step++) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(drag.from.x + (drag.to.x - drag.from.x) * step / 12), y: drag.to.y })
      await new Promise(done => setTimeout(done, 12))
    }
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...drag.to })
    await wait(() => evaluate(() => document.querySelector('[data-workspace]').inert && getComputedStyle(document.querySelector('[data-workspace]')).visibility === 'hidden'), '真实拖动低于160px自动折叠')
    await click('[aria-label=展开标签页区]')
    await verifySplit('拖动折叠后重开')
    await click('[aria-label=调整工作区宽度]', 2)
    await wait(() => evaluate(() => Math.abs(document.querySelector('[data-workspace]').getBoundingClientRect().width - 480) < 1), '真实双击把手恢复480px默认宽度')
    await click('[aria-label=展开工作区]')
    await wait(() => evaluate(() => document.querySelector('[data-workspace]').dataset.workspaceMode === 'expanded'), '手动按钮才占满内容区')
    measurements.expanded = await geometry()
    require(Math.abs(measurements.expanded.workspace.width - measurements.expanded.frame.width) < 1, '占满宽度精确等于内容区', measurements.expanded)
    await snapshot('launcher-manual-expanded')
    await click('[aria-label=恢复并排]')
    await verifySplit('手动恢复并排')

    stage = '文件工作面'
    await click('[aria-label=打开文件导航]')
    await wait(() => evaluate(() => !!document.querySelector('[data-file-workspace]:not([hidden]) [data-file-navigator]')), '文件工作面与左侧导航已挂载')
    measurements.fileSearch = await evaluate(() => {
      const input = document.querySelector('[data-file-navigator] [aria-label=搜索项目文件]'), group = input.closest('[data-slot=input-group]'), icon = group?.querySelector('[data-slot=input-group-addon] svg')
      return { grouped: !!group, iconInside: !!icon && group.contains(icon), groupBorder: group ? parseFloat(getComputedStyle(group).borderTopWidth) : 0, inputBorder: parseFloat(getComputedStyle(input).borderTopWidth), inputSlot: input.dataset.slot }
    })
    require(measurements.fileSearch.grouped && measurements.fileSearch.iconInside && measurements.fileSearch.groupBorder > 0 && measurements.fileSearch.inputBorder === 0, '文件搜索复用shadcn InputGroup且只有外层一条边框', measurements.fileSearch)
    await click('[aria-label=打开文件]')
    await wait(() => evaluate(selector => !!document.querySelector(selector + ' [data-code-scroll]'), activePanel), '无项目先经原生文件选择打开notes.txt')
    await wait(() => evaluate(() => {
      const navigator = document.querySelector('[data-file-navigator]')
      return navigator.querySelectorAll('[role=treeitem]').length === 0 && navigator.querySelector('[aria-label=搜索项目文件]').disabled && navigator.textContent.includes('当前目录为空')
    }), '无项目打开本地文件仍保持空文件列表与禁用搜索')
    await snapshot('files-local-without-project')
    // 项目事实决定导航根；只替代系统选择器，创建与信任都经产品表单完成。
    await clickText('选择项目', 'button')
    await clickText('新建项目', '[data-slot=popover-content] button')
    await clickText('下一步', '[role=dialog] button')
    await type('[role=dialog] input[placeholder="项目名称"]', projectName)
    await clickText('添加文件夹', '[role=dialog] button')
    await clickText('创建项目', '[role=dialog] button')
    await clickText('信任文件夹', '[role=dialog] button')
    await wait(() => evaluate(projectName => document.querySelectorAll('[role=dialog]').length === 0 && document.querySelector('[data-file-navigator] [data-file-root-label]')?.textContent === projectName && !!document.querySelector('[role=treeitem][aria-label="readme.md"]'), projectName), '真实创建并绑定项目后树显示项目名与readme.md')
    const navigationIdentity = await evaluate(() => ({ id: document.querySelector('[role=tab][aria-selected=true]').id, count: document.querySelectorAll('[aria-label=工作区标签页] [role=tab]').length }))
    await click('[role=treeitem][aria-label="readme.md"]')
    await wait(() => evaluate(() => !!document.querySelector('[data-workspace-panel]:not([hidden]) [data-streamdown]') || document.querySelector('[aria-label=文件位置]').textContent.includes('readme.md')), '项目文件在当前标签导航')
    require(await evaluate(before => document.querySelector('[role=tab][aria-selected=true]').id === before.id && document.querySelectorAll('[aria-label=工作区标签页] [role=tab]').length === before.count, navigationIdentity), '从本地文件切到项目文件不新增或替换标签ID')
    await click('[role=treeitem][aria-label="notes.txt"]')
    await wait(() => evaluate(() => [...document.querySelectorAll('diffs-container')].some(node => node.shadowRoot?.textContent.includes('Native file picker fixture'))), '树内再次切换到文本文件实际绘制源码')
    require(await evaluate(before => document.querySelector('[role=tab][aria-selected=true]').id === before.id && document.querySelectorAll('[aria-label=工作区标签页] [role=tab]').length === before.count && !document.querySelector('[data-code-preview] button')?.textContent.includes('搜索'), navigationIdentity), '树内连续切换仍是当前标签且正文无常驻搜索按钮')
    await click('[role=treeitem][aria-label="readme.md"]')
    await key('Enter')
    await wait(() => evaluate(selector => document.querySelector(selector + ' [data-file-preview]')?.textContent.includes('文件布局验收'), activePanel), '文件树真实打开并渲染Markdown')
    await click('[aria-label=展开工作区]')
    await hint('[aria-label=收起文件树]', '收起文件树')
    measurements.files = await evaluate(() => {
      const workspace = document.querySelector('[data-file-workspace]:not([hidden])')
      const value = selector => { const rect = workspace.querySelector(selector).getBoundingClientRect(); return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height } }
      return { header: value('[data-file-toolbar]'), body: value('[data-file-workspace-body]'), sidebar: value('[data-file-workspace-sidebar]'), preview: value('[data-file-workspace-preview]'), toolbarCount: workspace.querySelectorAll('[data-file-toolbar]').length, breadcrumb: workspace.querySelector('[aria-label=文件位置]').textContent, previewHeaders: workspace.querySelectorAll('[data-file-preview] [data-file-toolbar]').length }
    })
    require(measurements.files.toolbarCount === 1 && measurements.files.previewHeaders === 0 && measurements.files.sidebar.right <= measurements.files.preview.x + 1 && measurements.files.body.y >= measurements.files.header.bottom - 1 && measurements.files.breadcrumb.includes('readme.md'), '文件单一工具行与面包屑，下方左树右正文', measurements.files)
    await snapshot('files-light-wide')
    const reader = await evaluate(selector => {
      const root = document.querySelector(selector + ' [data-file-preview]')
      const elements = [...root.querySelectorAll('*')].filter(element => element.getBoundingClientRect().height > 0 && element.scrollHeight > element.clientHeight + 200 && ['auto', 'scroll'].includes(getComputedStyle(element).overflowY))
      const element = elements[0]
      if (!element) throw new Error('文件预览没有实际滚动容器')
      window.__layoutReader = element
      window.__layoutWheelEvents = []
      window.__layoutScrollEnds = []
      element.addEventListener('wheel', event => {
        window.__layoutWheelEvents.push({ deltaY: event.deltaY, deltaMode: event.deltaMode, trusted: event.isTrusted, target: event.target.tagName, defaultPrevented: event.defaultPrevented, at: performance.now() })
      }, { passive: true })
      // 监听先于发送原生输入，避免滚轮动画结束很快时漏掉scrollend。
      element.addEventListener('scrollend', event => {
        window.__layoutScrollEnds.push({ scrollTop: element.scrollTop, trusted: event.isTrusted, at: performance.now() })
      }, { passive: true })
      const rect = element.getBoundingClientRect()
      const x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2), hit = document.elementFromPoint(x, y)
      if (!element.contains(hit)) throw new Error('滚轮目标被遮挡：' + hit?.outerHTML?.slice(0, 500))
      return { point: { x, y }, target: { tag: element.tagName, role: element.getAttribute('role'), className: element.className, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, hit: { tag: hit.tagName, text: hit.textContent.slice(0, 120) } } }
    }, activePanel)
    // Electron原生滚轮的正负方向与DOM WheelEvent相反；原生-640产生DOM+640并向下滚动。
    const wheelInput = { type: 'mouseWheel', ...reader.point, deltaY: -640, deltaX: 0, canScroll: true }
    measurements.fileScroll = { before: reader.target, input: wheelInput }
    win.show(); win.focus(); win.webContents.focus()
    win.webContents.sendInputEvent({ type: 'mouseMove', ...reader.point })
    win.webContents.sendInputEvent(wheelInput)
    try {
      await wait(() => evaluate(() => window.__layoutReader.scrollTop > 100), '真实滚轮滚动文件正文', 10000)
      await wait(() => evaluate(() => {
        const wheel = window.__layoutWheelEvents.at(-1)
        return wheel && window.__layoutScrollEnds.some(event => event.trusted && event.at >= wheel.at && event.scrollTop > 100)
      }), '原生滚轮平滑滚动实际发出scrollend', 10000)
      // 到达100px只说明动画开始；记录基准前还要确认滚动结束后的连续画帧稳定。
      measurements.fileScroll.stable = await evaluate(() => new Promise((done, reject) => {
        const element = window.__layoutReader, started = performance.now()
        let previous = element.scrollTop, stableFrames = 0, sampledFrames = 0
        const frame = () => {
          const current = element.scrollTop
          sampledFrames++
          stableFrames = Math.abs(current - previous) < 0.25 ? stableFrames + 1 : 0
          previous = current
          if (stableFrames >= 10) { done({ scrollTop: current, stableFrames, sampledFrames, elapsedMs: performance.now() - started }); return }
          if (performance.now() - started > 5000) { reject(new Error('scrollend后正文位置仍未稳定：' + JSON.stringify({ scrollTop: current, stableFrames, sampledFrames }))); return }
          requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
      }))
    } finally {
      measurements.fileScroll.after = await evaluate(() => ({ scrollTop: window.__layoutReader.scrollTop, scrollHeight: window.__layoutReader.scrollHeight, clientHeight: window.__layoutReader.clientHeight, connected: window.__layoutReader.isConnected, wheelEvents: window.__layoutWheelEvents, scrollEnds: window.__layoutScrollEnds, focused: document.hasFocus(), visibility: document.visibilityState }))
    }
    require(measurements.fileScroll.after.wheelEvents.some(event => event.trusted && event.deltaY > 0), '真实原生滚轮到达文件正文并产生向下DOM事件', measurements.fileScroll)
    const beforeToggle = await evaluate(() => ({ scrollTop: window.__layoutReader.scrollTop, tab: document.querySelector('[data-file-preview]:not([hidden])')?.dataset.fileTabId }))
    const acquireCount = requests.filter(item => item.method === 'fileViews.acquire').length
    await click('[aria-label=收起文件树]')
    await wait(() => evaluate(() => document.querySelector('[data-file-workspace-sidebar]').getBoundingClientRect().width === 0), '文件树折叠到零宽')
    require(await evaluate(() => window.__layoutReader.isConnected && window.__layoutReader.scrollTop > 100) && requests.filter(item => item.method === 'fileViews.acquire').length === acquireCount, '折叠文件树不重建正文或重新申请租约')
    await click('[aria-label=展开文件树]')
    const afterToggle = await evaluate(() => ({ connected: window.__layoutReader.isConnected, scrollTop: window.__layoutReader.scrollTop }))
    measurements.fileTreeToggle = { before: beforeToggle, after: afterToggle, acquireCountBefore: acquireCount, acquireCountAfter: requests.filter(item => item.method === 'fileViews.acquire').length }
    require(afterToggle.connected && Math.abs(afterToggle.scrollTop - beforeToggle.scrollTop) < 2, '展开文件树保留原正文节点和阅读位置', measurements.fileTreeToggle)
    require(nativePickers.some(item => item.title === '选择项目文件夹' && item.properties.includes('openDirectory')) && nativePickers.some(item => item.properties.includes('openFile')), '项目目录与独立文件分别经真实创建和授权入口选择', nativePickers)
    nativeTheme.themeSource = 'dark'
    await wait(() => evaluate(() => document.documentElement.classList.contains('dark')), '真实系统深色主题生效')
    await snapshot('files-dark-wide')
    nativeTheme.themeSource = 'light'
    await wait(() => evaluate(() => !document.documentElement.classList.contains('dark')), '真实系统浅色主题生效')
    await click('[aria-label=恢复并排]')

    stage = '真实PDF紧凑工具栏'
    // 要同时保留Markdown和PDF，须先显式新建文件标签；树内选择本身只导航当前页。
    await click('[aria-label=新建标签页]')
    await click('[aria-label=打开文件导航]')
    await click('[data-file-toolbar] [aria-label=打开文件]')
    const pdfToolbar = activePanel + ' [data-pdf-toolbar]'
    await wait(() => evaluate(selector => {
      const root = document.querySelector(selector + ' [data-pdf-viewport]')
      return root?.querySelector('canvas')?.width > 0 && root.querySelector('.react-pdf__Page__textContent')?.textContent.includes('Workspace PDF page 1')
    }, activePanel), '自有两页PDF实际Canvas与第一页文字层就绪')
    measurements.pdf = await evaluate(selector => {
      const outer = document.querySelector(selector), group = outer.querySelector('[role=group]'), controls = [...group.querySelectorAll('button,input')]
      const rect = element => { const value = element.getBoundingClientRect(); return { x: value.x, y: value.y, right: value.right, width: value.width, height: value.height, centerY: value.y + value.height / 2 } }
      return { toolbar: rect(outer), group: rect(group), controls: controls.map(element => ({ label: element.getAttribute('aria-label'), text: element.textContent, icon: !!element.querySelector('svg'), title: element.getAttribute('title'), ...rect(element) })), scrollWidth: outer.scrollWidth, clientWidth: outer.clientWidth, flexWrap: getComputedStyle(group).flexWrap, fitCanvasWidth: outer.parentElement.querySelector('canvas').getBoundingClientRect().width }
    }, pdfToolbar)
    require(measurements.pdf.flexWrap === 'nowrap' && measurements.pdf.controls.every(control => Math.abs(control.centerY - measurements.pdf.controls[0].centerY) < 1) && measurements.pdf.scrollWidth <= measurements.pdf.clientWidth + 1 && measurements.pdf.clientWidth <= 280, '约260px文件正文内PDF工具栏完整居中单行且无需横滚', measurements.pdf)
    require(measurements.pdf.controls.filter(control => ['上一页', '下一页', '缩小', '放大'].includes(control.label)).every(control => control.icon && control.title === null) && await evaluate(selector => document.querySelector(selector + ' [aria-label=适配]').textContent === '100%', pdfToolbar), 'PDF翻页缩放为图标，倍率默认显示适配基准100%', measurements.pdf)
    await hint(pdfToolbar + ' [aria-label=下一页]', '下一页')
    await snapshot('pdf-toolbar-light-260')
    await click(pdfToolbar + ' [aria-label=下一页]')
    await wait(() => evaluate(selector => document.querySelector(selector + ' [aria-label=PDF页码]')?.value === '2' && document.querySelector(selector + ' .react-pdf__Page__textContent')?.textContent.includes('Workspace PDF page 2'), activePanel), 'PDF图标下一页实际绘制第二页')
    await click(pdfToolbar + ' [aria-label=上一页]')
    await wait(() => evaluate(selector => document.querySelector(selector + ' [aria-label=PDF页码]')?.value === '1' && document.querySelector(selector + ' .react-pdf__Page__textContent')?.textContent.includes('Workspace PDF page 1'), activePanel), 'PDF图标上一页实际返回第一页')
    await type(pdfToolbar + ' [aria-label=PDF页码]', '2')
    await key('Enter')
    await wait(() => evaluate(selector => document.querySelector(selector + ' .react-pdf__Page__textContent')?.textContent.includes('Workspace PDF page 2'), activePanel), 'PDF短页码输入可直接跳至第二页')
    await click(pdfToolbar + ' [aria-label=放大]')
    await wait(() => evaluate(selector => document.querySelector(selector + ' [aria-label=适配]')?.textContent === '125%' && document.querySelector(selector + ' [data-pdf-viewport] canvas')?.getBoundingClientRect().width > 0, activePanel), 'PDF放大显示相对适配倍率125%')
    await click(pdfToolbar + ' [aria-label=适配]')
    await wait(() => evaluate(selector => document.querySelector(selector + ' [aria-label=适配]')?.textContent === '100%' && document.querySelector(selector + ' [aria-label=PDF页码]')?.value === '2' && document.querySelector(selector + ' .react-pdf__Page__textContent')?.textContent.includes('Workspace PDF page 2'), activePanel), '点击倍率恢复适配100%并保留第二页')
    await snapshot('pdf-page2-fit')

    stage = '浏览器工具栏与空白页'
    await click('[aria-label=新建标签页]')
    await click('[aria-label=打开内置浏览器]')
    const browserPane = activePanel + ' [data-browser-pane]', address = browserPane + ' [aria-label="网页地址或搜索"]'
    await wait(() => evaluate(selector => document.querySelector(selector)?.disabled === false, address), '真实guest握手完成启用地址栏')
    measurements.browser = await evaluate(selector => {
      const pane = document.querySelector(selector), body = pane.querySelector('[data-browser-body]').getBoundingClientRect(), toolbar = pane.querySelector('[data-browser-toolbar]').getBoundingClientRect(), empty = pane.querySelector('[data-browser-empty]'), children = [...empty.children].map(element => element.getBoundingClientRect()), field = pane.querySelector('[data-browser-address]').getBoundingClientRect(), nav = pane.querySelector('[data-browser-navigation]').getBoundingClientRect()
      return { body: { x: body.x, y: body.y, width: body.width, height: body.height }, toolbar: { y: toolbar.y, height: toolbar.height, bottom: toolbar.bottom }, address: { x: field.x, width: field.width }, navigation: { x: nav.x, right: nav.right }, emptyText: empty.textContent, groupCenterY: (children[0].top + children.at(-1).bottom) / 2, bodyCenterY: body.y + body.height / 2, groupCenterX: children[0].x + children[0].width / 2, bodyCenterX: body.x + body.width / 2 }
    }, browserPane)
    require(Math.abs(measurements.browser.groupCenterY - measurements.browser.bodyCenterY) < 2 && Math.abs(measurements.browser.groupCenterX - measurements.browser.bodyCenterX) < 2 && measurements.browser.emptyText.includes('粘贴或输入 URL 以打开网页。') && measurements.browser.address.x >= measurements.browser.navigation.right && measurements.browser.toolbar.bottom <= measurements.browser.body.y + 1, '浏览器地址工具行与居中图标空态', measurements.browser)
    await snapshot('browser-empty-light')
    nativeTheme.themeSource = 'dark'
    await wait(() => evaluate(() => document.documentElement.classList.contains('dark')), '浏览器空态深色主题生效')
    await snapshot('browser-empty-dark')
    nativeTheme.themeSource = 'light'
    await wait(() => evaluate(() => !document.documentElement.classList.contains('dark')), '浏览器恢复浅色')
    await hint(browserPane + ' [aria-label=浏览器菜单]', '浏览器菜单')
    await click(browserPane + ' [aria-label=浏览器菜单]')
    await wait(() => evaluate(() => document.querySelector('[data-browser-menu]')?.getBoundingClientRect().width > 0), '浏览器更多菜单实际打开')
    await snapshot('browser-menu-light')
    measurements.browserMenu = await evaluate(() => {
      const menu = document.querySelector('[data-browser-menu]'), rect = menu.getBoundingClientRect(), items = [...menu.querySelectorAll('[role=menuitem]')]
      const controls = [...menu.querySelectorAll('[aria-label=网页缩放] button')].map(button => {
        const value = button.getBoundingClientRect(), x = Math.round(value.x + value.width / 2), y = Math.round(value.y + value.height / 2), hit = document.elementFromPoint(x, y)
        return { label: button.getAttribute('aria-label'), x: value.x, y: value.y, right: value.right, bottom: value.bottom, width: value.width, height: value.height, hit: hit === button || button.contains(hit) }
      })
      return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height, viewport: { width: innerWidth, height: innerHeight }, expectedWidth: parseFloat(getComputedStyle(document.documentElement).fontSize) * 16, items: items.map(item => ({ text: item.textContent, whiteSpace: getComputedStyle(item).whiteSpace })), controls }
    })
    require(measurements.browserMenu.x >= 0 && measurements.browserMenu.y >= 0 && measurements.browserMenu.right <= measurements.browserMenu.viewport.width && measurements.browserMenu.bottom <= measurements.browserMenu.viewport.height && Math.abs(measurements.browserMenu.width - measurements.browserMenu.expectedWidth) < 1, '浏览器更多菜单统一w-64且完整位于视口内', measurements.browserMenu)
    require(measurements.browserMenu.items.every(item => item.whiteSpace === 'nowrap') && measurements.browserMenu.controls.length === 3 && measurements.browserMenu.controls.every(control => control.hit && control.x >= measurements.browserMenu.x && control.right <= measurements.browserMenu.right && control.y >= measurements.browserMenu.y && control.bottom <= measurements.browserMenu.bottom), '浏览器菜单文字不换行且缩放三钮完整可命中', measurements.browserMenu)
    for (const action of [{ label: '放大网页', text: '110%' }, { label: '恢复网页缩放', text: '100%' }, { label: '缩小网页', text: '90%' }, { label: '恢复网页缩放', text: '100%' }]) {
      if (!await evaluate(() => !!document.querySelector('[data-browser-menu]'))) await click(browserPane + ' [aria-label=浏览器菜单]')
      await click('[data-browser-menu] [aria-label=' + JSON.stringify(action.label) + ']')
      await wait(() => evaluate(text => document.querySelector('[data-browser-menu] [aria-label=恢复网页缩放]')?.textContent === text, action.text), '浏览器菜单真实点击 ' + action.label + ' 到 ' + action.text)
    }
    await key('Escape')
    await wait(() => evaluate(() => !document.querySelector('[data-browser-menu]')), '浏览器更多菜单正常退场')
    await type(address, config.fixture + '/form')
    await key('Enter')
    let guest
    await wait(async () => {
      guest = webContents.getAllWebContents().find(item => item.getType() === 'webview' && !item.isDestroyed() && item.getURL() === config.fixture + '/form')
      return guest && await guest.executeJavaScript('!!document.querySelector("#form")')
    }, '真实地址输入导航本地HTTP夹具')
    const browserId = await evaluate(selector => document.querySelector(selector).dataset.browserPane, browserPane)
    const guestId = guest.id
    await guest.executeJavaScript('document.querySelector("#form").focus()')
    guest.focus(); await guest.insertText('keep-layout-form')
    await guest.executeJavaScript('window.scrollTo(0,360)')
    const browserBefore = await guest.executeJavaScript('({value:document.querySelector("#form").value,scrollY,inputs:window.inputEvents})')
    require(browserBefore.value === 'keep-layout-form' && browserBefore.inputs > 0 && browserBefore.scrollY === 360, '原生guest表单输入和滚动已建立', browserBefore)
    await snapshot('browser-loaded-light')
    win.setSize(760, 1000)
    await verifyAutomaticCollapse('浏览器已输入表单后缩窗')
    require(!guest.isDestroyed() && await guest.executeJavaScript('document.querySelector("#form").value') === browserBefore.value, '自动隐藏工作区保留原guest与表单')
    await snapshot('browser-auto-hidden-760')
    win.setSize(1500, 1000)
    await verifySplit('浏览器自动隐藏后放宽恢复')
    require(await evaluate(selector => document.querySelector(selector + ' webview').getWebContentsId(), browserPane) === guestId && await guest.executeJavaScript('document.querySelector("#form").value') === browserBefore.value, '放宽恢复原浏览器开态且guest与表单不变')
    await snapshot('browser-auto-restored-wide')

    stage = '标签列表搜索/激活/关闭与保活'
    await click('[aria-label=标签页列表]')
    await type(popover + ' [aria-label=搜索标签页]', 'readme')
    await wait(() => evaluate(selector => document.querySelectorAll(selector + ' [data-slot=item]').length === 1, popover), 'shadcn列表搜索仅显示匹配文件')
    await snapshot('tabs-popover-search')
    await clickText('readme.md', popover + ' button')
    await wait(() => evaluate(selector => document.querySelector(selector + ' [data-file-preview]')?.textContent.includes('文件布局验收'), activePanel), '列表激活匹配的文件标签')
    require(await evaluate(() => window.__layoutReader.isConnected && window.__layoutReader.scrollTop > 100), '列表切换仍保留文件阅读节点和位置')
    await click('[aria-label=新建标签页]')
    await click('[aria-label=标签页列表]')
    await type(popover + ' [aria-label=搜索标签页]', '新标签页')
    await click(popover + ' [aria-label="在列表中关闭 新标签页"]')
    await wait(() => evaluate(selector => document.querySelectorAll(selector + ' [data-slot=item]').length === 0, popover), '列表关闭匹配标签且保留搜索条件')
    await key('Escape')
    await click('[role=tab][id=' + JSON.stringify('workspace-tab-' + browserId) + ']')
    const liveGuest = await evaluate(selector => document.querySelector(selector + ' webview').getWebContentsId(), browserPane)
    const browserAfter = await guest.executeJavaScript('({value:document.querySelector("#form").value,scrollY})')
    measurements.browserKeepAlive = { guestIdBefore: guestId, guestIdAfter: liveGuest, before: browserBefore, after: browserAfter }
    require(liveGuest === guestId && browserAfter.value === browserBefore.value && browserAfter.scrollY === browserBefore.scrollY, '跨文件/启动页/列表切换保留同一guest与表单滚动', measurements.browserKeepAlive)
    await click('[aria-label=收起工作区]')
    await click('[aria-label=展开标签页区]')
    require(await evaluate(selector => document.querySelector(selector + ' webview').getWebContentsId(), browserPane) === guestId && await guest.executeJavaScript('document.querySelector("#form").value') === browserBefore.value, '整体折叠重开保留同一网页')
    const sessionsAfter = await evaluate(() => window.cogent.engineRequest('session.list', {}))
    require(sessionsAfter.length === sessionsBefore.length, '文件与浏览器独立操作不暗建聊天')
    await click('[aria-label=标签页列表]')
    await clickText('关闭全部标签页', popover + ' button')
    await wait(() => evaluate(() => document.querySelectorAll('[data-workspace-panel]').length === 0), '真实关闭全部移除文件与网页面板')
    await wait(() => Promise.resolve(fileLeases.size === 0 && browserLeases.size === 0 && webContents.getAllWebContents().every(item => item.getType() !== 'webview')), '文件租约/浏览器租约/guest全部归零')

    stage = '全部关闭后的文件导航复开'
    const pickerCountBeforeReopen = nativePickers.length
    await click('[aria-label=展开标签页区]')
    await click('[aria-label=打开文件导航]')
    await wait(() => evaluate(() => !!document.querySelector('[data-file-workspace]:not([hidden]) [role=treeitem][aria-label="readme.md"]')), '复开文件导航恢复绑定项目与文件树')
    require(nativePickers.length === pickerCountBeforeReopen, '复开绑定项目不重新弹出选择器')
    await type('[data-file-workspace]:not([hidden]) [aria-label=搜索项目文件]', 'readme.md')
    await wait(() => evaluate(() => [...document.querySelectorAll('[data-file-workspace]:not([hidden]) [aria-label=文件搜索结果] button')].some(element => element.textContent.includes('readme.md'))), '复开的导航owner能够真实搜索项目文件')
    await click('[data-file-workspace]:not([hidden]) [aria-label=文件搜索结果] button')
    await wait(() => evaluate(selector => document.querySelector(selector + ' [data-file-preview]')?.textContent.includes('文件布局验收'), activePanel), '复开后搜索结果仍能获得新文件租约并渲染')
    measurements.reopenedFile = await evaluate(() => ({ breadcrumb: document.querySelector('[data-file-workspace]:not([hidden]) [aria-label=文件位置]').textContent, toolbarCount: document.querySelector('[data-file-workspace]:not([hidden])').querySelectorAll('[data-file-toolbar]').length }))
    require(measurements.reopenedFile.breadcrumb.includes(projectName) && measurements.reopenedFile.breadcrumb.includes('readme.md') && measurements.reopenedFile.toolbarCount === 1, '复开文件面包屑仍显示项目名和文件名', measurements.reopenedFile)
    await snapshot('files-reopened-after-close-all')
    await click('[aria-label=标签页列表]')
    await clickText('关闭全部标签页', popover + ' button')
    await wait(() => evaluate(() => document.querySelectorAll('[data-workspace-panel]').length === 0), '复开回归完成后再次关闭全部面板')
    await wait(() => Promise.resolve(fileLeases.size === 0 && browserLeases.size === 0 && webContents.getAllWebContents().every(item => item.getType() !== 'webview')), '复开后的文件租约与guest最终归零')
    require(errors.length === 0, 'renderer无控制台错误', errors)
    passed = true
  } catch (error) {
    failure = { error: String(error), stack: error.stack, failedStage: stage }
    if (win && !win.isDestroyed()) {
      await snapshot('failure').catch(() => {})
      failure.dom = await evaluate(() => ({ url: location.href, text: document.body.innerText.slice(-12000), focus: document.activeElement?.outerHTML?.slice(0,1500) })).catch(() => null)
    }
  } finally { await finish() }
}

const requests = []
const fixture = createServer((request, response) => {
  requests.push(request.url)
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end('<!doctype html><title>Layout browser fixture</title><style>body{font:18px sans-serif;margin:24px;background:#f1f5f9}main{height:3200px}</style><main><h1>Layout browser fixture</h1><input id="form" oninput="window.inputEvents++"><p>Form and scroll survive layout changes.</p></main><script>window.inputEvents=0</script>')
})
let child, timeout, interrupted = false
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const stop = () => { interrupted = true; if (child && child.exitCode === null) child.kill() }
process.once('SIGINT', stop); process.once('SIGTERM', stop)
try {
  await new Promise(done => fixture.listen(0, '127.0.0.1', done))
  const config = { profile: join(temporary, 'profile'), workspace, evidence, fixture: 'http://127.0.0.1:' + fixture.address().port, main: pathToFileURL(resolve('out/main/index.js')).href }
  const driverPath = join(temporary, 'driver.mjs'), resultPath = join(evidence, 'result.json'), pidsPath = join(evidence, 'owned-pids.json')
  writeFileSync(driverPath, '(' + driver.toString() + ')(' + JSON.stringify(config) + ');')
  for (const path of [resultPath, pidsPath]) rmSync(path, { force: true })
  const env = { ...process.env, COGENT_HOME: home, HOME: home, USERPROFILE: home, NODE_ENV: 'production' }
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  let timedOut = false
  child = spawn(electron, [driverPath], { cwd: repository, env, stdio: 'inherit', windowsHide: true })
  timeout = setTimeout(() => { timedOut = true; child.kill() }, 240000)
  const exitCode = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done) })
  clearTimeout(timeout)
  const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : { passed: false, error: 'Electron未写入验收结果' }
  const ownedPids = [...new Set([child.pid, ...(existsSync(pidsPath) ? JSON.parse(readFileSync(pidsPath, 'utf8')) : [])])].filter(Boolean)
  const deadline = Date.now() + 5000
  while (ownedPids.some(alive) && Date.now() < deadline) await new Promise(done => setTimeout(done, 100))
  const forcedPids = ownedPids.filter(alive)
  for (const pid of forcedPids) { try { process.kill(pid) } catch {} }
  const forceDeadline = Date.now() + 5000
  while (ownedPids.some(alive) && Date.now() < forceDeadline) await new Promise(done => setTimeout(done, 100))
  result.cleanup = { exitCode, timedOut, interrupted, ownedPids, forcedPids, remainingPids: ownedPids.filter(alive) }
  result.fixtureRequests = requests
  if (exitCode !== 0 || timedOut || interrupted || forcedPids.length > 0 || result.cleanup.remainingPids.length > 0) result.passed = false
  writeFileSync(resultPath, JSON.stringify(result, null, 2))
  if (!result.passed) process.exitCode = 1
} finally {
  clearTimeout(timeout)
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop)
  if (child && child.exitCode === null) child.kill()
  fixture.closeAllConnections()
  await new Promise(done => fixture.close(done))
  const path = relative(resolve(tmpdir()), resolve(temporary))
  assert.ok(!isAbsolute(path) && !path.startsWith('..') && path.startsWith('cogent-workspace-layout-'), '只清理本次系统临时根内的隔离目录')
  const resultPath = join(evidence, 'result.json')
  const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : { passed: false }
  const remainingPids = result.cleanup?.remainingPids ?? (child?.pid && alive(child.pid) ? [child.pid] : [])
  if (remainingPids.length === 0) rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  const summary = { passed: result.passed === true && remainingPids.length === 0, checks: result.checks?.length ?? 0, fixtureServerClosed: !fixture.listening, temporaryProfileRemoved: remainingPids.length === 0, remainingPids, result: resultPath }
  writeFileSync(join(evidence, 'summary.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
  if (!summary.passed) process.exitCode = 1
}
