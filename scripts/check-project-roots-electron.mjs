/** 真实产品换根与文件树验证；独立资料、正常 main/preload/Host，不注入业务 store。 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import electron from 'electron'
const root = mkdtempSync(join(tmpdir(), 'cogent-root-product-')), home = join(root, 'home')
const evidence = resolve('tmp/project-roots-electron'), projectId = randomUUID(), sessionId = randomUUID()
for (const dir of [home, evidence, join(home, 'projects'), join(home, 'sessions'), join(root, 'A'), join(root, 'B')]) mkdirSync(dir, { recursive: true })
for (const name of ['A', 'B']) writeFileSync(join(root, name, `only-${name}.txt`), `CURRENT_ROOT_${name}`)
writeFileSync(join(home, 'settings.json'), JSON.stringify({ version: 1, closeBehavior: 'quit', soundEnabled: false, toastEnabled: false }))
writeFileSync(join(home, 'projects', `${projectId}.json`), JSON.stringify({ version: 2, summary: { id: projectId, name: '换根产品回归', cwds: [join(root, 'A')], createdAt: 1 } }))
writeFileSync(join(home, 'sessions', `${sessionId}.json`), JSON.stringify({ version: 1, piCwd: join(root, 'A'), summary: { id: sessionId, projectId, title: '换根产品聊天', createdAt: 1, updatedAt: 1 }, transcript: [] }))

async function driver(config) {
  const { app } = await import('electron')
  const { writeFileSync } = await import('node:fs')
  app.setPath('userData', config.profile)
  app.on('browser-window-created', (_event, win) => { win.show = () => {} })
  const report = { passed: false, checks: [], errors: [] }
  const wait = async (test, label) => {
    const end = Date.now() + 15000
    while (Date.now() < end) { if (await test()) { report.checks.push(label); return } await new Promise(done => setTimeout(done, 25)) }
    throw new Error('超时：' + label)
  }
  let win
  try {
    const created = new Promise(done => app.once('browser-window-created', (_event, window) => done(window)))
    await import(config.main); win = await created
    const evaluate = text => win.webContents.executeJavaScript(text)
    const previewBody = '(() => { const panel = document.querySelector("[data-file-preview]"); return (panel?.textContent ?? "") + Array.from(panel?.querySelectorAll("diffs-container") ?? []).flatMap(node => Array.from(node.shadowRoot?.querySelectorAll("[data-line]") ?? [], line => line.textContent ?? "")).join("") })()'
    await wait(() => evaluate('Array.from(document.querySelectorAll("button")).some(button => button.textContent === "换根产品聊天")'), '侧栏恢复真实会话')
    await evaluate('Array.from(document.querySelectorAll("button")).find(button => button.textContent === "换根产品聊天").click()')
    await wait(() => evaluate(`document.querySelector('[data-chat-session]')?.dataset.chatSession === ${JSON.stringify(config.sessionId)}`), '打开真实会话')
    await evaluate('document.querySelector("[aria-label=展开标签页区]").click()')
    await wait(() => evaluate('!!document.querySelector("[aria-label=打开文件导航]")'), '工作区展开')
    await evaluate('document.querySelector("[aria-label=打开文件导航]").click()')
    await wait(() => evaluate('document.querySelector("[data-file-navigator]")?.textContent.includes("only-A.txt")'), '初始文件树读取 A')
    await evaluate(`window.cogent.engineRequest('project.update', { projectId: ${JSON.stringify(config.projectId)}, name: '换根产品回归', cwds: [${JSON.stringify(config.next)}] })`)
    await wait(() => evaluate('(() => { const tree = document.querySelector("[data-file-navigator]"); return tree?.textContent.includes("only-B.txt") && !tree.textContent.includes("only-A.txt") })()'), '项目事件使文件树切到 B，旧 A 不残留')
    await evaluate('Array.from(document.querySelectorAll("[role=treeitem]")).find(row => row.textContent.includes("only-B.txt")).click()')
    await wait(() => evaluate(previewBody + '.includes("CURRENT_ROOT_B")'), '新根文件经实际 lease 读取并呈现')
    writeFileSync(config.screenshot, (await win.webContents.capturePage()).toPNG())
    await evaluate(`window.cogent.engineRequest('project.update', { projectId: ${JSON.stringify(config.projectId)}, name: '返回 A', cwds: [${JSON.stringify(config.previous)}] })`)
    await wait(() => evaluate('(() => { const tree = document.querySelector("[data-file-navigator]"); return tree?.textContent.includes("only-A.txt") && !tree.textContent.includes("only-B.txt") })()'), '再次换根更新文件树')
    await wait(() => evaluate(previewBody + '.includes("CURRENT_ROOT_B")'), '已打开文件独立 lease 保持原来源')
    await evaluate(`window.cogent.engineRequest('project.delete', { projectId: ${JSON.stringify(config.projectId)} })`)
    await wait(() => evaluate('document.querySelector("[data-file-navigator]")?.textContent.includes("当前目录为空")'), '项目移除后文件树清空，无失效项目错误')
    report.passed = true
  } catch (error) {
    report.errors.push(String(error.stack || error))
    if (win && !win.isDestroyed()) {
      report.dom = await win.webContents.executeJavaScript('document.querySelector("[data-file-workspace]")?.textContent')
      writeFileSync(config.screenshot, (await win.webContents.capturePage()).toPNG())
    }
  }
  finally { writeFileSync(config.result, JSON.stringify(report, null, 2)); app.quit() }
}
const result = join(evidence, 'result.json'), entry = join(root, 'driver.mjs')
rmSync(result, { force: true })
writeFileSync(entry, `(${driver.toString()})(${JSON.stringify({ main: pathToFileURL(resolve('out/main/index.js')).href, profile: join(root, 'profile'), result, screenshot: join(evidence, 'root-B.png'), previous: join(root, 'A'), next: join(root, 'B'), projectId, sessionId })});`)
const env = { ...process.env, COGENT_HOME: home, USERPROFILE: home, HOME: home, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
const child = spawn(electron, [entry], { env, stdio: 'inherit', windowsHide: true })
const deadline = setTimeout(() => {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  else child.kill('SIGKILL')
}, 60000)
try {
  const code = await new Promise((done, reject) => { child.once('close', done); child.once('error', reject) })
  const report = existsSync(result) ? JSON.parse(readFileSync(result, 'utf8')) : { passed: false, errors: ['未生成结果'] }
  console.log(JSON.stringify(report, null, 2))
  if (code !== 0 || !report.passed) process.exitCode = 1
} finally {
  clearTimeout(deadline)
  if (!root.startsWith(join(tmpdir(), 'cogent-root-product-'))) throw new Error('临时目录边界错误')
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
