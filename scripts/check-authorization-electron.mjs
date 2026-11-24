/** 隔离的真实产品边界回归：可信窗口正常工作，外来导航、同名 demo、iframe 均不借权。 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import electron from 'electron'

const root = mkdtempSync(join(tmpdir(), 'cogent-authorization-'))
const evidence = resolve('tmp/authorization-electron')
const home = join(root, 'home')
mkdirSync(home); mkdirSync(evidence, { recursive: true })
writeFileSync(join(home, 'settings.json'), JSON.stringify({ version: 1, closeBehavior: 'quit', soundEnabled: false, toastEnabled: false }))
const foreignDemo = join(root, 'demo.html')
writeFileSync(foreignDemo, '<!doctype html><title>隔离同名文件</title>')

async function driver(config) {
  const { app, BrowserWindow, webContents } = await import('electron')
  const { writeFileSync } = await import('node:fs')
  const { createServer } = await import('node:http')
  app.setPath('userData', config.profile)
  app.on('browser-window-created', (_event, win) => { win.show = () => {} })
  const report = { checks: [], errors: [], passed: false }
  const check = (ok, label) => { if (!ok) throw new Error(label); report.checks.push(label) }
  const wait = async (test, label) => {
    const end = Date.now() + 15000
    while (Date.now() < end) { const value = await test(); if (value) return value; await new Promise(done => setTimeout(done, 20)) }
    throw new Error('超时：' + label)
  }
  let server
  try {
    const created = new Promise(done => app.once('browser-window-created', (_event, win) => done(win)))
    await import(config.main)
    const main = await created
    await wait(() => main.webContents.executeJavaScript('!!document.querySelector("[data-home-split]")'), '主界面')
    const sessions = await main.webContents.executeJavaScript('window.cogent.engineRequest("session.list", {})')
    check(Array.isArray(sessions), '主窗口 sandbox preload 与 Host 正常接通')
    await main.webContents.executeJavaScript('window.cogent.openConsole()')
    const consoleWindow = await wait(() => BrowserWindow.getAllWindows().find(win => win !== main && win.webContents.getURL().endsWith('#console')), '控制台')
    await wait(() => consoleWindow.webContents.executeJavaScript('!!window.cogent'), '控制台 preload')
    check(Array.isArray(await consoleWindow.webContents.executeJavaScript('window.cogent.engineRequest("session.list", {})')), '控制台可读取会话')
    const denied = await consoleWindow.webContents.executeJavaScript('window.cogent.engineRequest("session.create", {}).then(() => false, () => true)')
    check(denied, '控制台不能修改会话')
    await main.webContents.executeJavaScript('window.cogent.openEmbedded()')
    const embedded = await wait(() => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('#embedded')), 'demo 容器')
    const guest = await wait(async () => {
      const id = await embedded.webContents.executeJavaScript('document.querySelector("webview")?.getWebContentsId()').catch(() => undefined)
      return id && webContents.fromId(id)
    }, '真实 demo guest')
    await wait(() => guest.executeJavaScript('!!window.cogentHost'), 'demo SDK')
    const result = await guest.executeJavaScript('(async () => ({ ready: await window.cogentHost.ready(), sessions: await window.cogentHost.request("session.list", {}) }))()')
    check(Array.isArray(result.sessions), '随包 demo 可取得 SDK 并读取 Host')

    let attached = false
    main.webContents.on('did-attach-webview', () => { attached = true })
    const rejected = new Promise(done => main.webContents.once('will-attach-webview', () => setTimeout(done, 50)))
    await main.webContents.executeJavaScript(`(() => { const view = document.createElement('webview'); view.src = ${JSON.stringify(config.foreignDemo)}; document.body.append(view); })()`)
    await rejected
    check(!attached, '应用目录外同名 demo 在附加前被拒绝')

    await main.webContents.executeJavaScript(`new Promise(resolve => { const frame = document.createElement('iframe'); frame.onload = () => { resolve(typeof frame.contentWindow.cogent === 'undefined'); frame.remove() }; frame.src = ${JSON.stringify(config.renderer)}; document.body.append(frame) })`).then(value => check(value, 'iframe 不获得特权 preload'))
    server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><title>隔离外来页面</title>') })
    await new Promise(done => server.listen(0, '127.0.0.1', done))
    const foreign = `http://127.0.0.1:${server.address().port}/foreign`
    const original = main.webContents.getURL()
    const navigation = new Promise(done => main.webContents.once('will-frame-navigate', event => { if (event.isMainFrame) setTimeout(done, 50) }))
    await main.webContents.executeJavaScript(`setTimeout(() => { location.href = ${JSON.stringify(foreign)} }, 0); true`)
    await navigation
    check(main.webContents.getURL() === original, '主窗口外来顶层导航被阻止')
    // main 直接 loadURL 会绕过 will-navigate，仍须由每次 IPC 的文档校验兜住。
    await main.webContents.loadURL(foreign)
    check(await main.webContents.executeJavaScript('window.cogent.engineRequest("session.create", {}).then(() => false, () => true)'), '强制换成外来文档后 IPC 仍拒绝')
    report.passed = true
  } catch (error) { report.errors.push(String(error.stack || error)) }
  finally {
    server?.closeAllConnections(); server?.close()
    writeFileSync(config.result, JSON.stringify(report, null, 2))
    app.quit()
  }
}

const result = join(evidence, 'result.json'), entry = join(root, 'driver.mjs')
rmSync(result, { force: true })
writeFileSync(entry, `(${driver.toString()})(${JSON.stringify({ main: pathToFileURL(resolve('out/main/index.js')).href, renderer: pathToFileURL(resolve('out/renderer/index.html')).href, foreignDemo: pathToFileURL(foreignDemo).href, profile: join(root, 'profile'), result })});`)
const env = { ...process.env, COGENT_HOME: home, USERPROFILE: home, HOME: home, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
const child = spawn(electron, [entry], { env, stdio: 'inherit', windowsHide: true })
const deadline = setTimeout(() => {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  else child.kill('SIGKILL')
}, 45000)
try {
  const code = await new Promise((done, reject) => { child.once('close', done); child.once('error', reject) })
  const report = existsSync(result) ? JSON.parse(readFileSync(result, 'utf8')) : { passed: false, errors: ['未生成结果'] }
  console.log(JSON.stringify(report, null, 2))
  if (code !== 0 || !report.passed) process.exitCode = 1
} finally {
  clearTimeout(deadline)
  if (!root.startsWith(join(tmpdir(), 'cogent-authorization-'))) throw new Error('临时目录边界错误')
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
