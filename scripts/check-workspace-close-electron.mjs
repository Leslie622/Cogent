/** 标签不落盘；真实主renderer崩溃后仍可正常退出，不等待保存ACK或显示未保存提示。 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import electron from 'electron'

const root = mkdtempSync(join(tmpdir(), 'cogent-workspace-close-'))
const home = join(root, 'home'), evidence = resolve('tmp/workspace-close-electron')
mkdirSync(home); mkdirSync(evidence, { recursive: true })
writeFileSync(join(home, 'settings.json'), JSON.stringify({ version: 1, closeBehavior: 'quit', soundEnabled: false, toastEnabled: false }))

async function driver(config) {
  const { app, dialog } = await import('electron')
  const { writeFileSync } = await import('node:fs')
  const childProcess = (await import('node:child_process')).default
  const children = new Set([process.pid]), originalSpawn = childProcess.spawn
  childProcess.spawn = (...args) => { const child = originalSpawn(...args); if (child.pid) children.add(child.pid); return child }
  ;(await import('node:module')).syncBuiltinESMExports()
  app.setPath('userData', config.profile)
  const report = { checks: [], questions: [], errors: [], passed: false }
  const save = () => {
    for (const metric of app.getAppMetrics()) children.add(metric.pid)
    report.ownedPids = [...children]
    writeFileSync(config.result, JSON.stringify(report, null, 2))
  }
  let win
  dialog.showMessageBox = async (_window, options) => { report.questions.push(options); return { response: 2, checkboxChecked: false } }
  const wait = async (test, label) => {
    const end = Date.now() + 15000
    while (Date.now() < end) { if (await test()) { report.checks.push(label); return } await new Promise(done => setTimeout(done, 20)) }
    throw new Error('超时 ' + label)
  }
  app.once('will-quit', () => { report.windowDestroyed = win?.isDestroyed(); save() })
  process.on('uncaughtException', error => { report.errors.push(String(error.stack || error)); save(); app.exit(1) })
  try {
    const created = new Promise(done => app.once('browser-window-created', (_event, window) => done(window)))
    await import(config.main)
    win = await created
    await wait(() => win.webContents.executeJavaScript('!!document.querySelector("[data-home-split]")'), '实际main/preload/renderer启动')
    for (const metric of app.getAppMetrics()) children.add(metric.pid)
    const crashed = new Promise(done => win.webContents.once('render-process-gone', (_event, details) => { report.crash = details.reason; done() }))
    win.webContents.forcefullyCrashRenderer()
    await crashed
    report.checks.push('真实主renderer崩溃，main与Host仍存活')
    report.checks.push('工作区不保存，崩溃后的关闭不需要renderer保存确认')
    report.passed = true
    save()
    win.close()
    setTimeout(() => { report.passed = false; report.errors.push('关闭后仍未退出'); save(); app.exit(2) }, 7000).unref()
  } catch (error) { report.errors.push(String(error.stack || error)); save(); app.exit(1) }
}

const resultFile = join(evidence, 'result.json'), driverFile = join(root, 'driver.mjs')
const config = { profile: join(root, 'profile'), main: pathToFileURL(resolve('out/main/index.js')).href, result: resultFile }
writeFileSync(driverFile, '(' + driver.toString() + ')(' + JSON.stringify(config) + ');')
const env = { ...process.env, COGENT_HOME: home, USERPROFILE: home, HOME: home }
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
let child
try {
  child = spawn(electron, [driverFile], { env, stdio: 'inherit', windowsHide: true })
  const timeout = setTimeout(() => spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }), 25000)
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done) }); clearTimeout(timeout)
  const report = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : { passed: false, errors: ['没有结果文件'], ownedPids: [] }
  const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
  const end = Date.now() + 5000
  while (report.ownedPids.some(alive) && Date.now() < end) await new Promise(done => setTimeout(done, 100))
  report.cleanup = { remainingPids: report.ownedPids.filter(alive), exitCode: code }
  report.passed &&= code === 0 && report.windowDestroyed === true && report.questions.length === 0 && report.cleanup.remainingPids.length === 0
  writeFileSync(resultFile, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  if (!report.passed) process.exitCode = 1
} finally {
  if (child && child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  if (!root.startsWith(join(tmpdir(), 'cogent-workspace-close-'))) throw new Error('临时目录边界错误')
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
