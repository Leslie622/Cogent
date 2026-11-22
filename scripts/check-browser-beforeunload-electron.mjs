/** 只验证真实webview关闭取消/确认；阶段立即落盘，原生关闭每次最多等待10秒。 */
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import electron from 'electron'

const evidence = resolve('tmp/browser-beforeunload-electron'); mkdirSync(evidence, { recursive: true })
const root = mkdtempSync(join(evidence, 'run-')), home = join(root, 'home'); mkdirSync(home)
writeFileSync(join(home, 'settings.json'), JSON.stringify({ version: 1, closeBehavior: 'quit', soundEnabled: false }))
const config = { root, profile: join(root, 'profile'), main: pathToFileURL(resolve('out/main/index.js')).href }

async function driver(config) {
  const { app, webContents, dialog } = await import('electron')
  const { writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { createServer } = await import('node:http')
  const childProcess = (await import('node:child_process')).default
  const { syncBuiltinESMExports } = await import('node:module')
  const ownedChildren = new Set(), spawnChild = childProcess.spawn
  childProcess.spawn = (...args) => { const child = spawnChild(...args); if (child.pid) ownedChildren.add(child.pid); return child }; syncBuiltinESMExports()
  app.setPath('userData', config.profile)
  const result = { electron: process.versions.electron, stages: [], events: [], questions: [], errors: [], passed: false }
  const started = Date.now(); let win, guest, server
  const persist = () => { result.ownedPids = [...new Set([...ownedChildren, ...(app.isReady() ? app.getAppMetrics().map(item => item.pid) : [])])]; writeFileSync(join(config.root, 'stage.json'), JSON.stringify(result, null, 2)) }
  const stage = name => { result.stage = name; result.stages.push({ name, at: Date.now() - started }); persist() }
  const bounded = async (operation, label) => {
    let timer
    try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' 超过10秒')), 10000) })]) }
    finally { clearTimeout(timer) }
  }
  try {
    server = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end('<title>Beforeunload fixture</title><input id="form" value="initial">') })
    await new Promise(done => server.listen(0, '127.0.0.1', done))
    dialog.showMessageBox = async () => ({ response: 0 })
    dialog.showMessageBoxSync = () => 0
    const created = new Promise(done => app.once('browser-window-created', (_event, value) => done(value)))
    stage('product-import'); await import(config.main); win = await created
    if (win.webContents.isLoading()) await bounded(new Promise(done => win.webContents.once('did-finish-load', done)), '主页面加载')
    const evaluate = source => win.webContents.executeJavaScript(source, true)
    const rpc = (method, params) => bounded(evaluate('window.cogent.browserRequest(' + JSON.stringify(method) + ',' + JSON.stringify(params) + ')'), '浏览器' + method)
    stage('reserve'); const reservation = await rpc('reserve', { scopeId: 'beforeunload-probe', tabId: 'guarded' })
    const id = await bounded(evaluate('(async()=>{const view=document.createElement("webview");view.id="beforeunload-probe";view.style="position:fixed;display:flex;inset:100px;width:600px;height:300px;z-index:100";view.setAttribute("partition",' + JSON.stringify(reservation.partition) + ');view.src=' + JSON.stringify(reservation.bootstrapUrl) + ';const ready=new Promise(done=>view.addEventListener("dom-ready",()=>done(view.getWebContentsId()),{once:true}));document.body.append(view);return ready})()'), 'guest附加')
    guest = webContents.fromId(id); result.guestId = id
    await rpc('attach', { lease: reservation.lease, webContentsId: id }); await rpc('visibility', { lease: reservation.lease, active: true })
    result.initialUnloadListeners = guest.rawListeners('will-prevent-unload').map(listener => String(listener))
    for (const name of ['will-prevent-unload', 'did-start-navigation', 'did-fail-load', 'did-navigate', 'did-stop-loading', 'destroyed']) guest.on(name, (event, ...args) => { result.events.push({ name, stage: result.stage, at: Date.now() - started, defaultPrevented: event?.defaultPrevented, args: args.filter(value => ['string', 'number', 'boolean'].includes(typeof value)), destroyed: guest.isDestroyed() }); persist() })
    stage('navigate'); await rpc('navigate', { lease: reservation.lease, url: 'http://127.0.0.1:' + server.address().port + '/' })
    await guest.executeJavaScript('window.addEventListener("beforeunload",event=>{event.preventDefault();event.returnValue=""})')
    const point = await guest.executeJavaScript('(()=>{const r=document.querySelector("#form").getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()')
    stage('native-activation'); win.show(); win.focus(); await new Promise(done => setTimeout(done, 200))
    await bounded((async () => {
      while (!(await guest.executeJavaScript('navigator.userActivation.hasBeenActive'))) {
        guest.focus(); guest.sendInputEvent({ type: 'mouseMove', ...point }); guest.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point }); guest.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
        guest.sendInputEvent({ type: 'keyDown', keyCode: 'A' }); guest.sendInputEvent({ type: 'char', keyCode: 'a' }); guest.sendInputEvent({ type: 'keyUp', keyCode: 'A' })
        await new Promise(done => setTimeout(done, 50))
      }
    })(), '真实用户激活')
    await guest.executeJavaScript('document.querySelector("#form").value="unsaved"')
    const originalUrl = guest.getURL(), originalTitle = guest.getTitle()
    await evaluate('window.beforeUnloadStates=[];window.cogent.onBrowserEvent(event=>{if(event.type==="state"&&event.state.lease===' + JSON.stringify(reservation.lease) + ')window.beforeUnloadStates.push({url:event.state.url,title:event.state.title,localFile:event.state.localFile})});undefined')
    dialog.showMessageBoxSync = (_window, options) => { result.questions.push({ choice: 1, stage: result.stage, at: Date.now() - started, title: options.title }); persist(); return 1 }
    stage('cancel-request'); result.cancelledClose = await rpc('close', { lease: reservation.lease }); stage('cancel-reply')
    if (result.cancelledClose.closed || guest.isDestroyed() || result.questions.length !== 1) throw new Error('取消关闭仍销毁guest或没有原生询问')
    result.formAfterCancel = await bounded(guest.executeJavaScript('document.querySelector("#form").value'), '取消后表单读取'); stage('cancel-form')
    await new Promise(done => setTimeout(done, 200))
    if (guest.isDestroyed() || webContents.fromId(id) !== guest) throw new Error('取消返回后200ms原guest仍异步销毁或被替换')
    result.formAfter200ms = await bounded(guest.executeJavaScript('document.querySelector("#form").value'), '200ms后表单读取')
    if (result.formAfterCancel !== 'unsaved' || result.formAfter200ms !== 'unsaved') throw new Error('取消关闭丢失原表单')
    stage('cancel-stable-200ms'); await rpc('history', { lease: reservation.lease }); stage('cancel-lease-valid')
    dialog.showMessageBoxSync = (_window, options) => { result.questions.push({ choice: 0, stage: result.stage, at: Date.now() - started, title: options.title }); persist(); return 0 }
    stage('confirm-request'); result.confirmedClose = await rpc('close', { lease: reservation.lease }); stage('confirm-reply')
    if (!result.confirmedClose.closed || !guest.isDestroyed() || result.questions.length !== 2) throw new Error('确认关闭未释放guest或没有再次询问')
    result.publicStates = await evaluate('window.beforeUnloadStates')
    if (!result.publicStates.length || result.publicStates.some(state => state.url !== originalUrl || state.title !== originalTitle)) throw new Error('关闭探测污染了标签原URL或标题')
    result.passed = true
  } catch (error) { result.failedStage = result.stage; result.errors.push(String(error.stack ?? error)) }
  finally {
    stage('cleanup')
    // 诊断失败也强制销毁本脚本独有窗口，不让坏的close promise阻止采证退出。
    if (win && !win.isDestroyed()) win.destroy()
    server?.closeAllConnections(); await new Promise(done => server ? server.close(done) : done())
    result.elapsedMs = Date.now() - started; persist(); writeFileSync(join(config.root, 'result.json'), JSON.stringify(result, null, 2)); app.exit(0)
  }
}
const driverPath = join(root, 'driver.mjs'); writeFileSync(driverPath, '(' + driver.toString() + ')(' + JSON.stringify(config) + ');')
const env = { ...process.env, COGENT_HOME: home, USERPROFILE: home, HOME: home }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
const child = spawn(electron, [driverPath], { cwd: process.cwd(), env, stdio: 'inherit', windowsHide: true })
const timeout = setTimeout(() => child.kill(), 40000), code = await new Promise((done, reject) => { child.once('exit', done); child.once('error', reject) }); clearTimeout(timeout)
const resultFile = join(root, 'result.json'), traceFile = join(root, 'stage.json')
const report = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : { ...(existsSync(traceFile) ? JSON.parse(readFileSync(traceFile, 'utf8')) : {}), passed: false, errors: ['原生诊断退出前未生成最终报告'] }
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const end = Date.now() + 5000; while (report.ownedPids?.some(alive) && Date.now() < end) await new Promise(done => setTimeout(done, 100))
report.cleanup = { remainingPids: report.ownedPids?.filter(alive) ?? [] }; report.exitCode = code; report.passed = report.passed && code === 0 && report.cleanup.remainingPids.length === 0
writeFileSync(resultFile, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ root, result: resultFile, passed: report.passed, failedStage: report.failedStage, errors: report.errors, cleanup: report.cleanup }))
if (!report.passed) process.exitCode = 1
