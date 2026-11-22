/** 开发StrictMode与构建版共用真实产品链；仅renderer开发服务，所有资料、端口与进程隔离。 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer as createHttpServer } from 'node:http'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import electron from 'electron'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(workspace)
const modes = process.argv.includes('--both') ? ['development', 'production'] : [process.argv.includes('--production') ? 'production' : 'development']
const evidence = resolve(process.env.BROWSER_STARTUP_EVIDENCE ?? 'tmp/browser-startup-electron')
const temporary = mkdtempSync(join(tmpdir(), 'cogent-browser-startup-'))
const results = []
for (const entry of ['out/main/index.js', 'out/main/host.js', 'out/preload/index.cjs', 'out/preload/browser-dialog.cjs', ...(modes.includes('production') ? ['out/renderer/index.html'] : [])]) {
  assert.ok(existsSync(resolve(entry)), '缺少产品构建：' + entry + '；本脚本不自动build')
}
mkdirSync(evidence, { recursive: true })

async function bounded(promise, milliseconds, label) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_done, reject) => { timer = setTimeout(() => reject(new Error(label + '超时')), milliseconds) })])
  } finally { clearTimeout(timer) }
}

async function driver(config) {
  const { app, ipcMain, webContents } = await import('electron')
  const { writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const childProcess = (await import('node:child_process')).default
  const ownedPids = new Set([process.pid])
  const savePids = () => writeFileSync(join(config.evidence, 'owned-pids.json'), JSON.stringify([...ownedPids]))
  const spawnChild = childProcess.spawn
  childProcess.spawn = (...args) => {
    const child = spawnChild(...args)
    if (child.pid) { ownedPids.add(child.pid); savePids() }
    return child
  }
  ;(await import('node:module')).syncBuiltinESMExports()
  savePids()
  app.setPath('userData', config.profile)
  const started = Date.now(), requests = [], checks = [], guests = [], rendererErrors = [], liveLeases = new Set(), reservedByTab = new Map(), heldReplies = new Map(), leaseToTab = new Map()
  let win, stage = '启动产品', finishing = false, passed = false, failure, injectNextAttach = false, injectedFailure
  const at = () => Date.now() - started
  const record = name => { checks.push(name); console.log('[启动验收] ' + name) }
  const created = new Promise(done => app.once('browser-window-created', (_event, value) => done(value)))
  const originalHandle = ipcMain.handle.bind(ipcMain)
  // 只观测真实IPC；故障注入与迟到回复写入报告，业务处理始终交原产品handler。
  ipcMain.handle = (channel, listener) => originalHandle(channel, async (event, ...args) => {
    if (channel !== 'cogent:browser:request') return listener(event, ...args)
    const { method, params } = args[0]
    const item = { id: requests.length + 1, method, params, calledAt: at(), stage, status: 'pending' }
    requests.push(item)
    try {
      if (method === 'attach' && injectNextAttach) {
        injectNextAttach = false
        injectedFailure = { lease: params.lease, guestId: params.webContentsId, tabId: leaseToTab.get(params.lease), at: at() }
        item.injected = true
        throw new Error('验收注入：首次浏览器连接失败')
      }
      const value = await listener(event, ...args)
      item.handledAt = at()
      if (method === 'reserve') {
        item.reservation = { lease: value.lease, tabId: params.tabId, partition: value.partition, bootstrapUrl: value.bootstrapUrl }
        liveLeases.add(value.lease); leaseToTab.set(value.lease, params.tabId)
        const entries = reservedByTab.get(params.tabId) ?? []
        entries.push(item); reservedByTab.set(params.tabId, entries)
        if (config.mode === 'development' && entries.length === 1) {
          item.delayedReply = true
          // 新effect完成真实attach/visibility后才返回旧reserve，确定性覆盖迟到release。
          await new Promise((done, reject) => {
            const timer = setTimeout(() => { heldReplies.delete(params.tabId); reject(new Error('StrictMode旧reserve等待新effect连接超过20秒')) }, 20000)
            heldReplies.set(params.tabId, () => { clearTimeout(timer); heldReplies.delete(params.tabId); done() })
          })
        }
      }
      if (method === 'visibility' && params.active) {
        const tabId = leaseToTab.get(params.lease)
        const entries = reservedByTab.get(tabId) ?? []
        if (entries.length >= 2) heldReplies.get(tabId)?.()
      }
      if (method === 'release' || method === 'close' && value.closed && !value.keepMounted) liveLeases.delete(params.lease)
      item.status = 'ok'; item.returnedAt = at()
      if (method === 'close') item.result = value
      return value
    } catch (error) {
      item.status = 'error'; item.returnedAt = at(); item.error = String(error)
      throw error
    }
  })
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return
    const item = { id: contents.id, createdAt: at(), urls: [] }
    guests.push(item)
    contents.on('did-navigate', (_event, url) => item.urls.push({ url, at: at() }))
    contents.once('destroyed', () => { item.destroyedAt = at() })
  })
  const timer = setInterval(() => {
    if (app.isReady()) for (const item of app.getAppMetrics()) ownedPids.add(item.pid)
    savePids()
  }, 250)
  timer.unref()
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
  const click = async selector => {
    await wait(() => evaluate(selector => {
      const element = document.querySelector(selector)
      return !!element && !element.disabled && element.getAttribute('aria-disabled') !== 'true' && !element.closest('[inert]') && element.getBoundingClientRect().width > 0
    }, selector), '控件就绪 ' + selector)
    const point = await evaluate(selector => {
      const element = document.querySelector(selector)
      element.scrollIntoView({ block: 'center', inline: 'nearest' })
      const rect = element.getBoundingClientRect(), x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2)
      const hit = document.elementFromPoint(x, y)
      if (hit !== element && !element.contains(hit)) throw new Error('点击被遮挡：' + selector)
      return { x, y }
    }, selector)
    win.focus(); win.webContents.focus()
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
    await settle()
  }
  const clickText = async (text, selector) => {
    await wait(() => evaluate((text, selector) => [...document.querySelectorAll(selector)].some(element => element.textContent.trim() === text), text, selector), '显示入口 ' + text)
    await evaluate((text, selector) => {
      document.querySelector('[data-startup-target]')?.removeAttribute('data-startup-target')
      ;[...document.querySelectorAll(selector)].find(element => element.textContent.trim() === text).setAttribute('data-startup-target', '')
    }, text, selector)
    await click('[data-startup-target]')
    await evaluate(() => document.querySelector('[data-startup-target]')?.removeAttribute('data-startup-target'))
  }
  const activePane = '[data-workspace-panel]:not([hidden]) [data-browser-pane]'
  const address = activePane + ' [aria-label="网页地址或搜索"]'
  const currentPane = () => evaluate(selector => {
    const root = document.querySelector(selector)
    const guest = root?.querySelector('webview')
    return root && guest ? { tabId: root.dataset.browserPane, lease: root.dataset.browserLease, guestId: guest.getWebContentsId() } : null
  }, activePane)
  const snapshot = async name => writeFileSync(join(config.evidence, name + '.png'), (await win.capturePage()).toPNG())
  const finish = async () => {
    if (finishing) return
    finishing = true; clearTimeout(watchdog); clearInterval(timer)
    const leasesBeforeCleanup = [...liveLeases]
    // 异常场景仅清理本次观测的lease；成功路径必须已由真实UI完成全部关闭。
    if (win && !win.isDestroyed() && liveLeases.size) {
      stage = '失败清理'
      await evaluate(async leases => {
        for (const lease of leases) await window.cogent.browserRequest('release', { lease })
      }, [...liveLeases]).catch(error => { failure = { ...failure, cleanupError: String(error) } })
    }
    for (const done of [...heldReplies.values()]) done()
    if (app.isReady()) for (const item of app.getAppMetrics()) ownedPids.add(item.pid)
    savePids()
    const result = { passed, mode: config.mode, stage, checks, requests, guests, injectedFailure, rendererErrors, leasesBeforeCleanup, remainingLeases: [...liveLeases], ownedPids: [...ownedPids], elapsedMs: at(), electron: process.versions.electron, chromium: process.versions.chrome, ...failure }
    writeFileSync(join(config.evidence, 'result.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify({ mode: config.mode, passed, checks: checks.length, error: failure?.error, result: join(config.evidence, 'result.json') }))
    app.quit(); setTimeout(() => app.exit(2), 7000).unref()
  }
  const watchdog = setTimeout(() => { failure = { error: '产品验收150秒watchdog', failedStage: stage }; void finish() }, 150000)
  process.on('uncaughtException', error => { failure = { error: String(error), stack: error.stack, failedStage: stage }; void finish() })
  process.on('unhandledRejection', error => { failure = { error: String(error), stack: error?.stack, failedStage: stage }; void finish() })
  try {
    await import(config.main)
    win = await created
    win.setSize(1500, 1000); win.show(); win.focus()
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) rendererErrors.push({ at: at(), message }) })
    await wait(() => evaluate(() => !!document.querySelector('[data-workspace-frame]') && typeof window.cogent?.browserRequest === 'function'), '真实首页与main/preload桥就绪')
    const renderer = await evaluate(() => ({ url: location.href, scripts: [...document.scripts].map(script => script.src) }))
    if (config.mode === 'development' && !renderer.scripts.some(url => url.includes('/@vite/client'))) throw new Error('开发验收没有加载真实Vite客户端')
    if (config.mode === 'production' && !renderer.url.startsWith('file:')) throw new Error('构建版没有加载产品本地renderer')
    record(config.mode === 'development' ? '真实Vite开发renderer已加载' : '真实构建renderer已加载')
    const before = await evaluate(() => window.cogent.engineRequest('session.list', {}))
    record('真实Host进程完成session.list往返')
    await click('[aria-label=展开标签页区]')
    const opened = []
    for (let index = 1; index <= 3; index++) {
      stage = '启动浏览器' + index
      if (index > 1) await click('[aria-label=新建标签页]')
      if (index === 2) injectNextAttach = true
      await click('[aria-label=打开内置浏览器]')
      if (index === 2) {
        await wait(() => evaluate(selector => document.querySelector(selector + ' [role=alert]')?.textContent.includes('验收注入：首次浏览器连接失败') && document.querySelector(selector + ' [aria-label="网页地址或搜索"]')?.disabled === true, activePane), 'attach失败明确显示错误并保持地址栏未就绪')
        await snapshot('attach-failure')
        await clickText('重试', activePane + ' [role=alert] button')
      }
      await wait(() => evaluate(selector => document.querySelector(selector)?.disabled === false, address), '浏览器' + index + '完成真实attach/visibility并启用地址栏')
      const pane = await currentPane()
      if (!pane || !pane.lease) throw new Error('浏览器pane未公开当前lease/guest')
      if (config.mode === 'development') {
        const reservations = reservedByTab.get(pane.tabId)
        if (reservations.length < 2 || new Set(reservations.map(item => item.reservation.lease)).size !== reservations.length) throw new Error('StrictMode未双reserve或同tab复用了lease：' + JSON.stringify(reservations))
        const old = reservations[0]
        await wait(() => Promise.resolve(requests.some(item => item.method === 'release' && item.params.lease === old.reservation.lease && item.status === 'ok')), '旧effect迟到release已完成且使用独立lease')
        const attached = requests.find(item => item.method === 'attach' && item.params.lease === pane.lease && item.status === 'ok')
        const released = requests.find(item => item.method === 'release' && item.params.lease === old.reservation.lease && item.status === 'ok')
        if (!attached || released.calledAt < attached.handledAt || pane.lease === old.reservation.lease) throw new Error('迟到旧release没有发生在新guest连接后或lease相同')
        record('开发StrictMode同tab独立lease，旧release未撤销新guest')
      }
      const guest = webContents.fromId(pane.guestId)
      if (!guest || guest.isDestroyed()) throw new Error('已就绪的新guest被旧effect释放')
      if (index === 2) {
        if (pane.guestId === injectedFailure.guestId || pane.lease === injectedFailure.lease) throw new Error('重试复用了失败guest或lease')
        await wait(() => Promise.resolve(!webContents.fromId(injectedFailure.guestId) || webContents.fromId(injectedFailure.guestId).isDestroyed()), '重试已销毁失败guest并创建新guest')
        record('用户点击重试后使用新guest与新lease')
      }
      await click(address)
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] })
      const url = config.fixture + '/page?tab=' + index
      await win.webContents.insertText(url)
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
      win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
      await wait(() => Promise.resolve(!guest.isDestroyed() && guest.getURL() === url).then(async ready => ready && await guest.executeJavaScript('document.querySelector("#fixture-ready")?.textContent==="Browser Startup ' + index + '"')), '浏览器' + index + '经真实地址栏导航本地夹具')
      guest.focus()
      await guest.executeJavaScript('document.querySelector("#form").focus()')
      await guest.insertText('preserved-' + index)
      await guest.executeJavaScript('window.scrollTo(0,240)')
      const form = await guest.executeJavaScript('({value:document.querySelector("#form").value,events:window.inputEvents,scrollY:window.scrollY,node:typeof require,sdk:typeof window.cogent})')
      if (form.value !== 'preserved-' + index || form.events < 1 || form.node !== 'undefined' || form.sdk !== 'undefined') throw new Error('真实guest输入或安全隔离失败：' + JSON.stringify(form))
      opened.push({ ...pane, url, form })
      await snapshot('browser-' + index)
    }
    stage = '隐藏恢复'
    for (const pane of opened) {
      await click('[role=tab][id=' + JSON.stringify('workspace-tab-' + pane.tabId) + ']')
      await wait(() => evaluate(tabId => {
        const panel = document.querySelector('[data-workspace-panel=' + JSON.stringify(tabId) + ']')
        return panel && !panel.hidden && !panel.inert && panel.getBoundingClientRect().width > 0
      }, pane.tabId), '真实标签切换恢复 ' + pane.tabId)
      const current = await currentPane(), guest = webContents.fromId(pane.guestId)
      if (current.guestId !== pane.guestId || current.lease !== pane.lease || !guest || guest.isDestroyed()) throw new Error('隐藏恢复替换了guest或lease')
      const form = await guest.executeJavaScript('({value:document.querySelector("#form").value,scrollY:window.scrollY})')
      if (form.value !== pane.form.value || form.scrollY !== pane.form.scrollY) throw new Error('隐藏恢复丢失表单或滚动：' + JSON.stringify({ before: pane.form, after: form }))
      record('同一guest保留表单与滚动 ' + pane.tabId)
    }
    await snapshot('three-browsers-restored')
    stage = '关闭全部'
    const after = await evaluate(() => window.cogent.engineRequest('session.list', {}))
    if (before.length !== after.length) throw new Error('单独打开浏览器暗建聊天session')
    record('三个浏览器未暗建聊天session')
    await click('[aria-label=标签页列表]'); await clickText('关闭全部标签页', '[data-slot=popover-content] button')
    await wait(() => evaluate(() => document.querySelectorAll('[data-workspace-panel]').length === 0), '真实关闭全部移除所有pane')
    await wait(() => Promise.resolve(liveLeases.size === 0 && webContents.getAllWebContents().every(item => item.getType() !== 'webview')), '全部lease和原生guest归零')
    if (rendererErrors.some(item => !item.message.includes('验收注入：首次浏览器连接失败'))) throw new Error('产品renderer发生控制台错误：' + JSON.stringify(rendererErrors))
    passed = true
  } catch (error) {
    failure = { error: String(error), stack: error.stack, failedStage: stage }
    if (win && !win.isDestroyed()) {
      await snapshot('failure').catch(() => {})
      failure.dom = await evaluate(() => ({ url: location.href, text: document.body.innerText.slice(-10000), panes: [...document.querySelectorAll('[data-browser-pane]')].map(root => ({ tabId: root.dataset.browserPane, lease: root.dataset.browserLease, alert: root.querySelector('[role=alert]')?.textContent, disabled: root.querySelector('input')?.disabled })) })).catch(() => null)
    }
  } finally { await finish() }
}

const fixtureRequests = []
const fixture = createHttpServer((request, response) => {
  fixtureRequests.push({ url: request.url, at: Date.now() })
  const index = new URL(request.url, 'http://127.0.0.1').searchParams.get('tab') ?? '0'
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end('<!doctype html><title>Browser Startup ' + index + '</title><style>body{margin:24px;background:#f1f5f9;color:#142237;font:18px sans-serif}main{height:3000px}</style><main><h1 id="fixture-ready">Browser Startup ' + index + '</h1><input id="form" aria-label="Fixture form" oninput="window.inputEvents++"><p>StrictMode native guest startup fixture</p></main><script>window.inputEvents=0</script>')
})
let vite, child, childTimer, interrupted = false
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const stop = () => { interrupted = true; if (child && child.exitCode === null) child.kill() }
process.once('SIGINT', stop); process.once('SIGTERM', stop)
try {
  await bounded(new Promise(done => fixture.listen(0, '127.0.0.1', done)), 10000, '夹具服务启动')
  for (const mode of modes) {
    if (interrupted) break
    const run = join(temporary, mode), target = join(evidence, mode), home = join(run, 'home')
    for (const path of [home, target]) mkdirSync(path, { recursive: true })
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ version: 1, closeBehavior: 'quit', soundEnabled: false, toastEnabled: false }))
    let rendererUrl
    try {
      if (mode === 'development') {
        const { loadConfigFromFile } = await import('electron-vite')
        const { createServer } = await import('vite')
        const loaded = await bounded(loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve('electron.vite.config.ts'), workspace), 45000, '开发配置加载')
        const renderer = loaded.config.renderer
        vite = await createServer({ ...renderer, root: resolve('src/renderer'), cacheDir: join(run, 'vite-cache'), configFile: false, mode: 'development', clearScreen: false, server: { ...renderer.server, host: '127.0.0.1', port: 0, strictPort: true } })
        await bounded(vite.listen(), 45000, '独立renderer开发服务启动')
        const address = vite.httpServer.address()
        assert.ok(address && typeof address !== 'string')
        rendererUrl = 'http://127.0.0.1:' + address.port
      }
      const config = { mode, profile: join(run, 'profile'), evidence: target, main: pathToFileURL(resolve('out/main/index.js')).href, fixture: 'http://127.0.0.1:' + fixture.address().port }
      const driverPath = join(run, 'driver.mjs'), resultPath = join(target, 'result.json'), pidsPath = join(target, 'owned-pids.json')
      writeFileSync(driverPath, '(' + driver.toString() + ')(' + JSON.stringify(config) + ');')
      for (const path of [resultPath, pidsPath]) rmSync(path, { force: true })
      const env = { ...process.env, COGENT_HOME: home, HOME: home, USERPROFILE: home, NODE_ENV: mode }
      delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
      if (rendererUrl) env.ELECTRON_RENDERER_URL = rendererUrl
      let timedOut = false
      child = spawn(electron, [driverPath], { cwd: workspace, env, stdio: 'inherit', windowsHide: true })
      childTimer = setTimeout(() => { timedOut = true; child.kill() }, 180000)
      const exitCode = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done) })
      clearTimeout(childTimer)
      const report = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : { passed: false, error: 'Electron未返回结果' }
      const ownedPids = [...new Set([child.pid, ...(existsSync(pidsPath) ? JSON.parse(readFileSync(pidsPath, 'utf8')) : [])])].filter(Boolean)
      const deadline = Date.now() + 5000
      while (ownedPids.some(alive) && Date.now() < deadline) await new Promise(done => setTimeout(done, 100))
      const forcedPids = ownedPids.filter(alive)
      // 优先让真实产品退出；兜底只处理本轮登记PID，绝不按进程名结束用户的开发实例。
      for (const pid of forcedPids) { try { process.kill(pid) } catch {} }
      const forceDeadline = Date.now() + 5000
      while (ownedPids.some(alive) && Date.now() < forceDeadline) await new Promise(done => setTimeout(done, 100))
      report.cleanup = { exitCode, timedOut, interrupted, forcedPids, remainingPids: ownedPids.filter(alive), ownedPids }
      report.renderer = { url: rendererUrl ?? 'out/renderer/index.html', devServer: mode === 'development', host: '127.0.0.1', randomPort: mode === 'development' }
      report.fixtureRequests = fixtureRequests.filter(item => item.url.includes('tab='))
      if (exitCode !== 0 || timedOut || interrupted || forcedPids.length || report.cleanup.remainingPids.length) report.passed = false
      writeFileSync(resultPath, JSON.stringify(report, null, 2))
      results.push({ mode, passed: report.passed, result: resultPath })
    } finally {
      clearTimeout(childTimer)
      if (child && child.exitCode === null) child.kill()
      child = undefined
      if (vite) { await bounded(vite.close(), 15000, 'renderer开发服务关闭'); vite = undefined }
    }
  }
} finally {
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop)
  fixture.closeAllConnections()
  await bounded(new Promise(done => fixture.close(done)), 10000, '夹具服务关闭')
  const path = relative(resolve(tmpdir()), resolve(temporary))
  assert.ok(!isAbsolute(path) && !path.startsWith('..') && path.startsWith('cogent-browser-startup-'), '临时目录必须在本次生成的系统临时根内')
  const remaining = results.flatMap(item => JSON.parse(readFileSync(item.result, 'utf8')).cleanup.remainingPids)
  if (remaining.length === 0) rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  else console.error('自有进程尚存，保留本次profile：' + temporary)
  const summary = { passed: results.length === modes.length && results.every(item => item.passed), results, rendererDevServerClosed: !vite, fixtureServerClosed: !fixture.listening, temporaryProfileRemoved: remaining.length === 0 }
  writeFileSync(join(evidence, 'summary.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
  if (!summary.passed) process.exitCode = 1
}
