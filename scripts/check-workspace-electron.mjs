/** 真产品 UI + 本地网页；隔离 Host/profile/目录，正常GPU，有限生命周期。 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import electron from 'electron'

const root = mkdtempSync(join(tmpdir(), 'cogent-workspace-electron-'))
const home = join(root, 'home'), workspace = join(root, 'workspace')
const evidence = resolve(process.env.WORKSPACE_EVIDENCE ?? 'tmp/workspace-electron')
mkdirSync(home); mkdirSync(workspace); mkdirSync(evidence, { recursive: true })
writeFileSync(join(workspace, 'alpha.txt'), Array.from({ length: 1500 }, (_, i) => 'ALPHA reading line ' + i).join('\n'))
writeFileSync(join(workspace, 'beta.md'), '# BETA\n\nA second independent file.\n')
for (let i = 0; i < 10000; i++) writeFileSync(join(workspace, 'entry-' + String(i).padStart(5, '0') + '.txt'), 'fixture')
const server = createServer((request, response) => {
  if (request.url === '/auth') {
    if (request.headers.authorization !== 'Basic ' + Buffer.from('workspace-user:fixture-password').toString('base64')) {
      response.writeHead(401, { 'www-authenticate': 'Basic realm="Workspace fixture"', 'content-type': 'text/plain' })
      response.end('Authentication required'); return
    }
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><title>Workspace authenticated</title><h1>AUTHENTICATED fixture</h1>'); return
  }
  response.writeHead(200, { 'content-type': 'text/html' })
  response.end('<!doctype html><html><head><title>Workspace fixture</title></head><body style="font:16px sans-serif;padding:20px"><h1>Workspace fixture</h1><input id="field" placeholder="Form survives layout"><a id="next" href="/second">Next page</a><button onclick="window.open(\'/popup\',\'child\')">Popup</button><p>Sandboxed local page.</p></body></html>')
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const url = 'http://127.0.0.1:' + server.address().port + '/'

async function driver(config) {
  const childProcess = (await import('node:child_process')).default
  const ownedChildren = new Set()
  const spawnChild = childProcess.spawn
  childProcess.spawn = (...args) => {
    const child = spawnChild(...args)
    if (child.pid) ownedChildren.add(child.pid)
    return child
  }
  ;(await import('node:module')).syncBuiltinESMExports()
  app.setPath('userData', config.profile)
  app.commandLine.appendSwitch('force-device-scale-factor', String(config.dpr))
  const created = new Promise(done => app.once('browser-window-created', (_event, win) => done(win)))
  const checks = [], errors = [], measurements = {}
  const projectName = '工作区验收项目'
  measurements.project = { name: projectName, pickers: [] }
  dialog.showOpenDialog = async (_window, options) => {
    if (options.title !== '选择项目文件夹' || !options.properties.includes('openDirectory')) throw new Error('非预期项目目录选择器：' + JSON.stringify(options))
    measurements.project.pickers.push({ title: options.title, selected: config.workspace })
    return { canceled: false, filePaths: [config.workspace] }
  }
  const fileLeases = new Set(), fileRequests = new Set()
  const fileRequestSamples = []
  const originalHandle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, handler) => originalHandle(channel, channel === 'fileViews:request' ? async (event, payload) => {
    const request = {}, started = performance.now()
    fileRequests.add(request)
    try {
      const result = await handler(event, payload)
      if (payload.method === 'fileViews.acquire') fileLeases.add(result.leaseId)
      if (payload.method === 'fileViews.release') fileLeases.delete(payload.params.leaseId)
      fileRequestSamples.push({ method: payload.method, durationMs: performance.now() - started })
      return result
    } finally { fileRequests.delete(request) }
  } : handler)
  let win, passed = false
  const wait = async (test, label) => {
    const start = Date.now()
    while (Date.now() - start < 30000) {
      if (await test()) { checks.push(label); return }
      await new Promise(done => setTimeout(done, 40))
    }
    throw new Error('超时：' + label)
  }
  const evaluate = source => win.webContents.executeJavaScript(source, true)
  const click = async selector => {
    await wait(() => evaluate('(()=>{const el=document.querySelector(' + JSON.stringify(selector) + ');return !!el&&!el.disabled&&el.getAttribute("aria-disabled")!=="true"&&el.getBoundingClientRect().width>0})()'), '控件可点击 ' + selector)
    await evaluate('document.querySelector(' + JSON.stringify(selector) + ').scrollIntoView({behavior:"instant",block:"nearest",inline:"nearest"});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    let point
    await wait(async () => {
      const geometry = await evaluate('(()=>{const el=document.querySelector(' + JSON.stringify(selector) + ');if(!el)return{point:null,missing:true};el.scrollIntoView({behavior:"instant",block:"nearest",inline:"nearest"});const r=el.getBoundingClientRect(),list=el.closest("[role=tablist]"),clip=list?list.getBoundingClientRect():{left:0,right:innerWidth},left=Math.max(r.left,clip.left),right=Math.min(r.right,clip.right),x=Math.round((left+right)/2),y=Math.round(r.y+r.height/2),hit=document.elementFromPoint(x,y);return{point:right>left&&el.contains(hit)?{x,y}:null,scrollLeft:list?.scrollLeft,rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},clip:{left:clip.left,right:clip.right},hit:{tag:hit?.tagName,role:hit?.getAttribute("role"),label:hit?.getAttribute("aria-label"),text:hit?.textContent?.slice(0,80)}}})()')
      point = geometry.point
      if (point === null) { (measurements.clickMisses ??= []).push({ selector, ...geometry }) }
      return point !== null
    }, '指针目标可命中 ' + selector)
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
    await new Promise(done => setTimeout(done, 60))
  }
  const textButton = async (text, root = '[data-workspace]') => {
    const selector = await evaluate('(()=>{const nodes=Array.from(document.querySelectorAll(' + JSON.stringify(root + ' :is(button,[role=tab],[role=menuitem],[role=option])') + '));const el=nodes.find(el=>el.textContent.trim()===' + JSON.stringify(text) + ');if(!el)throw new Error("Control missing "+' + JSON.stringify(text) + '+"; candidates="+JSON.stringify(nodes.map(node=>node.textContent.trim()).filter(Boolean)));el.setAttribute("data-test-click","target");return "[data-test-click=target]"})()')
    await click(selector)
    await evaluate('document.querySelector("[data-test-click]")?.removeAttribute("data-test-click")')
  }
  const activePanel = '[data-workspace-panel]:not([hidden])'
  const type = async (selector, value) => {
    await click(selector)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] })
    await wait(() => evaluate('(()=>{const input=document.querySelector(' + JSON.stringify(selector) + ');return input.selectionStart===0&&input.selectionEnd===input.value.length})()'), '原生全选已生效 ' + selector)
    await win.webContents.insertText(value)
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  }
  const bindProject = async () => {
    await wait(() => evaluate('Array.from(document.querySelectorAll("[data-workspace-frame] .home-chat button")).some(el=>el.textContent.trim()==="选择项目")'), '未发送草稿的项目选择入口就绪')
    await textButton('选择项目', '[data-workspace-frame] .home-chat')
    await wait(() => evaluate('!!document.querySelector(\'[data-slot=popover-content] input[placeholder="搜索项目"]\')'), '真实项目选择Popover已打开')
    await textButton('新建项目', '[data-slot=popover-content]')
    await wait(() => evaluate('!!document.querySelector(\'[role=dialog] [aria-label="项目类型"]\')'), '创建项目第一步就绪')
    await textButton('下一步', '[role=dialog]')
    await type('[role=dialog] input[placeholder="项目名称"]', projectName)
    await textButton('添加文件夹', '[role=dialog]')
    await wait(() => evaluate('Array.from(document.querySelectorAll("[role=dialog] button")).some(el=>el.getAttribute("aria-label")===' + JSON.stringify('移除 ' + config.workspace) + ')'), '原生选择器选中本轮隔离项目目录')
    await textButton('创建项目', '[role=dialog]')
    await wait(() => evaluate('Array.from(document.querySelectorAll("[role=dialog] button")).some(el=>el.textContent.trim()==="信任文件夹")'), '项目目录信任确认就绪')
    await textButton('信任文件夹', '[role=dialog]')
    await wait(() => evaluate('!document.querySelector("[role=dialog]")&&!document.querySelector("[data-slot=popover-content]")&&Array.from(document.querySelectorAll("[data-workspace-frame] .home-chat button")).some(el=>el.textContent.trim()===' + JSON.stringify(projectName) + ')'), '真实创建并信任项目后草稿回显项目名')
    if (measurements.project.pickers.length !== 1) throw new Error('项目绑定调用了非预期次数的原生目录选择器')
    measurements.project.createdViaUi = true
  }
  const writeResult = async () => writeFileSync(join(config.evidence, 'result-' + config.phase + '-dpr' + config.dpr + '.json'), JSON.stringify({ scope: config.diagnostics ? '产品文件导航/循环回收/排序/原生拖动诊断；设置往返与重启由独立完整产品场景负责' : '同一进程的工作区容量、热切换和批量关闭', passed, checks, measurements, errors, actualDpr: await evaluate('devicePixelRatio'), gpuStatusAtCompletion: app.getGPUFeatureStatus(), ownedPids: [...new Set([...ownedChildren, ...app.getAppMetrics().map(item => item.pid)])], electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform }, null, 2))
  const checkDiagnosticTargets = () => {
    const p95 = values => [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.95)]
    measurements.diagnosticVerdict = {
      leaseAndRequests: measurements.loops.resourcesReturned,
      retainedHeap: measurements.loops.heapDeltaMiB <= 5 && measurements.loops.heapTailMiBPerCycle <= 0.1,
      close: p95(measurements.loops.closeMs) <= 100,
      sort: p95(measurements.sortMs) <= 100,
      treeScroll: p95(measurements.treeScrollMs) <= 100,
      treeFirst: measurements.treeFirstMs <= 1000,
      search: measurements.search.every(item => item.firstMs <= 1000 && item.completeMs <= 3000),
      dragFrames: p95(measurements.dragFrameIntervals) <= 20
    }
    if (!Object.values(measurements.diagnosticVerdict).every(Boolean)) throw new Error('诊断性能目标未全部通过：' + JSON.stringify(measurements.diagnosticVerdict))
  }
  try {
    await import(config.main)
    win = await created
    win.setSize(1500, 900); win.show()
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
    await wait(() => evaluate('!!document.querySelector("[data-home-split]")'), '产品首页加载')
    await evaluate('window.cogent.saveSettings({closeBehavior:"quit"})')
    const before = await evaluate('window.cogent.engineRequest("session.list",{})')
    await bindProject()
    await click('[aria-label=展开标签页区]')
    await wait(() => evaluate('!!document.querySelector("[aria-label=打开文件导航]")'), '启动页就绪')
    // 创建项目及信任目录的人工UI不计入10k树首次加载；计时从真正打开项目导航开始。
    const treeStarted = performance.now()
    await click('[aria-label=打开文件导航]')
    await wait(() => evaluate('(()=>{const navigator=document.querySelector("[data-file-workspace]:not([hidden]) [data-file-navigator]");return navigator?.querySelector("[data-file-root-label]")?.textContent.trim()===' + JSON.stringify(projectName) + '&&navigator.querySelectorAll("[role=treeitem]").length>2})()'), '未发送聊天打开项目导航并显示真实目录文件')
    measurements.treeFirstMs = performance.now() - treeStarted
    measurements.treeDom = await evaluate('document.querySelectorAll("[role=treeitem]").length')
    if (measurements.treeDom > 200) throw new Error('树DOM超过200')
    const after = await evaluate('window.cogent.engineRequest("session.list",{})')
    if (after.length !== before.length) throw new Error('浏览文件创建了聊天')
    checks.push('10,000节点目录虚拟化且不创建聊天')
    measurements.search = []
    for (const name of ['alpha.txt', 'beta.md']) {
      const searchStarted = performance.now()
      await type('[aria-label=搜索项目文件]', name)
      await wait(() => evaluate('Array.from(document.querySelectorAll("[aria-label=文件搜索结果] button")).some(el=>el.textContent.includes(' + JSON.stringify(name) + '))'), '搜索未展开文件 ' + name)
      const firstMs = performance.now() - searchStarted
      await wait(() => evaluate('!document.querySelector("[aria-label=取消搜索]")'), '文件搜索完成 ' + name)
      measurements.search.push({ query: name, firstMs, completeMs: performance.now() - searchStarted })
      const started = Date.now()
      await click('[aria-label=文件搜索结果] button')
      await wait(() => evaluate('(()=>{const root=document.querySelector(' + JSON.stringify(activePanel) + ');return (root?.textContent??"")+Array.from(root?.querySelectorAll("diffs-container")??[]).map(el=>el.shadowRoot?.textContent??"").join("")})().includes(' + JSON.stringify(name === 'alpha.txt' ? 'ALPHA reading' : 'BETA') + ')'), '文件独立预览 ' + name)
      measurements[name] = Date.now() - started
      if (name === 'alpha.txt') {
        await evaluate('const view=document.querySelector("[data-code-scroll]");view.scrollTop=2500;view.dispatchEvent(new Event("scroll"))')
        // 文件树点击会在当前标签内导航。打开另一张文件页才有独立的热切换样本。
        await click('[aria-label=新建标签页]')
        await click('[aria-label=打开文件导航]')
      }
    }
    await textButton('alpha.txt', '[aria-label=工作区标签页]')
    await wait(() => evaluate('document.querySelector(' + JSON.stringify(activePanel + ' [data-code-scroll]') + ')?.scrollTop>1000'), '切换文件保留阅读位置')
    if (config.diagnostics) {
      win.webContents.debugger.attach('1.3')
      const collect = () => win.webContents.debugger.sendCommand('HeapProfiler.collectGarbage')
      const sample = async cycle => ({ cycle, heap: await win.webContents.debugger.sendCommand('Runtime.getHeapUsage'), dom: await win.webContents.debugger.sendCommand('Memory.getDOMCounters'), leases: fileLeases.size, requests: fileRequests.size, privateBytesKiB: app.getAppMetrics().reduce((sum, item) => sum + item.memory.privateBytes, 0) })
      const closeBeta = async () => {
        await evaluate('Array.from(document.querySelectorAll("button")).find(el=>el.getAttribute("aria-label")==="关闭 beta.md").click()')
        await wait(() => evaluate('!Array.from(document.querySelectorAll("button")).some(el=>el.getAttribute("aria-label")==="关闭 beta.md")'), '关闭循环文件标签')
        await wait(() => Promise.resolve(fileRequests.size === 0), '关闭循环文件请求已回收')
      }
      await closeBeta()
      const cycle = async () => {
        await evaluate('(async()=>{document.querySelector("[aria-label=新建标签页]").click();await new Promise(requestAnimationFrame);document.querySelector("[aria-label=打开文件导航]").click();await new Promise(requestAnimationFrame)})()')
        await evaluate('document.querySelector("[aria-label=文件搜索结果] button").click()')
        await wait(() => evaluate('document.querySelector("[data-workspace-panel]:not([hidden]) [data-file-preview]")?.textContent.includes("BETA")'), '循环文件按真实Host读取')
        const elapsed = await evaluate('new Promise(resolve=>{const start=performance.now();Array.from(document.querySelectorAll("button")).find(el=>el.getAttribute("aria-label")==="关闭 beta.md").click();requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()-start)))})')
        await wait(() => Promise.resolve(fileRequests.size === 0), '循环请求清零')
        if (await evaluate('Array.from(document.querySelectorAll("button")).some(el=>el.getAttribute("aria-label")==="关闭 beta.md")')) throw new Error('循环文件未关闭')
        return elapsed
      }
      for (let index = 0; index < 10; index++) await cycle()
      measurements.loops = { scope: '实际产品UI打开/关闭Markdown文件；Renderer heap/DOM与fileViews IPC租约/在途请求，不代表Host内部observer全量计数', natural: [await sample(0)], collected: [], closeMs: [] }
      for (let index = 1; index <= 100; index++) { measurements.loops.closeMs.push(await cycle()); if (index % 10 === 0) measurements.loops.natural.push(await sample(index)) }
      await collect(); measurements.loops.collected.push(await sample(0))
      for (let index = 1; index <= 100; index++) { measurements.loops.closeMs.push(await cycle()); if (index % 10 === 0) { await collect(); measurements.loops.collected.push(await sample(index)) } }
      const collected = measurements.loops.collected, base = collected[0], last = collected.at(-1), tail = collected.filter(item => item.cycle >= 50)
      const meanCycle = tail.reduce((sum, item) => sum + item.cycle, 0) / tail.length
      const meanHeap = tail.reduce((sum, item) => sum + item.heap.usedSize, 0) / tail.length
      measurements.loops.heapDeltaMiB = (last.heap.usedSize - base.heap.usedSize) / 1024 ** 2
      measurements.loops.heapTailMiBPerCycle = tail.reduce((sum, item) => sum + (item.cycle - meanCycle) * (item.heap.usedSize - meanHeap), 0) / tail.reduce((sum, item) => sum + (item.cycle - meanCycle) ** 2, 0) / 1024 ** 2
      measurements.loops.resourcesReturned = collected.every(item => item.leases === base.leases && item.requests === 0)
      measurements.loops.fileRequestSamples = fileRequestSamples
      if (!measurements.loops.resourcesReturned) throw new Error('循环后文件租约或请求未回基线')
      win.webContents.debugger.detach()
      await click('[aria-label=新建标签页]')
      await click('[aria-label=打开文件导航]')
      measurements.sortMs = []
      for (let index = 0; index < 30; index++) {
        const header = await evaluate('(()=>{const tab=Array.from(document.querySelectorAll("[aria-label=工作区标签页] [role=tab]")).find(el=>el.textContent.trim()==="alpha.txt"),r=tab.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()')
        win.webContents.sendInputEvent({ type: 'mouseMove', ...header })
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'right', clickCount: 1, ...header })
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'right', clickCount: 1, ...header })
        await wait(() => evaluate('!!document.querySelector("[role=menuitem]")'), '排序上下文菜单打开')
        const elapsed = await evaluate('new Promise(resolve=>{const tabs=Array.from(document.querySelectorAll("[aria-label=工作区标签页] [role=tab]")),before=tabs.findIndex(el=>el.textContent.trim()==="alpha.txt"),direction=before>0?"向左移动标签页":"向右移动标签页",start=performance.now();Array.from(document.querySelectorAll("[role=menuitem]")).find(el=>el.textContent.trim()===direction).click();requestAnimationFrame(()=>requestAnimationFrame(()=>{const after=Array.from(document.querySelectorAll("[aria-label=工作区标签页] [role=tab]")).findIndex(el=>el.textContent.trim()==="alpha.txt");resolve({ms:performance.now()-start,changed:before!==after})}))})')
        if (!elapsed.changed) throw new Error('排序菜单未改变真实标签顺序')
        measurements.sortMs.push(elapsed.ms)
      }
      await textButton('文件', '[aria-label=工作区标签页]')
      await click('[aria-label=清除文件搜索]')
      await wait(() => evaluate('!!document.querySelector("[role=treeitem]")'), '目录树恢复')
      measurements.treeScrollMs = []
      for (let index = 0; index < 30; index++) measurements.treeScrollMs.push(await evaluate('new Promise(resolve=>{const el=document.querySelector("[data-testid=file-navigator-tree-scroll]"),start=performance.now();el.scrollTop=el.scrollTop>900?0:el.scrollTop+120;el.dispatchEvent(new Event("scroll"));requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()-start)))})'))
      await type('[aria-label=搜索项目文件]', 'beta.md')
      await wait(() => evaluate('Array.from(document.querySelectorAll("[aria-label=文件搜索结果] button")).some(el=>el.textContent.includes("beta.md"))'), '诊断后恢复搜索结果')
      await evaluate('document.querySelector("[aria-label=文件搜索结果] button").click()')
      await wait(() => evaluate('document.querySelector("[data-workspace-panel]:not([hidden]) [data-file-preview]")?.textContent.includes("BETA")'), '诊断后恢复beta文件')
    }
    await click('[aria-label=新建标签页]')
    await wait(() => evaluate('!!document.querySelector("[aria-label=打开内置浏览器]")'), '浏览器启动入口')
    await click('[aria-label=打开内置浏览器]')
    await wait(() => evaluate('!!document.querySelector("webview")'), '独立浏览器实例就绪')
    await type('[aria-label=网页地址或搜索]', config.url)
    await evaluate('window.workspaceKeylog=[];const field=document.querySelector("[aria-label=网页地址或搜索]");for(const type of ["keydown","keypress","keyup","input","change"])field.addEventListener(type,e=>window.workspaceKeylog.push({type:e.type,key:e.key,value:field.value}));field.form.addEventListener("submit",()=>window.workspaceKeylog.push({type:"submit",value:field.value}))')
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    await wait(() => Promise.resolve(webContents.getAllWebContents().some(wc => wc.getType() === 'webview' && wc.getURL() === config.url)), '真实网页加载')
    const guest = webContents.getAllWebContents().find(wc => wc.getType() === 'webview' && wc.getURL() === config.url)
    await wait(() => guest.executeJavaScript('!!document.querySelector("#field")'), '网页输入框就绪')
    guest.focus()
    await guest.executeJavaScript('document.querySelector("#field").focus()')
    await guest.insertText('keep-form-identity')
    const guestId = guest.id
    await textButton('alpha.txt', '[aria-label=工作区标签页]')
    await textButton('Workspace fixture', '[aria-label=工作区标签页]')
    if (guest.id !== guestId || await guest.executeJavaScript('document.querySelector("#field").value') !== 'keep-form-identity') throw new Error('切换标签丢失表单')
    checks.push('切换标签保留guest与表单')
    await textButton('alpha.txt', '[aria-label=工作区标签页]')
    await wait(() => evaluate('Array.from(document.querySelectorAll("[aria-label=工作区标签页] [role=tab]")).some(el=>el.textContent.trim()==="alpha.txt"&&el.getAttribute("aria-selected")==="true")'), '拖动前alpha标签实际激活')
    const drag = await evaluate('(()=>{const list=document.querySelector("[aria-label=工作区标签页]"),clip=list.getBoundingClientRect(),tabs=Array.from(list.querySelectorAll("[role=tab]"));const point=name=>{const r=tabs.find(el=>el.textContent.trim()===name).getBoundingClientRect();return {x:Math.round(Math.max(clip.left+2,Math.min(clip.right-2,r.left+r.width/2))),y:Math.round(r.top+r.height/2)}};return {from:point("alpha.txt"),to:point("beta.md"),order:tabs.map(el=>el.textContent.trim())}})()')
    measurements.dragGeometry = drag
    await evaluate('window.workspaceDragFrames=[];window.workspaceDragMeasuring=true;(()=>{let previous=performance.now();const frame=now=>{if(!window.workspaceDragMeasuring)return;window.workspaceDragFrames.push(now-previous);previous=now;requestAnimationFrame(frame)};requestAnimationFrame(frame)})();undefined')
    win.webContents.sendInputEvent({ type: 'mouseMove', ...drag.from })
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...drag.from })
    for (let step = 1; step <= 10; step++) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(drag.from.x + (drag.to.x - drag.from.x) * step / 10), y: drag.from.y })
      await new Promise(done => setTimeout(done, 20))
    }
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...drag.to })
    await wait(() => evaluate('(()=>{const tabs=Array.from(document.querySelectorAll("[aria-label=工作区标签页] [role=tab]")).map(el=>el.textContent.trim());return tabs.indexOf("beta.md")<tabs.indexOf("alpha.txt")})()'), '真实指针拖动仅改变标签头顺序')
    measurements.dragFrameIntervals = await evaluate('window.workspaceDragMeasuring=false;window.workspaceDragFrames')
    // dnd-kit PointerSensor.detach 保留 document 的 click 抑制器50ms，避免把松手当点击。
    // 等这个库定义的手势尾窗结束，再派发下一次独立点击；不计入上面的拖动性能样本。
    await new Promise(done => setTimeout(done, 60))
    await textButton('Workspace fixture', '[aria-label=工作区标签页]')
    if (guest.isDestroyed() || await guest.executeJavaScript('document.querySelector("#field").value') !== 'keep-form-identity') throw new Error('拖动标签重建网页')
    checks.push('拖动后同guest与表单保留')
    if (config.diagnostics) { checkDiagnosticTargets(); passed = true; await writeResult(); return }
    measurements.focusTransitions = []
    const inspectFocus = async stage => {
      const value = await evaluate('(()=>{const active=document.activeElement;return{selected:document.querySelector("[aria-label=工作区标签页] [role=tab][aria-selected=true]")?.textContent.trim(),workspaceInert:document.querySelector("[data-workspace]")?.inert,focused:{tag:active?.tagName,role:active?.getAttribute("role"),label:active?.getAttribute("aria-label"),text:active?.textContent?.slice(0,100)}}})()')
      value.guestId = guest.id
      value.form = await guest.executeJavaScript('document.querySelector("#field").value')
      measurements.focusTransitions.push({ stage, ...value })
      const selectionPreserved = stage === '设置之中' ? value.selected === undefined && value.workspaceInert : value.selected === 'Workspace fixture'
      if (!selectionPreserved || value.form !== 'keep-form-identity') throw new Error('工作区选中或网页状态被改变 ' + stage + '：' + JSON.stringify(value))
    }
    await inspectFocus('设置之前')
    await click('[aria-label=设置]')
    await textButton('设置', '[role=menu]')
    await wait(() => evaluate('document.querySelector("[data-workspace]")?.getAttribute("inert")!==null'), '设置页隐藏工作区并解除焦点入口')
    await inspectFocus('设置之中')
    await textButton('外观', '[data-sidebar-clip]')
    await click('[aria-label=深色浅色]')
    await textButton('跟随系统', '[role=listbox]')
    if (config.extraUi) { await click('[aria-label=界面字号]'); await textButton('16 px', '[role=listbox]') }
    await click('[aria-label=首页]')
    await inspectFocus('回到首页')
    if (await guest.executeJavaScript('document.querySelector("#field").value') !== 'keep-form-identity') throw new Error('设置往返重建网页')
    checks.push('设置往返保留表单')
    await guest.executeJavaScript('window.overlayPointerEvents=0;document.addEventListener("mousedown",()=>window.overlayPointerEvents++)')
    await click('[aria-label=浏览器菜单]')
    await textButton('站点权限', '[role=menu]')
    await wait(() => evaluate('!!document.querySelector("[role=dialog]")'), '真实菜单与Dialog覆盖网页')
    await click('[role=dialog] [data-slot=dialog-close]')
    if (await guest.executeJavaScript('window.overlayPointerEvents') !== 0) throw new Error('工作区浮层点击穿透网页')
    checks.push('真实指针命中浮层且不穿透网页')
    if (!config.performanceOnly) {
      const matrix = []
      for (const theme of ['light', 'dark']) {
        nativeTheme.themeSource = theme
        await wait(() => evaluate('document.documentElement.classList.contains("dark")==='+JSON.stringify(theme==='dark')), '实际应用主题 '+theme)
        for (const width of [400, 760, 1100, 1440, 1920]) {
          win.setSize(1500, 900)
          await wait(() => evaluate('!matchMedia("(max-width:760px)").matches&&document.querySelector("[data-workspace]")?.inert===false'), '放宽恢复原工作区开态 ' + theme + '/' + width)
          win.setSize(width, 900)
          await new Promise(done => setTimeout(done, 230))
          const narrow = await evaluate('matchMedia("(max-width:760px)").matches')
          if (narrow) {
            await wait(() => evaluate('document.querySelector("[data-workspace]")?.inert===true&&document.querySelector("[data-sidebar-clip]")?.inert===true&&document.querySelector("[data-sidebar-clip]").getBoundingClientRect().width<1&&document.querySelector("[aria-label=展开侧边栏]")?.disabled===true'), '窄窗左右侧栏同步自动收起 ' + theme + '/' + width)
            await click('[aria-label=展开标签页区]')
            await wait(() => evaluate('document.querySelector("[data-workspace]")?.inert===false'), '窄窗手动重新打开工作区 ' + theme + '/' + width)
          }
          const geometry = await evaluate('(()=>{const el=document.querySelector("[data-workspace]"),r=el.getBoundingClientRect(),tab=el.querySelector("[role=tab][aria-selected=true]"),t=tab.getBoundingClientRect(),list=tab.closest("[role=tablist]").getBoundingClientRect(),chat=document.querySelector("[data-workspace-frame]")?.firstElementChild;return {width:innerWidth,left:r.left,right:r.right,panelWidth:r.width,overflow:document.documentElement.scrollWidth>innerWidth,activeHeaderVisible:t.left>=list.left-1&&t.right<=list.right+1,mode:el.dataset.workspaceMode,chatInteractive:!!chat&&!chat.inert&&chat.closest("[inert]")===null}})()')
          if (geometry.left < -1 || geometry.right > geometry.width + 1 || geometry.overflow || !geometry.activeHeaderVisible || geometry.mode !== 'split' || !geometry.chatInteractive) throw new Error('响应式并排/几何失败：' + JSON.stringify(geometry))
          if (await guest.executeJavaScript('document.querySelector("#field").value') !== 'keep-form-identity') throw new Error('窗口变化重建网页')
          const point = await evaluate('(()=>{const r=document.querySelector("[data-workspace-panel]:not([hidden]) [data-browser-surface]").getBoundingClientRect();return {x:Math.floor(r.right-8),y:Math.floor(r.bottom-8)}})()')
          const pixel = (await win.webContents.capturePage({ ...point, width: 1, height: 1 })).toBitmap()
          if (pixel.length < 4 || pixel[0] < 240 || pixel[1] < 240 || pixel[2] < 240) throw new Error('透明网页未获得正常浏览器白底，深色宿主影响了网页可读性')
          matrix.push({ theme, width, autoCollapsedBeforeOpen: narrow, ...geometry })
          if ((width === 400 || width === 1440) && config.dpr === 1) writeFileSync(join(config.evidence, theme + '-' + width + '.png'), (await win.webContents.capturePage()).toPNG())
        }
      }
      measurements.matrix = matrix
      checks.push('明暗×5窗口宽度保持同guest与表单')
      if (config.extraUi) {
        measurements.appZoom = []
        for (const zoom of [1, 1.25, 1.5]) {
          win.webContents.setZoomFactor(zoom); win.setSize(1500, 900)
          await wait(() => evaluate('!matchMedia("(max-width:760px)").matches&&document.querySelector("[data-workspace]")?.inert===false'), '缩放前宽窗恢复原开态 ' + zoom)
          win.setSize(1100, 900)
          await new Promise(done => setTimeout(done, 250))
          const narrow = await evaluate('matchMedia("(max-width:760px)").matches')
          if (narrow) {
            await wait(() => evaluate('document.querySelector("[data-workspace]")?.inert===true&&document.querySelector("[data-sidebar-clip]")?.inert===true&&document.querySelector("[aria-label=展开侧边栏]")?.disabled===true'), '应用缩放跨断点同步自动收起 ' + zoom)
            await click('[aria-label=展开标签页区]')
            await wait(() => evaluate('document.querySelector("[data-workspace]")?.inert===false'), '应用缩放窄态可手动重开工作区 ' + zoom)
          }
          const geometry = await evaluate('(()=>{const workspace=document.querySelector("[data-workspace]"),r=workspace.getBoundingClientRect(),chat=document.querySelector("[data-workspace-frame]")?.firstElementChild;return {left:r.left,right:r.right,width:innerWidth,uiFont:getComputedStyle(document.documentElement).fontSize,mode:workspace.dataset.workspaceMode,chatInteractive:!!chat&&!chat.inert&&chat.closest("[inert]")===null}})()')
          if (geometry.left < -1 || geometry.right > geometry.width + 1 || geometry.mode !== 'split' || !geometry.chatInteractive || await guest.executeJavaScript('document.querySelector("#field").value') !== 'keep-form-identity') throw new Error('应用缩放/16px字号并排切换失效')
          measurements.appZoom.push({ zoom, autoCollapsedBeforeOpen: narrow, ...geometry })
        }
        win.webContents.setZoomFactor(1)
        checks.push('应用zoom 1/1.25/1.5与16px界面字号保持布局及表单')
      }
    }
    win.setSize(1500, 900)
    win.show(); win.focus()
    await wait(() => Promise.resolve(win.isFocused() && win.isVisible() && !win.isMinimized()), '热切换采样窗口实际前台')
    const timings = []
    measurements.switchContext = []
    for (let i = 0; i < 200; i++) {
      const context = async () => ({ focused: win.isFocused(), visible: win.isVisible(), minimized: win.isMinimized(), documentVisibility: await evaluate('document.visibilityState') })
      const before = await context()
      const elapsed = await evaluate('new Promise(resolve=>{const el=Array.from(document.querySelectorAll("[aria-label=工作区标签页] [role=tab]")).find(el=>el.textContent.trim()===' + JSON.stringify('alpha.txt') + ');const start=performance.now();el.click();requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()-start)))})')
      timings.push(elapsed)
      measurements.switchContext.push({ index: i, elapsed, before, after: await context() })
      await evaluate('Array.from(document.querySelectorAll("[aria-label=工作区标签页] [role=tab]")).find(el=>el.textContent.trim()==="beta.md").click()')
    }
    timings.sort((a, b) => a - b)
    measurements.switches = { samples: timings, p50: timings[100], p95: timings[190], max: timings.at(-1) }
    await click('[aria-label=新建标签页]')
    await click('[aria-label=打开内置浏览器]')
    await type(activePanel + ' [aria-label=网页地址或搜索]', config.url + 'auth')
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    await wait(() => evaluate('!!document.querySelector("[aria-label=身份验证用户名]")'), '真实HTTP Basic challenge显示用户名密码对话框')
    await type('[aria-label=身份验证用户名]', 'workspace-user')
    await type('[aria-label=身份验证密码]', 'fixture-password')
    await textButton('确定', '[role=dialog]')
    await wait(() => Promise.all(webContents.getAllWebContents().filter(wc=>wc.getType()==='webview'&&wc.getURL()===config.url+'auth').map(wc=>wc.executeJavaScript('document.body.textContent.includes("AUTHENTICATED")'))).then(values=>values.includes(true)), '真实HTTP Basic答复通过且页面完成加载')
    await wait(() => evaluate('!document.querySelector("[role=dialog]")'), '身份验证浮层自然退场后继续操作')
    await click('[aria-label="关闭 Workspace authenticated"]')
    await textButton('Workspace fixture', '[aria-label=工作区标签页]')
    const webviews = webContents.getAllWebContents().filter(contents => contents.getType() === 'webview').length
    await evaluate('(async()=>{for(let i=0;i<100&&document.querySelectorAll("[aria-label=工作区标签页] [role=tab]").length<100;i++){document.querySelector("[aria-label=新建标签页]").click();await new Promise(requestAnimationFrame)}})()')
    await wait(() => evaluate('document.querySelectorAll("[aria-label=工作区标签页] [role=tab]").length===100'), '工作区中有100个逻辑标签')
    if (webviews !== 1 || webContents.getAllWebContents().filter(contents => contents.getType() === 'webview').length !== webviews) throw new Error('新建空标签改变了真实网页 guest 数量')
    await textButton('Workspace fixture', '[aria-label=工作区标签页]')
    await new Promise(done => setTimeout(done, 500))
    checks.push('200次热切换无串内容')
    await click('[aria-label=标签页列表]')
    await evaluate('window.workspaceCloseStarted=performance.now()')
    await textButton('关闭全部标签页', '[data-slot=popover-content]')
    await wait(() => evaluate('document.querySelector("[data-workspace]")?.inert===true&&document.querySelectorAll("[aria-label=工作区标签页] [role=tab]").length===0&&document.querySelectorAll("webview").length===0'), '100个标签全部关闭且网页容器卸载')
    measurements.closeLogicalTabs = await evaluate('performance.now()-window.workspaceCloseStarted')
    await wait(() => Promise.resolve(webContents.getAllWebContents().every(contents => contents.getType() !== 'webview')), '关闭全部后原生 guest 回收')
    await click('[aria-label=展开标签页区]')
    // 批量关闭按实际标签顺序记录recent；只走公开重开入口，不假定beta是首项。
    const reopened = []
    for (let attempt = 0; attempt < 20; attempt++) {
      await click('[aria-label=标签页列表]')
      await textButton('重新打开关闭的标签页', '[data-slot=popover-content]')
      await wait(() => evaluate('document.querySelector("[data-slot=popover-content]")===null&&!!document.querySelector("[aria-label=工作区标签页] [role=tab][aria-selected=true]")'), 'Popover恢复最近关闭标签 ' + attempt)
      const current = await evaluate('(()=>{const tab=document.querySelector("[aria-label=工作区标签页] [role=tab][aria-selected=true]");return {id:tab.id,title:tab.textContent.trim()}})()')
      if (reopened.some(tab => tab.id === current.id)) throw new Error('最近关闭记录已耗尽，未恢复beta.md')
      reopened.push(current)
      if (current.title === 'beta.md') break
    }
    if (reopened.at(-1)?.title !== 'beta.md') throw new Error('20项最近关闭记录中没有beta.md')
    await wait(() => evaluate('document.querySelector("[data-workspace-panel]:not([hidden]) [data-file-preview]")?.textContent.includes("BETA")'), '关闭全部后从Popover重新授权恢复最近本地文件')
    for (const tab of reopened.slice(0, -1)) await click('[id=' + JSON.stringify(tab.id) + '] + button')
    await click('[aria-label="关闭 beta.md"]')
    await wait(() => Promise.resolve(webContents.getAllWebContents().every(contents => contents.getType() !== 'webview')), '清理固定目标前额外恢复的网页实例')
    passed = true
    await writeResult()
  } catch (error) {
    if (win && !win.isDestroyed()) errors.push(await evaluate('JSON.stringify({keylog:window.workspaceKeylog,focus:document.activeElement?.outerHTML?.slice(0,1200),guests:Array.from(document.querySelectorAll("webview")).map(el=>({id:el.getWebContentsId(),url:el.getURL()}))})').catch(String))
    if (win && !win.isDestroyed()) writeFileSync(join(config.evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG())
    const result = { passed: false, checks, measurements, errors, error: String(error), stack: error.stack }
    writeFileSync(join(config.evidence, 'result-' + config.phase + '-dpr' + config.dpr + '.json'), JSON.stringify(result, null, 2)); console.error(result)
  } finally {
    if (win && !win.isDestroyed()) {
      // app.quit走产品正常关窗；watchdog只兜自有测试进程。
      app.quit()
      setTimeout(() => app.exit(2), 7000).unref()
    } else app.exit(1)
  }
}

let child
try {
  const phase = 'create'
  const config = { profile: join(root, 'profile'), workspace, url, evidence, performanceOnly: process.argv.includes('--performance'), main: pathToFileURL(resolve('out/main/index.js')).href, phase, dpr: Number(process.env.WORKSPACE_DPR ?? 1), extraUi: process.env.WORKSPACE_EXTRA_UI === '1', diagnostics: process.env.WORKSPACE_DIAGNOSTICS === '1' }
  const driverPath = join(root, 'driver-' + phase + '.mjs')
  writeFileSync(driverPath, 'import {app,BrowserWindow,dialog,webContents,nativeTheme,ipcMain} from "electron";import {writeFileSync} from "node:fs";import {join} from "node:path";(' + driver.toString() + ')(' + JSON.stringify(config) + ');')
  const env = { ...process.env, COGENT_HOME: home, USERPROFILE: home, HOME: home }
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const resultFile = join(evidence, 'result-' + phase + '-dpr' + config.dpr + '.json')
  rmSync(resultFile, { force: true })
  child = spawn(electron, [driverPath], { cwd: process.cwd(), env, stdio: 'inherit', windowsHide: true })
  const timeout = setTimeout(() => child.kill(), 180000)
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done) })
  clearTimeout(timeout)
  const file = join(evidence, 'result-' + phase + '-dpr' + config.dpr + '.json')
  if (code !== 0 || !existsSync(file)) throw new Error("工作区 Electron 探针未完成")
  const result = JSON.parse(readFileSync(file, 'utf8'))
  const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
  const end = Date.now() + 5000
  while (result.ownedPids?.some(alive) && Date.now() < end) await new Promise(done => setTimeout(done, 100))
  result.cleanup = { exitedPids: result.ownedPids, remainingPids: result.ownedPids?.filter(alive) ?? [] }
  if (result.cleanup.remainingPids.length > 0) result.passed = false
  writeFileSync(file, JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ phase, passed: result.passed, actualDpr: result.actualDpr, switches: result.measurements?.switches?.p95, cleanup: result.cleanup }))
  if (!result.passed) process.exitCode = 1
} finally {
  if (child && child.exitCode === null) child.kill()
  await new Promise(done => server.close(done))
  if (!root.startsWith(join(tmpdir(), 'cogent-workspace-electron-'))) throw new Error('临时根边界错误')
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
