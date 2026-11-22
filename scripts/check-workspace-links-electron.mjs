/** 新入口的真产品回归；只替代原生目录选择器，不用 store 注入标签或伪造文件来源。 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import electron from 'electron'

for (const entry of ['out/main/index.js', 'out/renderer/index.html']) {
  if (!existsSync(resolve(entry))) throw new Error('完整产品构建缺失：' + entry + '；先 npm run build')
}
const root = mkdtempSync(join(tmpdir(), 'cogent-workspace-links-'))
const home = join(root, 'home'), workspace = join(root, 'workspace')
const evidence = resolve(process.env.WORKSPACE_LINKS_EVIDENCE ?? 'tmp/workspace-links-electron')
for (const directory of [home, workspace, join(workspace, 'site/pages'), join(workspace, 'site/assets'), evidence]) mkdirSync(directory, { recursive: true })
writeFileSync(join(home, 'settings.json'), JSON.stringify({ version: 1, closeBehavior: 'quit', soundEnabled: false, toastEnabled: false }))
writeFileSync(join(workspace, 'readme.md'), '# Markdown parent fixture\n\n[打开子HTML](./child.html)\n')
writeFileSync(join(workspace, 'child.html'), '<!doctype html><title>Relative child fixture</title><h1 id="child-ready">Relative child opened after parent close</h1>')
writeFileSync(join(workspace, 'site/pages/index.html'), '<!doctype html><title>Expanded root fixture</title><link rel="stylesheet" href="../assets/site.css"><h1 id="root-ready">Resources pending</h1><img id="root-image" src="../assets/pixel.svg"><script src="../assets/site.js"></script>')
writeFileSync(join(workspace, 'site/assets/site.css'), '#root-ready { color: rgb(10, 112, 51) }')
writeFileSync(join(workspace, 'site/assets/site.js'), 'window.expandedRootReady=true;document.querySelector("#root-ready").textContent="Expanded directory resources loaded"')
writeFileSync(join(workspace, 'site/assets/pixel.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="green"/></svg>')
writeFileSync(join(workspace, 'delivery.html'), '<!doctype html><title>Frozen delivery fixture</title><h1 id="delivery-ready">Frozen delivered HTML</h1>')

let responseMarkdown = ''
const actions = [
  { tool: 'read', args: { path: 'readme.md' } },
  { tool: 'report_outputs', args: { deliverables: [{ path: 'delivery.html', note: '交付HTML预览夹具' }] } },
  { text: true }
]
const modelRequests = []
const server = createServer((request, response) => {
  if (request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><title>External link fixture</title><h1 id="external-ready">Explicit internal browser link</h1>')
    return
  }
  request.resume()
  request.on('end', () => {
    const action = actions.shift()
    if (action === undefined) { response.writeHead(500); response.end('未计划的模型请求'); return }
    modelRequests.push(action.tool ?? 'answer')
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const frame = (delta, finish_reason) => ({ id: 'workspace-links-test', object: 'chat.completion.chunk', created: 0, model: 'workspace-links-test', choices: [{ index: 0, delta, finish_reason }] })
    if (action.tool !== undefined) {
      response.write(`data: ${JSON.stringify(frame({ role: 'assistant', tool_calls: [{ index: 0, id: 'link-call-' + modelRequests.length, type: 'function', function: { name: action.tool, arguments: JSON.stringify(action.args) } }] }, null))}\n\n`)
      response.write(`data: ${JSON.stringify(frame({}, 'tool_calls'))}\n\n`)
    } else {
      response.write(`data: ${JSON.stringify(frame({ role: 'assistant', content: responseMarkdown }, null))}\n\n`)
      response.write(`data: ${JSON.stringify({ ...frame({}, 'stop'), usage: { prompt_tokens: 10, completion_tokens: 40, total_tokens: 50 } })}\n\n`)
    }
    response.end('data: [DONE]\n\n')
  })
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const endpoint = 'http://127.0.0.1:' + server.address().port
responseMarkdown = `[外部网页](${endpoint}/linked)\n\n[Markdown父页](./readme.md)\n\n[目录资源网页](./site/pages/index.html)\n\n交付文件已保存。`

async function driver(config) {
  const { app, dialog, webContents, shell } = await import('electron')
  const { writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const childProcess = (await import('node:child_process')).default
  const ownedChildren = new Set([process.pid])
  const savePids = () => writeFileSync(join(config.evidence, 'owned-pids.json'), JSON.stringify([...ownedChildren]))
  savePids()
  const spawnChild = childProcess.spawn
  childProcess.spawn = (...args) => {
    const child = spawnChild(...args)
    if (child.pid) { ownedChildren.add(child.pid); savePids() }
    return child
  }
  ;(await import('node:module')).syncBuiltinESMExports()
  app.setPath('userData', config.profile)
  const created = new Promise(done => app.once('browser-window-created', (_event, window) => done(window)))
  const checks = [], errors = [], nativePickers = [], externalOpened = []
  const originalExternal = shell.openExternal
  shell.openExternal = async value => { externalOpened.push(value) }
  dialog.showOpenDialog = async (_window, options) => {
    if (options.title !== '选择HTML资源目录' || !options.properties.includes('openDirectory')) throw new Error('非预期原生选择器：' + JSON.stringify(options))
    nativePickers.push({ title: options.title, properties: options.properties, selected: config.resourceRoot })
    return { canceled: false, filePaths: [config.resourceRoot] }
  }
  let win, stage = '启动', passed = false, failure
  const evaluate = source => win.webContents.executeJavaScript(source, true)
  const wait = async (condition, label) => {
    const end = Date.now() + 30000
    while (Date.now() < end) {
      if (await condition()) { checks.push(label); console.log('[验收] ' + label); return }
      await new Promise(done => setTimeout(done, 40))
    }
    throw new Error('超时：' + label)
  }
  const settle = () => evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
  const click = async (selector, button = 'left') => {
    await wait(() => evaluate('(()=>{const el=document.querySelector(' + JSON.stringify(selector) + ');return !!el&&!el.disabled&&el.getAttribute("aria-disabled")!=="true"&&el.getBoundingClientRect().width>0})()'), '控件可点击 ' + selector)
    const point = await evaluate('(()=>{const el=document.querySelector(' + JSON.stringify(selector) + ');el.scrollIntoView({block:"center",inline:"nearest"});const r=el.getBoundingClientRect();const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);const hit=document.elementFromPoint(x,y);if(hit!==el&&!el.contains(hit))throw new Error("点击被遮挡："+' + JSON.stringify(selector) + ');return {x,y}})()')
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    win.webContents.sendInputEvent({ type: 'mouseDown', button, clickCount: 1, ...point })
    win.webContents.sendInputEvent({ type: 'mouseUp', button, clickCount: 1, ...point })
    await settle()
  }
  const clickText = async (text, selector) => {
    await wait(() => evaluate('Array.from(document.querySelectorAll(' + JSON.stringify(selector) + ')).some(el=>el.textContent.trim()===' + JSON.stringify(text) + ')'), '显示入口 ' + text)
    await evaluate('(()=>{document.querySelector("[data-links-target]")?.removeAttribute("data-links-target");const el=Array.from(document.querySelectorAll(' + JSON.stringify(selector) + ')).find(el=>el.textContent.trim()===' + JSON.stringify(text) + ');el.setAttribute("data-links-target","")})()')
    await click('[data-links-target]')
    await evaluate('document.querySelector("[data-links-target]")?.removeAttribute("data-links-target")')
  }
  const escape = async () => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await settle()
  }
  const activePanel = '[data-workspace-panel]:not([hidden])'
  const externalLink = '[data-chat-session] a[href=' + JSON.stringify(config.endpoint + '/linked') + ']'
  const snapshot = async name => { const image = await win.webContents.capturePage(); writeFileSync(join(config.evidence, name + '.png'), image.toPNG()) }
  const guestWith = async (selector, label) => {
    let found
    await wait(async () => {
      const candidates = webContents.getAllWebContents().filter(contents => contents.getType() === 'webview' && !contents.isDestroyed())
      for (const candidate of candidates) {
        if (await candidate.executeJavaScript('!!document.querySelector(' + JSON.stringify(selector) + ')')) { found = candidate; return true }
      }
      return false
    }, label)
    return found
  }
  const closeBrowser = async title => {
    await click('[aria-label=' + JSON.stringify('关闭 ' + title) + ']')
    await wait(() => Promise.resolve(webContents.getAllWebContents().every(contents => contents.getType() !== 'webview')), '关闭网页回收guest ' + title)
  }
  try {
    await import(config.main)
    win = await created
    win.setSize(1500, 900); win.show()
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
    await wait(() => evaluate('!!document.querySelector("[data-home-split]")&&typeof window.cogent==="object"'), '产品首页与preload就绪')
    await evaluate('(async()=>{await window.cogent.setCustomProviders([{id:"custom/workspace-links-test",name:"工作区链接验收模型",baseUrl:' + JSON.stringify(config.endpoint + '/v1') + ',models:[],modelDefs:[{id:"workspace-links-test",reasoning:false,input:["text"],contextWindow:128000,maxTokens:4096}]}],[]);await window.cogent.setApiKey("custom/workspace-links-test","isolated-links-key");await window.cogent.saveSettings({activeProviderId:"custom/workspace-links-test",activeModelId:"workspace-links-test",thinkingLevel:"off",closeBehavior:"quit"});await window.cogent.engineRequest("session.create",{title:"工作区链接验收",cwd:' + JSON.stringify(config.workspace) + ',permissionMode:"auto"})})()')
    const loaded = new Promise(done => win.webContents.once('did-finish-load', done))
    win.reload(); await loaded
    await wait(() => evaluate('Array.from(document.querySelectorAll("header")).some(el=>el.innerText.includes("工作区链接验收"))&&document.querySelector("[data-chat-session] textarea")?.disabled===false&&document.body.innerText.includes("workspace-links-test")'), '真实聊天与模型偏好水合')
    await click('[data-chat-session] textarea')
    await win.webContents.insertText('展示网页、本地Markdown与HTML，并交付HTML文件')
    await wait(() => evaluate('document.querySelector("[aria-label=发送]")?.disabled===false'), '实际发送按钮就绪')
    await click('[aria-label=发送]')
    await wait(() => evaluate('!!document.querySelector(' + JSON.stringify(externalLink) + ')&&!!document.querySelector(' + JSON.stringify('[data-output-card] [aria-label="打开 delivery.html"]') + ')&&!document.querySelector("[aria-label=停止]")'), '真实read与report_outputs形成正文链接和正式交付卡')

    stage = '正文HTTP右键入口'
    await click(externalLink, 'right')
    await clickText('内置浏览器打开', '[role=menuitem]')
    const external = await guestWith('#external-ready', '正文HTTP菜单打开真实内置网页')
    if (external.getURL() !== config.endpoint + '/linked' || externalOpened.length !== 0) throw new Error('内置入口错误地使用了系统浏览器或其他地址')
    checks.push('内置入口不调用系统浏览器，地址与正文一致')
    await snapshot('http-context-menu')
    await closeBrowser('External link fixture')

    stage = '父Markdown关闭后相对HTML预览'
    await clickText('Markdown父页', '[data-chat-session] [data-file-link]')
    await wait(() => evaluate('document.querySelector(' + JSON.stringify(activePanel + ' [data-file-preview]') + ')?.textContent.includes("Markdown parent fixture")'), '本地Markdown父页实际读取并渲染')
    await clickText('打开子HTML', activePanel + ' [data-file-link]')
    await wait(() => evaluate('document.querySelector("[data-file-toolbar] [aria-label=文件位置] [aria-current=page]")?.textContent==="child.html"&&!!document.querySelector(' + JSON.stringify(activePanel + ' [data-code-preview] diffs-container') + ')?.shadowRoot?.querySelector("[data-line]")'), 'Markdown相对child.html打开独立文件标签并实际渲染源码')
    await click('[aria-label="关闭 readme.md"]')
    await wait(() => evaluate('!document.querySelector(' + JSON.stringify('[aria-label="关闭 readme.md"]') + ')'), '父Markdown标签已关闭')
    await click('[data-file-toolbar] [aria-label=网页预览]')
    const child = await guestWith('#child-ready', '关闭父页后child.html仍能网页预览')
    if (!await child.executeJavaScript('document.querySelector("#child-ready").textContent==="Relative child opened after parent close"')) throw new Error('相对HTML来源或内容错误')
    await snapshot('html-after-parent-close')
    await closeBrowser('Relative child fixture')

    stage = '显式扩大本地HTML资源目录'
    await clickText('目录资源网页', '[data-chat-session] [data-file-link]')
    await wait(() => evaluate('document.querySelector("[data-file-toolbar] [aria-label=文件位置] [aria-current=page]")?.textContent==="index.html"&&!!document.querySelector(' + JSON.stringify(activePanel + ' [data-code-preview] diffs-container') + ')?.shadowRoot?.querySelector("[data-line]")'), '嵌套pages/index.html文件标签与实际源码就绪')
    await click('[data-file-toolbar] [aria-label=网页预览]')
    const resourceGuest = await guestWith('#root-ready', '默认目录内HTML主体可加载')
    const previousPreviewUrl = resourceGuest.getURL()
    await wait(() => Promise.resolve(!resourceGuest.isLoadingMainFrame()), '默认HTML载入完成')
    if (await resourceGuest.executeJavaScript('window.expandedRootReady===true')) throw new Error('未授权便加载了父级assets')
    checks.push('选择更大目录前不会加载目录外assets')
    const resourceGuestId = resourceGuest.id
    await click(activePanel + ' [aria-label=浏览器菜单]')
    await clickText('选择资源目录…', '[role=menuitem]')
    await wait(() => resourceGuest.executeJavaScript('window.expandedRootReady===true&&document.querySelector("#root-ready").textContent==="Expanded directory resources loaded"&&getComputedStyle(document.querySelector("#root-ready")).color==="rgb(10, 112, 51)"&&document.querySelector("#root-image").naturalWidth===2'), '选择父级site目录后../assets的JS、CSS与图片均真实加载')
    if (resourceGuest.id !== resourceGuestId || nativePickers.length !== 1) throw new Error('扩大资源目录重建了guest或没有调用一次可信原生选择器')
    checks.push('扩大资源目录保留原guest，授权只来自真实菜单触发的原生选择器')
    await wait(() => Promise.resolve(!resourceGuest.navigationHistory.getAllEntries().some(entry => entry.url === previousPreviewUrl)), '重新授权后原生历史移除旧预览入口')
    if (resourceGuest.navigationHistory.getAllEntries().filter(entry => entry.url.startsWith('cogent-preview:')).length !== 1) throw new Error('原生历史保留了已撤销的预览授权')
    await snapshot('html-selected-resource-root')
    await closeBrowser('Expanded root fixture')

    stage = '交付HTML禁止扩大目录'
    await click('[data-output-card] [aria-label="打开 delivery.html"]')
    await wait(() => evaluate('document.querySelector(' + JSON.stringify(activePanel + ' [data-file-preview]') + ')?.dataset.fileDelivery==="saved"&&document.querySelector("[data-file-toolbar] [aria-label=文件位置] [aria-current=page]")?.textContent==="delivery.html"'), '正式卡读取冻结HTML交付副本')
    await click('[data-file-toolbar] [aria-label=文件操作]')
    await clickText('文件信息', '[role=menuitem]')
    await wait(() => evaluate('(()=>{const dialog=document.querySelector("[role=dialog]");return !!dialog&&!!dialog.querySelector("p.break-all")?.textContent&&dialog.textContent.includes("文件信息")&&dialog.textContent.includes("delivery.html")&&dialog.textContent.includes("交付副本")})()'), '交付HTML文件信息显示路径和冻结版本')
    await click('[role=dialog] [data-slot=dialog-close]')
    await wait(() => evaluate('!document.querySelector("[role=dialog]")'), '关闭文件信息返回原文件')
    await click('[data-file-toolbar] [aria-label=网页预览]')
    await guestWith('#delivery-ready', '交付HTML通过受管预览加载冻结字节')
    await click(activePanel + ' [aria-label=浏览器菜单]')
    await wait(() => evaluate('!!document.querySelector("[role=menu]")'), '交付HTML浏览器菜单已打开')
    if (await evaluate('Array.from(document.querySelectorAll("[role=menuitem]")).some(el=>el.textContent.includes("选择资源目录"))')) throw new Error('交付HTML错误地提供扩大目录入口')
    if (nativePickers.length !== 1) throw new Error('交付HTML触发了额外原生目录授权')
    checks.push('交付HTML没有扩大资源目录入口，也未调用目录选择器')
    await snapshot('delivery-without-root-picker')
    await escape()
    await closeBrowser('Frozen delivery fixture')
    await click('[aria-label=标签页列表]')
    await clickText('关闭全部标签页', '[data-slot=popover-content] button')
    await wait(() => evaluate('document.querySelector("[data-workspace]")?.inert===true&&document.querySelectorAll("webview").length===0'), '全部关闭后工作区收起且无网页节点')
    passed = true
  } catch (error) {
    failure = { error: String(error), stack: error.stack }
    if (win && !win.isDestroyed()) await snapshot('failure').catch(() => {})
  } finally {
    shell.openExternal = originalExternal
    for (const metric of app.getAppMetrics()) ownedChildren.add(metric.pid)
    savePids()
    const result = { passed, stage, checks, errors, nativePickers, externalOpened, ...failure, ownedPids: [...ownedChildren], electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform }
    writeFileSync(join(config.evidence, 'result.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result, null, 2))
    app.quit()
    setTimeout(() => app.exit(2), 7000).unref()
  }
}

const config = { profile: join(root, 'profile'), workspace, resourceRoot: join(workspace, 'site'), evidence, endpoint, main: pathToFileURL(resolve('out/main/index.js')).href }
const driverPath = join(root, 'driver.mjs')
writeFileSync(driverPath, '(' + driver.toString() + ')(' + JSON.stringify(config) + ');')
const resultPath = join(evidence, 'result.json'), pidsPath = join(evidence, 'owned-pids.json')
for (const path of [resultPath, pidsPath]) rmSync(path, { force: true })
const env = { ...process.env, COGENT_HOME: home, USERPROFILE: home, HOME: home }
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
let child, timedOut = false, timer
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
try {
  child = spawn(electron, [driverPath], { cwd: process.cwd(), env, stdio: 'inherit', windowsHide: true })
  timer = setTimeout(() => { timedOut = true; child.kill() }, 180000)
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done) })
  clearTimeout(timer)
  const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : { passed: false, error: 'Electron未写入验收结果' }
  const ownedPids = existsSync(pidsPath) ? JSON.parse(readFileSync(pidsPath, 'utf8')) : [child.pid]
  const deadline = Date.now() + 5000
  while (ownedPids.some(alive) && Date.now() < deadline) await new Promise(done => setTimeout(done, 100))
  result.cleanup = { ownedPids, remainingPids: ownedPids.filter(alive), timedOut, exitCode: code }
  result.modelRequests = modelRequests
  if (code !== 0 || timedOut || result.cleanup.remainingPids.length !== 0) result.passed = false
  writeFileSync(resultPath, JSON.stringify(result, null, 2))
  process.exitCode = result.passed ? 0 : 1
} finally {
  clearTimeout(timer)
  if (child && child.exitCode === null) child.kill()
  server.closeAllConnections()
  await new Promise(done => server.close(done))
  const taskRelative = relative(resolve(tmpdir()), resolve(root))
  if (isAbsolute(taskRelative) || taskRelative.startsWith('..') || !taskRelative.startsWith('cogent-workspace-links-')) throw new Error('临时根边界错误')
  const ownedPids = existsSync(pidsPath) ? JSON.parse(readFileSync(pidsPath, 'utf8')) : []
  if (ownedPids.some(alive)) console.error('自有进程尚存，保留临时证据：' + root)
  else rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
