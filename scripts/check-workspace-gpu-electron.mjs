/** 独立启动产品后核实GPU就绪状态；只报告真实能力，不用启动早期的缺省状态代替整段渲染。 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import electron from 'electron'

const evidence = resolve('tmp/workspace-gpu-ready')
mkdirSync(evidence, { recursive: true })
const root = mkdtempSync(join(evidence, 'attempt-')), home = join(root, 'home')
mkdirSync(home)
writeFileSync(join(home, 'settings.json'), JSON.stringify({ version: 1, closeBehavior: 'quit', soundEnabled: false, toastEnabled: false }))
const resultFile = join(root, 'result.json')
async function driver(config) {
  const childProcess = (await import('node:child_process')).default
  const children = new Set(), spawnChild = childProcess.spawn
  childProcess.spawn = (...args) => { const child = spawnChild(...args); if (child.pid) children.add(child.pid); return child }
  ;(await import('node:module')).syncBuiltinESMExports()
  app.setPath('userData', config.profile)
  const result = { scope: '产品真实首屏+gpu-info-update/complete信息就绪探针；不是性能重复采样', argv: process.argv, gpuEvents: [], errors: [], electron: process.versions.electron, chrome: process.versions.chrome }
  let win
  app.on('gpu-info-update', () => result.gpuEvents.push(performance.now()))
  const created = new Promise(done => app.once('browser-window-created', (_event, value) => done(value)))
  const deadline = async (promise, label) => {
    let timer
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' 超时')), 5000) })]) } finally { clearTimeout(timer) }
  }
  const snapshot = async stage => ({ stage, at: performance.now(), complete: await deadline(app.getGPUInfo('complete'), '完整GPU信息'), features: app.getGPUFeatureStatus(), hardwareAccelerationEnabled: app.isHardwareAccelerationEnabled(), gpuEventCount: result.gpuEvents.length })
  try {
    await import(config.main)
    win = await created; win.show(); win.focus()
    result.atWindowCreation = app.getGPUFeatureStatus()
    const end = Date.now() + 15000
    while (Date.now() < end) {
      if (await win.webContents.executeJavaScript('!!document.querySelector("[data-home-split]")&&typeof window.cogent==="object"')) break
      await new Promise(done => setTimeout(done, 20))
    }
    if (!await win.webContents.executeJavaScript('!!document.querySelector("[data-home-split]")')) throw new Error('产品首屏未就绪')
    await win.capturePage()
    const gpuDeadline = Date.now() + 2000
    while (result.gpuEvents.length === 0 && Date.now() < gpuDeadline) await new Promise(done => setTimeout(done, 20))
    result.afterFirstScreen = await snapshot('真实首屏已呈现')
    await win.webContents.executeJavaScript('new Promise(resolve=>{let count=0;const frame=()=>{if(++count===30)resolve();else requestAnimationFrame(frame)};requestAnimationFrame(frame)})')
    result.atCompletion = await snapshot('结束前')
    result.display = screen.getDisplayMatching(win.getBounds())
    result.metrics = app.getAppMetrics()
    result.passed = true
  } catch (error) { result.passed = false; result.errors.push(String(error.stack || error)) }
  finally {
    result.ownedPids = [...new Set([...children, ...app.getAppMetrics().map(item => item.pid)])]
    writeFileSync(config.result, JSON.stringify(result, null, 2))
    app.quit(); setTimeout(() => app.exit(2), 7000).unref()
  }
}
const driverFile = join(root, 'driver.mjs')
writeFileSync(driverFile, 'import {app,screen} from "electron";import {writeFileSync} from "node:fs";(' + driver.toString() + ')(' + JSON.stringify({ profile: join(root, 'profile'), main: pathToFileURL(resolve('out/main/index.js')).href, result: resultFile }) + ');')
const env = { ...process.env, COGENT_HOME: home, USERPROFILE: home, HOME: home }
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
const child = spawn(electron, [driverFile], { env, stdio: 'inherit', windowsHide: true })
const timeout = setTimeout(() => { if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); else child.kill() }, 25000)
const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done) }); clearTimeout(timeout)
const report = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : { passed: false, errors: ['探针未写结果'], ownedPids: [] }
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const end = Date.now() + 5000
while (report.ownedPids.some(alive) && Date.now() < end) await new Promise(done => setTimeout(done, 100))
report.cleanup = { remainingPids: report.ownedPids.filter(alive) }
report.passed &&= code === 0 && report.cleanup.remainingPids.length === 0
writeFileSync(resultFile, JSON.stringify(report, null, 2))
console.log(JSON.stringify({ passed: report.passed, afterFirstScreen: report.afterFirstScreen?.features, atCompletion: report.atCompletion?.features, errors: report.errors, result: resultFile }))
if (!report.passed) process.exitCode = 1
