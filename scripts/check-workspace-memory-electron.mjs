/** 工作区不跨进程保留的真产品验收；两次正常启动共用隔离资料，旧数据库只作为迁移夹具。 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import electron from 'electron'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(repository)
for (const entry of ['out/main/index.js', 'out/main/host.js', 'out/preload/index.cjs', 'out/renderer/index.html']) {
  assert.ok(existsSync(resolve(entry)), '缺少产品构建：' + entry + '；本脚本不自动build')
}
const temporary = mkdtempSync(join(tmpdir(), 'cogent-workspace-memory-'))
const home = join(temporary, 'home'), profile = join(temporary, 'profile'), fixtureDirectory = join(temporary, 'outside-workspace')
const evidence = resolve(process.env.WORKSPACE_MEMORY_EVIDENCE ?? 'tmp/workspace-memory-electron')
for (const path of [home, fixtureDirectory, evidence]) mkdirSync(path, { recursive: true })
writeFileSync(join(home, 'settings.json'), JSON.stringify({ version: 1, closeBehavior: 'quit', soundEnabled: false, toastEnabled: false }))
const sentinel = 'workspace-memory-' + randomUUID(), textPath = join(fixtureDirectory, 'memory-only-reading.txt')
writeFileSync(textPath, Array.from({ length: 600 }, (_, index) => 'Memory-only reading fixture line ' + String(index + 1).padStart(4, '0') + ' — ' + sentinel).join('\n'))
const httpRequests = []
const server = createServer((request, response) => {
  httpRequests.push({ url: request.url, at: Date.now() })
  if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  response.end('<!doctype html><meta charset="utf-8"><title>Memory-only browser fixture</title><h1>Memory-only browser fixture</h1><p>' + sentinel + '</p><p>' + request.url + '</p>')
})
await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
const url = 'http://127.0.0.1:' + server.address().port + '/memory/' + sentinel

async function driver(config) {
  const { app, dialog, ipcMain, nativeTheme, webContents } = await import('electron')
  const { writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const childProcess = (await import('node:child_process')).default
  const ownedPids = new Set([process.pid]), checks = [], errors = [], ipc = [], dialogs = [], pickerCalls = []
  const measurements = {}, started = Date.now()
  let win, stage = '真实产品启动', failure, readyToClose = false, closed = false, closeStarted, closingTimer, finished = false
  const phaseName = 'phase-' + config.phase, resultPath = join(config.evidence, phaseName + '.json'), pidsPath = join(config.evidence, phaseName + '-pids.json')
  const savePids = () => writeFileSync(pidsPath, JSON.stringify([...ownedPids]))
  const originalSpawn = childProcess.spawn
  childProcess.spawn = (...args) => { const child = originalSpawn(...args); if (child.pid) { ownedPids.add(child.pid); savePids() } return child }
  ;(await import('node:module')).syncBuiltinESMExports()
  savePids()
  app.setPath('userData', config.profile)
  app.commandLine.appendSwitch('force-device-scale-factor', '1')
  nativeTheme.themeSource = 'light'
  // 只替换系统选择器的用户裁决；文件授权、Host读取、标签建立仍经过产品原链路。
  dialog.showOpenDialog = async (_window, options) => {
    pickerCalls.push({ stage, options })
    if (!options.properties.includes('openFile')) throw new Error('本验收只选择本地文本文件')
    return { canceled: false, filePaths: [config.textPath] }
  }
  dialog.showMessageBox = async (...args) => { dialogs.push({ stage, options: args.at(-1) }); return { response: 0, checkboxChecked: false } }
  dialog.showMessageBoxSync = (...args) => { dialogs.push({ stage, options: args.at(-1), sync: true }); return 0 }
  const removedWorkspaceChannel = channel => channel === 'workspace:flush' || channel === 'workspace:flushed'
  const observeIpc = (direction, channel) => {
    if (removedWorkspaceChannel(channel) || channel === 'window:ask-close') ipc.push({ direction, channel, stage, at: Date.now() - started })
  }
  const originalHandle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, listener) => {
    if (removedWorkspaceChannel(channel)) ipc.push({ direction: 'registered', channel })
    return originalHandle(channel, (event, ...args) => { observeIpc('renderer-to-main', channel); return listener(event, ...args) })
  }
  const created = new Promise(done => app.once('browser-window-created', (_event, value) => {
    const originalSend = value.webContents.send.bind(value.webContents)
    value.webContents.send = (channel, ...args) => { observeIpc('main-to-renderer', channel); return originalSend(channel, ...args) }
    value.webContents.on('ipc-message', (_event, channel) => observeIpc('renderer-to-main', channel))
    value.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push({ stage, message }) })
    done(value)
  }))
  const pidTimer = setInterval(() => { if (app.isReady()) for (const item of app.getAppMetrics()) ownedPids.add(item.pid); savePids() }, 250)
  pidTimer.unref()
  const record = label => { checks.push(label); console.log('[工作区纯内存 phase ' + config.phase + '] ' + label) }
  const require = (condition, label, value) => { if (!condition) throw new Error(label + '：' + JSON.stringify(value)); record(label) }
  const evaluate = (fn, ...args) => win.webContents.executeJavaScript('(' + fn.toString() + ')(' + args.map(value => JSON.stringify(value)).join(',') + ')', true)
  const wait = async (condition, label, milliseconds = 20000) => {
    const deadline = Date.now() + milliseconds
    while (Date.now() < deadline) { if (await condition()) { record(label); return } await new Promise(done => setTimeout(done, 40)) }
    throw new Error('超时：' + label)
  }
  const settle = () => evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  const key = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await settle()
  }
  const click = async (selector, settleAfter = true) => {
    let point
    await wait(async () => {
      point = await evaluate(selector => {
        const element = document.querySelector(selector)
        if (!element || element.disabled || element.closest('[inert]')) return null
        element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
        const rect = element.getBoundingClientRect(), list = element.closest('[role=tablist]')?.getBoundingClientRect()
        const left = Math.max(rect.left, list?.left ?? 0), right = Math.min(rect.right, list?.right ?? innerWidth)
        const x = Math.round((left + right) / 2), y = Math.round(rect.y + rect.height / 2), hit = document.elementFromPoint(x, y)
        return right > left && rect.height > 0 && (hit === element || element.contains(hit)) ? { x, y } : null
      }, selector)
      return point !== null
    }, '原生指针可命中 ' + selector)
    win.show(); win.focus(); win.webContents.focus()
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
    if (settleAfter) await settle()
  }
  const type = async (selector, value) => {
    await click(selector)
    await key('A', ['control'])
    await win.webContents.insertText(value)
    await settle()
  }
  const snapshot = async name => writeFileSync(join(config.evidence, phaseName + '-' + name + '.png'), (await win.webContents.capturePage()).toPNG())
  const current = () => evaluate(() => {
    const workspace = document.querySelector('[data-workspace]'), focused = document.activeElement
    const visibleTooltips = [...document.querySelectorAll('[data-slot=tooltip-content]')].filter(node => node.getBoundingClientRect().width > 0 && getComputedStyle(node).visibility !== 'hidden').map(node => node.textContent)
    return { collapsed: getComputedStyle(workspace).visibility === 'hidden' && workspace.inert, tabCount: document.querySelectorAll('[aria-label=工作区标签页] [role=tab]').length, panelCount: document.querySelectorAll('[data-workspace-panel]').length, webviews: document.querySelectorAll('webview').length, visibleTooltips, workspaceFocused: workspace.contains(focused), focusedTooltipTrigger: focused.hasAttribute('data-base-ui-tooltip-trigger'), focus: focused.outerHTML.slice(0, 600), oldFlushApi: typeof window.cogent.onWorkspaceFlush, oldAckApi: typeof window.cogent.workspaceFlushed }
  })
  const databaseNames = () => evaluate(async () => (await indexedDB.databases()).map(database => database.name))
  const tabCount = () => evaluate(() => document.querySelectorAll('[aria-label=工作区标签页] [role=tab]').length)
  const reopenShortcut = async () => {
    await evaluate(() => { window.__workspaceMemoryKeys = [] })
    await key('T', ['control', 'shift'])
    const events = await evaluate(() => window.__workspaceMemoryKeys)
    ;(measurements.shortcuts ??= []).push(events)
    require(events.some(event => event.trusted && event.control && event.shift && event.key.toLowerCase() === 't' && event.workspace), '原生CtrlShiftT受信任按键确实到达工作区', events)
  }
  const save = () => {
    if (app.isReady()) for (const item of app.getAppMetrics()) ownedPids.add(item.pid)
    savePids()
    writeFileSync(resultPath, JSON.stringify({ passed: readyToClose && closed && !failure && dialogs.length === 0 && ipc.length === 0 && errors.length === 0, runId: config.sentinel, phase: config.phase, stage, checks, measurements, errors, ipc, dialogs, pickerCalls, closed, elapsedMs: Date.now() - started, ownedPids: [...ownedPids], electron: process.versions.electron, chromium: process.versions.chrome, ...failure }, null, 2))
  }
  const fail = async error => {
    if (finished) return
    finished = true
    failure = { error: String(error), stack: error.stack, failedStage: stage }
    if (win && !win.isDestroyed()) {
      await snapshot('failure').catch(() => {})
      failure.dom = await evaluate(() => ({ text: document.body.innerText.slice(-10000), focus: document.activeElement.outerHTML.slice(0, 800) })).catch(() => null)
    }
    save(); app.quit(); setTimeout(() => app.exit(2), 5000).unref()
  }
  const watchdog = setTimeout(() => { void fail(new Error('工作区纯内存115秒watchdog')) }, 115000)
  app.once('will-quit', () => {
    clearInterval(pidTimer); clearTimeout(watchdog); clearTimeout(closingTimer)
    if (!closed && !failure) failure = { error: '正常关窗前提前退出', failedStage: stage }
    save()
  })
  process.on('uncaughtException', error => { void fail(error) })
  process.on('unhandledRejection', error => { void fail(error) })
  try {
    await import(config.main)
    win = await created
    win.setSize(1500, 850); win.show(); win.focus()
    await wait(() => evaluate(() => !!document.querySelector('[data-chat-header]') && !!document.querySelector('[data-workspace]') && typeof window.cogent.fileViewsRequest === 'function'), '真实main/preload/renderer首页就绪')
    await evaluate(() => {
      window.__workspaceMemoryKeys = []
      window.addEventListener('keydown', event => window.__workspaceMemoryKeys.push({ key: event.key, trusted: event.isTrusted, control: event.ctrlKey, shift: event.shiftKey, workspace: !!event.target.closest('[data-workspace]') }), true)
    })
    await settle()
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 4, y: 4 })
    // 留出完整Tooltip延时，同时让挂载effect完成初次删除；此后再种迁移夹具，不能覆盖启动清理。
    await new Promise(done => setTimeout(done, 650))
    measurements.startup = await current()
    const startup = measurements.startup
    require(startup.collapsed && startup.tabCount === 0 && startup.panelCount === 0 && startup.webviews === 0, '默认收起、零标签、零文件面板、零webview', startup)
    require(startup.visibleTooltips.length === 0 && !startup.workspaceFocused && !startup.focusedTooltipTrigger, '启动无Tooltip且焦点未落入工作区或Tooltip触发器', startup)
    require(startup.oldFlushApi === 'undefined' && startup.oldAckApi === 'undefined', 'preload不再提供工作区保存请求或ACK接口', startup)
    await wait(async () => !(await databaseNames()).includes('cogent-workspace'), config.phase === 1 ? '初始工作区旧数据库清理已完成' : '重启已删除首启遗留的工作区旧数据库')
    measurements.startup.guestCount = webContents.getAllWebContents().filter(contents => contents.getType() === 'webview').length
    require(measurements.startup.guestCount === 0, '原生WebContents中没有后台网页实例', measurements.startup)
    measurements.gpu = app.getGPUFeatureStatus()
    require(!app.commandLine.hasSwitch('disable-gpu') && !app.commandLine.hasSwitch('disable-software-rasterizer'), '使用正常GPU启动参数', measurements.gpu)
    await snapshot('collapsed-startup')

    if (config.phase === 1) {
      stage = '种旧数据库迁移夹具'
      const scopeId = 'draft:default', fileId = 'legacy-file', browserId = 'legacy-browser'
      const file = { id: fileId, scopeId, kind: 'file', title: 'Legacy file', createdAt: 1, source: { scope: { contextId: 'restore', refs: [], workspaceScopeId: scopeId }, target: config.textPath }, resourceKey: 'legacy-file-key', navigation: 1 }
      const browser = { id: browserId, scopeId, kind: 'browser', title: 'Legacy browser', createdAt: 2, url: config.url + '?legacy=1', history: { entries: [{ url: config.url + '?legacy=1', title: 'Legacy browser' }], index: 0 } }
      const fixture = { version: 1, sentinel: config.sentinel, scopes: { [scopeId]: { tabs: [file, browser], activeId: browserId, collapsed: false, expanded: true, width: 680, grantIds: [] } }, recent: [{ ...file, id: 'legacy-closed-file' }], views: { [fileId]: { scrollTop: 1440, scrollLeft: 0, selection: { anchor: 10, head: 20 } } } }
      await evaluate(fixture => new Promise((done, reject) => {
        const request = indexedDB.open('cogent-workspace', 1)
        request.onupgradeneeded = () => request.result.createObjectStore('state')
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const database = request.result, transaction = database.transaction('state', 'readwrite')
          transaction.objectStore('state').put(fixture, 'workspace')
          transaction.oncomplete = () => { database.close(); done() }
          transaction.onerror = () => { database.close(); reject(transaction.error) }
        }
      }), fixture)
      measurements.legacyFixture = fixture
      record('仅在IndexedDB种旧快照，未注入业务store')
      const unchangedLegacy = async label => {
        const value = await evaluate(() => new Promise((done, reject) => {
          const request = indexedDB.open('cogent-workspace', 1)
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const database = request.result, transaction = database.transaction('state', 'readonly'), read = transaction.objectStore('state').get('workspace')
            read.onsuccess = () => done(read.result)
            read.onerror = () => reject(read.error)
            transaction.oncomplete = () => database.close()
          }
        }))
        require(JSON.stringify(value) === JSON.stringify(fixture), label, value)
      }
      await click('[aria-label=展开标签页区]')
      await click('[aria-label=打开文件导航]')
      await click('[aria-label=打开文件]')
      const code = '[data-workspace-panel]:not([hidden]) [data-code-scroll]'
      await wait(() => evaluate(selector => !!document.querySelector(selector) && document.querySelector(selector).scrollHeight > 1000, code), '真实选择本地文本后Host读取并渲染源码')
      require(pickerCalls.length === 1, '只调用一次真实文件选择入口', pickerCalls)
      const fileTab = await evaluate(() => document.querySelector('[data-workspace-panel]:not([hidden])').dataset.workspacePanel)
      const point = await evaluate(selector => { const rect = document.querySelector(selector).getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) } }, code)
      win.webContents.sendInputEvent({ type: 'mouseMove', ...point })
      win.webContents.sendInputEvent({ type: 'mouseWheel', ...point, deltaY: -700, deltaX: 0, canScroll: true })
      let lastScroll = -1, lastScrollChange = Date.now()
      await wait(async () => {
        const value = await evaluate(selector => document.querySelector(selector).scrollTop, code)
        if (value !== lastScroll) { lastScroll = value; lastScrollChange = Date.now() }
        return value > 100 && Date.now() - lastScrollChange >= 250
      }, '原生滚轮改变文本阅读位置并停止滚动')
      measurements.readingBefore = await evaluate(selector => ({ scrollTop: document.querySelector(selector).scrollTop, tabId: document.querySelector(selector).closest('[data-workspace-panel]').dataset.workspacePanel }), code)
      await snapshot('local-text-reading')
      stage = '真实网页导航与进程内记忆'
      await click('[aria-label=新建标签页]')
      await click('[aria-label=打开内置浏览器]')
      const address = '[data-workspace-panel]:not([hidden]) [aria-label=网页地址或搜索]'
      await type(address, config.url)
      await key('Enter')
      await wait(() => Promise.resolve(webContents.getAllWebContents().some(contents => contents.getType() === 'webview' && contents.getURL() === config.url)), '真实webview打开随机本地HTTP网页')
      await wait(() => evaluate((selector, url) => document.querySelector(selector).value === url && document.querySelector('[aria-label=工作区标签页] [role=tab][aria-selected=true]').textContent.includes('Memory-only browser fixture'), address, config.url), '网页标题与真实地址回显')
      const browserTab = await evaluate(() => document.querySelector('[data-workspace-panel]:not([hidden])').dataset.workspacePanel)
      measurements.browser = { tabId: browserTab, url: config.url, guestId: webContents.getAllWebContents().find(contents => contents.getType() === 'webview' && contents.getURL() === config.url).id }
      await click('[aria-controls="workspace-panel-' + fileTab + '"]')
      await wait(() => evaluate((selector, expected) => Math.abs(document.querySelector(selector).scrollTop - expected) <= 2, code, measurements.readingBefore.scrollTop), '切回文件保留本进程阅读位置')
      measurements.readingAfter = await evaluate(selector => ({ scrollTop: document.querySelector(selector).scrollTop }), code)
      await click('[aria-controls="workspace-panel-' + browserTab + '"]')
      require(await evaluate((selector, url) => document.querySelector(selector).value === url, address, config.url), '切回网页保留本进程真实地址')
      require(webContents.getAllWebContents().some(contents => contents.id === measurements.browser.guestId && contents.getURL() === config.url), '标签切换保留同一个原生网页实例')
      await snapshot('live-file-and-browser')
      await click('[aria-label=新建标签页]')
      await click('[aria-label=打开内置浏览器]')
      await click('[aria-label="关闭 浏览器"]')
      await click('[aria-controls="workspace-panel-' + browserTab + '"]')
      await reopenShortcut()
      await wait(async () => await tabCount() === 3, '本进程CtrlShiftT仍能恢复刚关闭的标签')
      await click('[aria-label="关闭 浏览器"]')
      await wait(async () => await tabCount() === 2, '保留文件网页与本进程recent记录后正常关窗')
      await unchangedLegacy('文件打开、阅读、网页导航、关闭重开均未覆写旧数据库sentinel')
      measurements.beforeClose = await current()
    } else {
      stage = '重启只允许显式展开全新启动页'
      await click('[aria-label=展开标签页区]')
      await wait(() => evaluate(() => document.querySelectorAll('[aria-label=工作区标签页] [role=tab]').length === 1 && document.querySelectorAll('[data-workspace-panel]').length === 1 && !!document.querySelector('[data-workspace-launcher]')), '显式展开只创建一个全新启动页')
      const newTabId = await evaluate(() => document.querySelector('[data-workspace-panel]').dataset.workspacePanel)
      await click('[aria-controls="workspace-panel-' + newTabId + '"]')
      await reopenShortcut()
      await settle()
      measurements.afterReopen = await current()
      require(measurements.afterReopen.tabCount === 1 && measurements.afterReopen.panelCount === 1 && measurements.afterReopen.webviews === 0, '重启CtrlShiftT无法恢复上次文件、网页或recent标签', measurements.afterReopen)
      require(await evaluate(() => !document.querySelector('[data-code-preview]') && !document.querySelector('[data-file-preview]') && !document.querySelector('[data-browser-pane]') && document.querySelector('[data-workspace-panel]').dataset.tabKind === 'start'), '重启未恢复阅读视图和网页地址')
      require(!(await databaseNames()).includes('cogent-workspace'), '展开与快捷键操作不重建工作区旧数据库')
      require(pickerCalls.length === 0, '重启没有触发文件重授权或选择器', pickerCalls)
      await snapshot('fresh-launcher-after-restart')
    }
    require(errors.length === 0, 'renderer没有控制台错误', errors)
    require(dialogs.length === 0 && ipc.length === 0, '整个运行没有workspace保存握手或未保存询问', { dialogs, ipc })
    stage = '原生关闭产品窗口'
    readyToClose = true
    closeStarted = Date.now()
    win.once('closed', () => {
      closed = true
      measurements.closeMs = Date.now() - closeStarted
      if (dialogs.length > 0 || ipc.length > 0) failure = { error: '正常关窗触发了旧保存握手或询问', failedStage: stage }
      record('正常窗口关闭完成，无workspace:flush ACK或未保存提示')
      save()
    })
    closingTimer = setTimeout(() => { void fail(new Error('正常关窗8秒内没有结束')) }, 8000)
    // 由产品标题栏原生指针触发window:close；成功路径不调用app.quit或强杀。
    await click('[aria-label=关闭]', false)
  } catch (error) { await fail(error) }
}

let child, timer, activePidsPath, interrupted = false
const phases = []
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const stop = () => { interrupted = true; if (child && child.exitCode === null) child.kill() }
process.once('SIGINT', stop); process.once('SIGTERM', stop)
async function runPhase(phase) {
  const phaseName = 'phase-' + phase, resultPath = join(evidence, phaseName + '.json'), pidsPath = join(evidence, phaseName + '-pids.json'), logPath = join(evidence, phaseName + '.log')
  const config = { phase, main: pathToFileURL(resolve('out/main/index.js')).href, profile, evidence, textPath, sentinel, url }
  const driverPath = join(temporary, phaseName + '.mjs')
  writeFileSync(driverPath, '(' + driver.toString() + ')(' + JSON.stringify(config) + ');')
  for (const path of [resultPath, pidsPath]) rmSync(path, { force: true })
  activePidsPath = pidsPath
  writeFileSync(logPath, '')
  const env = { ...process.env, COGENT_HOME: home, HOME: home, USERPROFILE: home, NODE_ENV: 'production' }
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  let timedOut = false
  child = spawn(electron, [driverPath], { cwd: repository, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  child.stdout.on('data', data => { appendFileSync(logPath, data); process.stdout.write(data) })
  child.stderr.on('data', data => { appendFileSync(logPath, data); process.stderr.write(data) })
  timer = setTimeout(() => { timedOut = true; child.kill() }, 140000)
  const exitCode = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done) })
  clearTimeout(timer)
  const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : { passed: false, phase, error: 'Electron未写入结果' }
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
  phases.push(result)
  activePidsPath = undefined
  return result.passed
}
try {
  if (await runPhase(1)) await runPhase(2)
} finally {
  clearTimeout(timer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop)
  if (child && child.exitCode === null) child.kill()
  await new Promise(done => server.close(done))
  writeFileSync(join(evidence, 'http-requests.json'), JSON.stringify(httpRequests, null, 2))
  const safe = relative(resolve(tmpdir()), resolve(temporary))
  assert.ok(!isAbsolute(safe) && !safe.startsWith('..') && safe.startsWith('cogent-workspace-memory-'), '只删除本次生成的系统临时目录')
  // spawn/等待本身失败时尚未形成phase报告，仍从本次phase的登记文件回收自有Host/GPU子进程。
  const knownPids = [...new Set([child && child.exitCode === null ? child.pid : undefined, ...phases.flatMap(result => result.cleanup.remainingPids), ...(activePidsPath && existsSync(activePidsPath) ? JSON.parse(readFileSync(activePidsPath, 'utf8')) : [])])].filter(Boolean)
  for (const pid of knownPids.filter(alive)) { try { process.kill(pid) } catch {} }
  const cleanupDeadline = Date.now() + 5000
  while (knownPids.some(alive) && Date.now() < cleanupDeadline) await new Promise(done => setTimeout(done, 100))
  const remainingPids = knownPids.filter(alive)
  if (remainingPids.length === 0) rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  const summary = { passed: phases.length === 2 && phases.every(result => result.passed) && remainingPids.length === 0, runId: sentinel, checks: phases.reduce((sum, result) => sum + (result.checks?.length ?? 0), 0), phases: phases.map(result => ({ phase: result.phase, passed: result.passed, error: result.error })), sharedIsolatedProfile: true, normalGpu: true, temporaryProfileRemoved: remainingPids.length === 0, remainingPids, httpRequests: httpRequests.length, evidence }
  writeFileSync(join(evidence, 'summary.json'), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary, null, 2))
  if (!summary.passed) process.exitCode = 1
}
