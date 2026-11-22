/** 同一真实SSE工作负载，对照收起工作区与两个文件+网页驻留时的输入/绘制；只访问隔离资料。 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir, cpus, totalmem, release } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import electron from 'electron'

const root = mkdtempSync(join(tmpdir(), 'cogent-workspace-stream-'))
const evidence = resolve(process.env.WORKSPACE_STREAM_EVIDENCE ?? 'tmp/workspace-stream-performance')
mkdirSync(evidence, { recursive: true })
const chunks = ('## 固定流式夹具\n\n持续更新 **Markdown** 与普通文本，测量对话输入和工作区共存。\n\n'.repeat(500)).match(/[\s\S]{1,24}/g)
const streams = new Set()
const server = createServer((request, response) => {
  if (request.method === 'GET') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><title>Performance fixture</title><input id="resident" value="preserved"><p>Static browser resource fixture.</p>'); return }
  let body = ''
  request.on('data', chunk => { body += chunk })
  request.on('end', () => {
    JSON.parse(body)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    let index = 0
    const frame = (delta, finish_reason = null) => ({ id: 'workspace-stream', object: 'chat.completion.chunk', created: 0, model: 'workspace-stream', choices: [{ index: 0, delta, finish_reason }] })
    response.write(`data: ${JSON.stringify(frame({ role: 'assistant' }))}\n\n`)
    const timer = setInterval(() => {
      if (index === chunks.length) { response.write(`data: ${JSON.stringify(frame({}, 'stop'))}\n\ndata: [DONE]\n\n`); response.end(); return }
      response.write(`data: ${JSON.stringify(frame({ content: chunks[index++] }))}\n\n`)
    }, 30)
    streams.add(response)
    response.once('close', () => { clearInterval(timer); streams.delete(response) })
  })
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const url = 'http://127.0.0.1:' + server.address().port

async function driver(config) {
  const childProcess = (await import('node:child_process')).default
  const ownChildren = new Set(), spawnChild = childProcess.spawn
  childProcess.spawn = (...args) => { const child = spawnChild(...args); if (child.pid) ownChildren.add(child.pid); return child }
  ;(await import('node:module')).syncBuiltinESMExports()
  app.setPath('userData', config.profile)
  app.setPath('downloads', config.downloads)
  app.commandLine.appendSwitch('force-device-scale-factor', '1')
  const created = new Promise(done => app.once('browser-window-created', (_event, value) => done(value)))
  const result = { mode: config.mode, label: config.label, errors: [], checks: [], measurements: {}, electron: process.versions.electron, chrome: process.versions.chrome }
  let win
  const evaluate = source => win.webContents.executeJavaScript(source, true)
  const wait = async (test, label) => {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) { if (await test()) { result.checks.push(label); return } await new Promise(done => setTimeout(done, 20)) }
    throw new Error('超时 ' + label)
  }
  const click = async selector => {
    await wait(() => evaluate('(()=>{const el=document.querySelector(' + JSON.stringify(selector) + ');return !!el&&!el.disabled&&el.getBoundingClientRect().width>0})()'), '可点击 ' + selector)
    await evaluate('document.querySelector(' + JSON.stringify(selector) + ').scrollIntoView({behavior:"instant",block:"nearest",inline:"nearest"});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const point = await evaluate('(()=>{const el=document.querySelector(' + JSON.stringify(selector) + '),r=el.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);if(!el.contains(document.elementFromPoint(x,y)))throw new Error("输入目标被遮挡 "+' + JSON.stringify(selector) + ');return{x,y}})()')
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
    await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
  }
  try {
    await import(config.main)
    win = await created; win.setSize(1500, 900); win.show(); win.focus()
    if (config.diagnostic) {
      result.gpu = { features: app.getGPUFeatureStatus(), info: await app.getGPUInfo('basic') }
      result.display = screen.getDisplayMatching(win.getBounds())
      win.webContents.debugger.attach('1.3')
      await win.webContents.debugger.sendCommand('Performance.enable')
    }
    win.webContents.on('console-message', event => { if (event.level === 'error') result.errors.push(event.message) })
    await wait(() => evaluate('typeof window.cogent==="object"&&!!document.querySelector("[data-home-split]")'), '真实产品首页')
    await evaluate('(async()=>{await window.cogent.setCustomProviders([{id:"custom/workspace-stream",name:"流式性能夹具",baseUrl:' + JSON.stringify(config.url + '/v1') + ',models:[],modelDefs:[{id:"workspace-stream",reasoning:false,input:["text"],contextWindow:128000,maxTokens:4096}]}],[]);await window.cogent.setApiKey("custom/workspace-stream","isolated-stream");await window.cogent.saveSettings({activeProviderId:"custom/workspace-stream",activeModelId:"workspace-stream",thinkingLevel:"off",closeBehavior:"quit"});await window.cogent.engineRequest("session.create",{title:"流式性能夹具",cwd:' + JSON.stringify(config.workspace) + '})})()')
    const loaded = new Promise(done => win.webContents.once('did-finish-load', done)); win.reload(); await loaded
    await wait(() => evaluate('document.querySelector("[data-chat-session] textarea")?.disabled===false&&document.body.textContent.includes("workspace-stream")'), '模型与聊天输入水合')
    if (config.mode === 'workspace') {
      await click('[aria-label=展开标签页区]')
      await click('[aria-label=打开文件导航]')
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [config.alpha, config.beta] })
      await evaluate('Array.from(document.querySelectorAll("[data-file-navigator] button")).find(el=>el.textContent.trim()==="打开文件").click()')
      await wait(() => evaluate('["关闭 alpha.txt","关闭 beta.txt"].every(label=>Array.from(document.querySelectorAll("button")).some(el=>el.getAttribute("aria-label")===label))'), '真实文件标签已打开')
      await evaluate('Array.from(document.querySelectorAll("[aria-label=工作区标签页] [role=tab]")).find(el=>el.textContent.trim()==="alpha.txt").click()')
      await wait(() => evaluate('document.querySelector("[data-workspace-panel]:not([hidden]) [data-code-preview] diffs-container")?.shadowRoot?.textContent.includes("ALPHA")'), '首个文件预热')
      await evaluate('Array.from(document.querySelectorAll("[aria-label=工作区标签页] [role=tab]")).find(el=>el.textContent.trim()==="beta.txt").click()')
      await wait(() => evaluate('Array.from(document.querySelectorAll("[data-file-preview] diffs-container")).filter(el=>el.shadowRoot?.querySelector("[data-line]")).length===2'), '两个真实文件查看器驻留')
      await click('[aria-label=新建标签页]'); await click('[aria-label=打开内置浏览器]')
      await wait(() => evaluate('document.querySelector("[aria-label=网页地址或搜索]")?.disabled===false'), '网页准备完成')
      await click('[aria-label=网页地址或搜索]'); await win.webContents.insertText(config.url + '/fixture')
      await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
      await wait(() => Promise.resolve(webContents.getAllWebContents().some(contents => contents.getType() === 'webview' && contents.getURL() === config.url + '/fixture')), '真实静态网页驻留')
    }
    win.show(); win.focus()
    result.idleFrames = await evaluate('new Promise(resolve=>{const frames=[];let previous=performance.now();const frame=now=>{frames.push(now-previous);previous=now;if(frames.length===90)resolve(frames);else requestAnimationFrame(frame)};requestAnimationFrame(frame)})')
    await click('[data-chat-session] textarea'); await win.webContents.insertText('使用固定流式夹具回答。')
    await click('[aria-label=发送]')
    await wait(() => evaluate('!!document.querySelector("[aria-label=停止]")&&!!document.querySelector("[data-md-streaming=true]")'), '真实Host模型SSE已进入流式渲染')
    win.show(); win.focus()
    await wait(() => Promise.resolve(win.isFocused() && win.isVisible() && !win.isMinimized()), '流式采样窗口实际前台')
    if (config.diagnostic) {
      result.gpuAtMeasurement = { features: app.getGPUFeatureStatus(), info: await app.getGPUInfo('basic') }
      result.performanceStart = await win.webContents.debugger.sendCommand('Performance.getMetrics')
    }
    await evaluate('(()=>{const input=document.querySelector("[data-chat-session] textarea");input.focus();window.workspaceStreamFrames=[];window.workspaceStreamTimeline=[];window.workspaceStreamLongTasks=[];window.workspaceStreamMeasuring=true;let previous=performance.now();const frame=now=>{if(!window.workspaceStreamMeasuring)return;const interval=now-previous;window.workspaceStreamFrames.push(interval);window.workspaceStreamTimeline.push({at:now,interval,kind:document.querySelector("[data-workspace-panel]:not([hidden])")?.dataset.tabKind??"collapsed",visibility:document.visibilityState});previous=now;requestAnimationFrame(frame)};requestAnimationFrame(frame);window.workspaceStreamObserver=new PerformanceObserver(list=>{for(const entry of list.getEntries())window.workspaceStreamLongTasks.push({start:entry.startTime,duration:entry.duration})});window.workspaceStreamObserver.observe({type:"longtask",buffered:false});})();undefined')
    const samples = []
    result.inputContext = []
    for (let index = 0; index < 120; index++) {
      if (config.mode === 'workspace' && index % 10 === 0) {
        await evaluate('(()=>{const names=["alpha.txt","beta.txt","Performance fixture"],name=names[' + Math.floor(index / 10) % 3 + '];Array.from(document.querySelectorAll("[aria-label=工作区标签页] [role=tab]")).find(el=>el.textContent.trim()===name).click()})();undefined')
        await evaluate('document.querySelector("[data-chat-session] textarea").focus();undefined')
      }
      const before = { focused: win.isFocused(), visible: win.isVisible(), minimized: win.isMinimized(), visibility: await evaluate('document.visibilityState') }
      await evaluate('(()=>{const input=document.querySelector("[data-chat-session] textarea"),start=performance.now();window.workspaceStreamInput=new Promise(resolve=>input.addEventListener("input",()=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()-start))),{once:true}));})();undefined')
      win.webContents.sendInputEvent({ type: 'char', keyCode: String.fromCharCode(97 + index % 26) })
      samples.push(await evaluate('window.workspaceStreamInput'))
      result.inputContext.push({ index, before, after: { focused: win.isFocused(), visible: win.isVisible(), minimized: win.isMinimized(), visibility: await evaluate('document.visibilityState') } })
    }
    result.measurements = await evaluate('window.workspaceStreamMeasuring=false;window.workspaceStreamObserver.disconnect();({frames:window.workspaceStreamFrames,timeline:window.workspaceStreamTimeline,longTasks:window.workspaceStreamLongTasks,streaming:!!document.querySelector("[aria-label=停止]"),text:document.querySelector("[data-chat-session] textarea").value.length,dpr:devicePixelRatio})')
    if (config.diagnostic) {
      result.performanceEnd = await win.webContents.debugger.sendCommand('Performance.getMetrics')
      result.gpuAtCompletion = { features: app.getGPUFeatureStatus(), info: await app.getGPUInfo('basic') }
      const before = new Map(result.performanceStart.metrics.map(item => [item.name, item.value]))
      result.performanceDelta = Object.fromEntries(result.performanceEnd.metrics.map(item => [item.name, item.value - before.get(item.name)]))
      win.webContents.debugger.detach()
    }
    result.measurements.inputMs = samples
    result.measurements.guests = webContents.getAllWebContents().filter(contents => contents.getType() === 'webview').length
    if (!result.measurements.streaming || result.measurements.text !== 120) throw new Error('采样期间流式提前结束或真实输入丢失')
    await click('[aria-label=停止]')
    await wait(() => evaluate('!document.querySelector("[aria-label=停止]")'), '停止受控流式')
    result.passed = result.errors.length === 0
  } catch (error) {
    result.passed = false; result.errors.push(String(error.stack || error))
    if (win && !win.isDestroyed()) writeFileSync(config.screenshot, (await win.capturePage()).toPNG())
  } finally {
    result.ownedPids = [...new Set([...ownChildren, ...app.getAppMetrics().map(item => item.pid)])]
    writeFileSync(config.result, JSON.stringify(result, null, 2))
    app.quit(); setTimeout(() => app.exit(2), 7000).unref()
  }
}

const summary = values => {
  const sorted = [...values].sort((a, b) => a - b)
  return { samples: values, p50: sorted[Math.floor(sorted.length * 0.5)], p95: sorted[Math.floor(sorted.length * 0.95)], max: sorted.at(-1) }
}
const report = { purpose: process.env.WORKSPACE_STREAM_DIAGNOSTIC === '1' ? '仅一对有界节拍/CPU定位，不能替代正式三对采样；保留相同性能判据' : '预热一对、正式三对真实产品流式性能对照', machine: { os: release(), cpu: cpus()[0].model, logicalCpus: cpus().length, totalMemoryMiB: Math.round(totalmem() / 1024 ** 2) }, workload: { chunkCharacters: 24, intervalMs: 30, inputEvents: 120, text: '固定Markdown段落；相同Host/SSE请求链。工作区场景额外每10次输入切换预热标签。' }, limits: { inputP95Ms: 100, frameP95Ratio: 1.2, longTaskRatio: 1.2 }, runs: [], comparisons: [], passed: true }
let child
try {
  for (const label of process.env.WORKSPACE_STREAM_DIAGNOSTIC === '1' ? ['diagnostic'] : ['warmup', 'sample-1', 'sample-2', 'sample-3']) {
    const pair = {}
    for (const mode of ['baseline', 'workspace']) {
      const runRoot = join(root, label + '-' + mode), home = join(runRoot, 'home'), workspace = join(runRoot, 'workspace'), downloads = join(runRoot, 'downloads')
      for (const folder of [home, workspace, downloads]) mkdirSync(folder, { recursive: true })
      writeFileSync(join(home, 'settings.json'), JSON.stringify({ version: 1, closeBehavior: 'quit', soundEnabled: false, toastEnabled: false }))
      const alpha = join(workspace, 'alpha.txt'), beta = join(workspace, 'beta.txt')
      writeFileSync(alpha, 'ALPHA reading\n'.repeat(1500)); writeFileSync(beta, 'BETA reading\n'.repeat(1500))
      const resultFile = join(evidence, label + '-' + mode + '.json')
      const config = { mode, label, diagnostic: process.env.WORKSPACE_STREAM_DIAGNOSTIC === '1', profile: join(runRoot, 'profile'), downloads, workspace, alpha, beta, url, main: pathToFileURL(resolve('out/main/index.js')).href, result: resultFile, screenshot: join(evidence, label + '-' + mode + '.png') }
      const driverPath = join(runRoot, 'driver.mjs')
      writeFileSync(driverPath, 'import {app,BrowserWindow,dialog,webContents,screen} from "electron";import {writeFileSync} from "node:fs";(' + driver.toString() + ')(' + JSON.stringify(config) + ');')
      const env = { ...process.env, COGENT_HOME: home, USERPROFILE: home, HOME: home }
      delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
      child = spawn(electron, [driverPath], { env, stdio: 'inherit', windowsHide: true })
      const timeout = setTimeout(() => { if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); else child.kill() }, 60000)
      const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done) }); clearTimeout(timeout)
      const result = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : { passed: false, errors: ['未写结果'], ownedPids: [] }
      const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
      const end = Date.now() + 5000
      while (result.ownedPids.some(alive) && Date.now() < end) await new Promise(done => setTimeout(done, 100))
      result.cleanup = { remainingPids: result.ownedPids.filter(alive) }
      result.passed &&= code === 0 && result.cleanup.remainingPids.length === 0
      if (result.measurements.inputMs) { result.input = summary(result.measurements.inputMs); result.frames = summary(result.measurements.frames); result.idle = summary(result.idleFrames); result.longTasksTotalMs = result.measurements.longTasks.reduce((sum, task) => sum + task.duration, 0) }
      report.runs.push(result); pair[mode] = result
      writeFileSync(resultFile, JSON.stringify(result, null, 2)); writeFileSync(join(evidence, 'result.json'), JSON.stringify(report, null, 2))
      console.log(JSON.stringify({ label, mode, passed: result.passed, inputP95: result.input?.p95, frameP95: result.frames?.p95, longTasksMs: result.longTasksTotalMs, errors: result.errors }))
      if (!result.passed) throw new Error('流式性能场景失败 ' + label + ' ' + mode)
    }
    const frameRatio = pair.workspace.frames.p95 / pair.baseline.frames.p95
    const longTasksPass = pair.workspace.longTasksTotalMs <= pair.baseline.longTasksTotalMs * report.limits.longTaskRatio
    const passed = pair.workspace.input.p95 <= report.limits.inputP95Ms && frameRatio <= report.limits.frameP95Ratio && longTasksPass
    report.comparisons.push({ label, measured: label !== 'warmup' && label !== 'diagnostic', diagnostic: label === 'diagnostic', frameRatio, longTasksPass, passed })
    if (label !== 'warmup' && !passed) report.passed = false
  }
} catch (error) { report.passed = false; report.error = String(error.stack || error) }
finally {
  if (child && child.exitCode === null) { if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); else child.kill() }
  for (const response of streams) response.destroy()
  server.closeAllConnections(); await new Promise(done => server.close(done))
  writeFileSync(join(evidence, 'result.json'), JSON.stringify(report, null, 2))
  if (!root.startsWith(join(tmpdir(), 'cogent-workspace-stream-'))) throw new Error('临时目录边界错误')
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
console.log(JSON.stringify({ passed: report.passed, comparisons: report.comparisons, result: join(evidence, 'result.json') }))
if (!report.passed) process.exitCode = 1
