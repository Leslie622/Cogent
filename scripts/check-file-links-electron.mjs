/** 真 Electron + 产品 main/preload/renderer/Host 冒烟；隔离 profile、凭据和工作区，结束后退出。 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import electron from 'electron'

for (const entry of ['out/main/index.js', 'out/renderer/index.html']) if (!existsSync(resolve(entry))) throw new Error('完整产品构建缺失：'+entry+'；先 npm run build')

const root = mkdtempSync(join(tmpdir(), 'cogent-file-electron-'))
const home = join(root, 'home')
const workspace = join(root, 'workspace')
const evidence = resolve(process.env.FILE_LINKS_EVIDENCE ?? 'tmp/file-links-electron')
mkdirSync(home); mkdirSync(workspace); mkdirSync(evidence, { recursive: true })
rmSync(join(evidence, 'result.json'), { force: true })
mkdirSync(join(workspace, 'folder'))
writeFileSync(join(home, 'settings.json'), JSON.stringify({ version: 1, closeBehavior: 'quit', soundEnabled: false, toastEnabled: false }))
writeFileSync(join(workspace, 'sample.ts'), 'const first = 1\nconst second = 2\nconsole.log(second)\n')
writeFileSync(join(workspace, 'report.md'), '# 本地 Markdown\n\n![本地图](./picture.png)\n\n[源码](./sample.ts:2)\n\n![外部图](https://example.invalid/no.png)')
const office = resolve('reference/zcode/apps/zcode-cli/packages/office-runtime/fixtures')
for (const [source, target] of [[join(office, 'cjk.pdf'), 'sample.pdf'], [join(office, 'report.docx'), 'sample.docx'], [resolve('tests/fixtures/附件兼容/命名空间前缀.xlsx'), 'sample.xlsx'], [join(office, 'launch.pptx'), 'sample.pptx'], [resolve('reference/pi/packages/ai/test/data/red-circle.png'), 'picture.png']]) copyFileSync(source, join(workspace, target))
const wav = Buffer.alloc(44 + 1600)
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(1600, 40)
writeFileSync(join(workspace, 'tone.wav'), wav)
const markdown = [['源码样本', './sample.ts:2:3'], ['片段行列样本', './sample.ts#L2C3'], ['冒号片段样本', './sample.ts#L2:C3'], ['数字片段样本', './sample.ts#L2:3'], ['Markdown样本', './report.md'], ['图片样本', './picture.png'], ['PDF样本', './sample.pdf'], ['Word样本', './sample.docx'], ['表格样本', './sample.xlsx'], ['幻灯片样本', './sample.pptx'], ['音频样本', './tone.wav'], ['目录样本', './folder']].map(([label, target]) => `[${label}](${target})`).join('\n\n') + '\n\n反引号引用：`sample.ts:2:3`'
let finishText
let pendingText
const server = createServer((request, response) => {
  if (request.url.endsWith('/release')) { finishText(); response.end('ok'); return }
  if (request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><title>Streaming workspace</title><input id="stream-form" placeholder="Streaming coexistence">')
    return
  }
  let body = ''
  request.on('data', part => { body += part.toString() })
  request.on('end', () => {
    const payload = JSON.parse(body)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const frame = (delta, finish_reason) => ({ id: 'file-test', object: 'chat.completion.chunk', created: 0, model: 'file-test', choices: [{ index: 0, delta, finish_reason }] })
    if (!payload.messages.some(message => message.role === 'tool')) {
      response.write(`data: ${JSON.stringify(frame({ role: 'assistant', tool_calls: [{ index: 0, id: 'read-file-sample', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'sample.ts' }) } }] }, null))}\n\n`)
      response.write(`data: ${JSON.stringify(frame({}, 'tool_calls'))}\n\n`)
      response.end('data: [DONE]\n\n'); return
    }
    pendingText = response
    // 驱动先检查真实流式 DOM，再主动完成响应；不依赖机器快慢来碰运气。
    for (const part of markdown.match(/[\s\S]{1,24}/g)) response.write(`data: ${JSON.stringify(frame({ role: 'assistant', content: part }, null))}\n\n`)
    finishText = () => {
      response.write(`data: ${JSON.stringify({ ...frame({}, 'stop'), usage: { prompt_tokens: 10, completion_tokens: 50, total_tokens: 60 } })}\n\n`)
      response.end('data: [DONE]\n\n'); pendingText = undefined
    }
  })
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const endpoint = `http://127.0.0.1:${server.address().port}/v1`
const bootstrap = `(async()=>{
  await window.cogent.setCustomProviders([{id:'custom/file-test',name:'验收模型',baseUrl:${JSON.stringify(endpoint)},models:[],modelDefs:[{id:'file-test',reasoning:false,input:['text'],contextWindow:128000,maxTokens:4096}]}],[]);
  await window.cogent.setApiKey('custom/file-test','isolated-file-test');
  await window.cogent.saveSettings({activeProviderId:'custom/file-test',activeModelId:'file-test',thinkingLevel:'off'});
  const summary=await window.cogent.engineRequest('session.create',{title:'文件链接验收',cwd:${JSON.stringify(workspace)}});
  return summary.id;
})()`
const submit = sessionId => `(async()=>{
  const summary={id:${JSON.stringify(sessionId)}};
  const terminal=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{unsubscribe();reject(new Error('模型响应超时'))},30000);const unsubscribe=window.cogent.onEngineEvent(event=>{if(event.params.sessionId===summary.id&&(event.method==='run.completed'||event.method==='run.failed')){clearTimeout(timer);unsubscribe();if(event.method==='run.failed')reject(new Error(event.params.message));else resolve();}})});
  window.fileTestTerminal=terminal;
})()`
// 只读取失败现场，不触发测量重排请求或修复动作；各段限长，避免Office/高亮CSS淹没证据。
function fileFailureSnapshot() {
  const sample = (value, limit) => value.length <= limit ? value : value.slice(0, Math.floor(limit / 2)) + '…[truncated]…' + value.slice(-Math.floor(limit / 2))
  const geometry = node => {
    if (!node) return null
    const rect = node.getBoundingClientRect(), style = getComputedStyle(node)
    return {
      tag: node.tagName, id: node.id, class: String(node.className).slice(0, 600),
      data: { ...node.dataset }, hidden: node.hidden, inert: node.inert,
      rect: { x: rect.x, y: rect.y, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height },
      clientWidth: node.clientWidth, clientHeight: node.clientHeight, scrollWidth: node.scrollWidth, scrollHeight: node.scrollHeight, scrollTop: node.scrollTop, scrollLeft: node.scrollLeft,
      display: style.display, visibility: style.visibility, position: style.position, overflowX: style.overflowX, overflowY: style.overflowY,
      contentVisibility: style.contentVisibility, contain: style.contain, flex: style.flex, minWidth: style.minWidth, minHeight: style.minHeight,
      fontSize: style.fontSize, lineHeight: style.lineHeight
    }
  }
  const ancestors = node => {
    const result = []
    for (let current = node, index = 0; current && index < 14; current = current.parentElement, index++) result.push(geometry(current))
    return result
  }
  const panel = document.querySelector('[data-workspace-panel]:not([hidden])'), preview = panel?.querySelector('[data-file-preview]')
  const hosts = [...document.querySelectorAll('diffs-container')], panels = [...document.querySelectorAll('[data-workspace-panel]')]
  return {
    limits: { panelHtml: 12000, shadowHtml: 12000, preHtml: 4000, hosts: 24, panels: 64, ancestorDepth: 14 },
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, documentVisibility: document.visibilityState, documentScrollWidth: document.documentElement.scrollWidth },
    workspace: geometry(document.querySelector('[data-workspace]')),
    activeSelected: [...document.querySelectorAll('[aria-label="工作区标签页"] [role=tab][aria-selected=true]')].slice(0, 8).map(node => ({ ...geometry(node), selected: node.getAttribute('aria-selected'), controls: node.getAttribute('aria-controls'), label: node.getAttribute('aria-label'), text: node.textContent.slice(0, 300) })),
    panels: { count: panels.length, truncated: panels.length > 64, items: panels.slice(0, 64).map(node => geometry(node)) },
    activePanel: { node: geometry(panel), ancestors: ancestors(panel), html: sample(panel?.innerHTML ?? '', 12000) },
    filePanel: { node: geometry(preview), ancestors: ancestors(preview), text: sample(preview?.innerText ?? '', 2000), html: sample(preview?.innerHTML ?? '', 12000) },
    toolbar: [...document.querySelectorAll('[data-file-toolbar]')].slice(0, 4).map(node => ({ ...geometry(node), text: node.textContent.slice(0, 1000) })),
    codeScroll: [...(panel?.querySelectorAll('[data-code-scroll]') ?? [])].slice(0, 8).map(node => ({ node: geometry(node), ancestors: ancestors(node) })),
    diffs: { count: hosts.length, truncated: hosts.length > 24, items: hosts.slice(0, 24).map(node => {
      const root = node.shadowRoot, lines = [...(root?.querySelectorAll('[data-line]') ?? [])]
      return {
        host: geometry(node), ownerPanel: node.closest('[data-workspace-panel]')?.dataset.workspacePanel,
        ancestors: ancestors(node), hasShadowRoot: root !== null, lineCount: lines.length,
        lineSamples: lines.slice(0, 8).map(line => ({ line: line.getAttribute('data-line'), index: line.getAttribute('data-line-index'), text: line.textContent.slice(0, 300), geometry: geometry(line) })),
        shadowChildren: [...(root?.children ?? [])].slice(0, 12).map(child => ({ tag: child.tagName, data: { ...child.dataset }, length: child.outerHTML.length })),
        shadowHtmlLength: root?.innerHTML.length ?? 0, shadowHtml: sample(root?.innerHTML ?? '', 12000), preHtml: sample(root?.querySelector('pre')?.outerHTML ?? '', 4000)
      }
    }) }
  }
}
const driver = join(root, 'driver.mjs')
writeFileSync(driver, `
import { app, BrowserWindow, webContents, ipcMain } from 'electron';
import { writeFileSync } from 'node:fs';
app.setPath('userData', ${JSON.stringify(join(root, 'profile'))});
app.commandLine.appendSwitch('disable-gpu');
BrowserWindow.prototype.show = function() {};
const created = new Promise(resolve => app.once('browser-window-created', (_event,win) => resolve(win)));
const checks = [];
const errors = [];
const fileViewRequests = new Map(), fileViewLeases = new Map(), fileViewTrace = [];
let fileViewSequence = 0;
const fileViewRecord = entry => { fileViewTrace.push(entry); if(fileViewTrace.length>48)fileViewTrace.shift() };
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => originalHandle(channel, channel === 'fileViews:request' ? async(event,payload) => {
 const id=++fileViewSequence,started=performance.now(),params=payload.params??{};
 const entry={id,method:payload.method,leaseId:params.leaseId,operationId:params.operationId,sourceKind:params.source?.kind,target:String(params.source?.rawTarget??params.source?.path??'').slice(0,512)};
 fileViewRequests.set(id,entry);
 try {
  const result=await handler(event,payload);
  const descriptor=result?.descriptor;
  const summary=descriptor?{fileId:descriptor.fileId,name:descriptor.name,path:descriptor.path,kind:descriptor.kind,version:descriptor.version,location:descriptor.location}:undefined;
  if(payload.method==='fileViews.acquire'&&result?.leaseId)fileViewLeases.set(result.leaseId,{leaseId:result.leaseId,descriptor:summary});
  if(payload.method==='fileViews.release')fileViewLeases.delete(params.leaseId);
  fileViewRecord({...entry,durationMs:performance.now()-started,status:'fulfilled',descriptor:summary,textLength:typeof result?.text==='string'?result.text.length:undefined});
  return result;
 } catch(cause) {fileViewRecord({...entry,durationMs:performance.now()-started,status:'rejected',error:String(cause).slice(0,1500)});throw cause}
 finally {fileViewRequests.delete(id)}
}:handler);
let win;
const wait = async (condition, label, ms=30000) => {
 const end=Date.now()+ms; while(Date.now()<end) { if(await condition()) {checks.push(label); return} await new Promise(done=>setTimeout(done,50)); }
 throw new Error('超时：'+label);
};
const evaluate = source => win.webContents.executeJavaScript(source, true);
await import(${JSON.stringify(pathToFileURL(resolve('out/main/index.js')).href)});
void (async()=>{try {
 win = await created;
 win.webContents.on('console-message', (_event,level,message) => {if(level>=3) errors.push(message)});
 await new Promise(done=>win.webContents.once('did-finish-load',done));
 win.webContents.debugger.attach('1.3');
 await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
 await wait(()=>evaluate('typeof window.cogent === "object"'),'产品 preload 就绪');
 const sessionId=await evaluate(${JSON.stringify(bootstrap)});
 let loaded = new Promise(done=>win.webContents.once('did-finish-load',done));win.reload();await loaded;
 await wait(()=>evaluate('Array.from(document.querySelectorAll("header")).some(el=>el.innerText.includes("文件链接验收"))'),'目标聊天主体与历史水合');
 await wait(()=>evaluate('document.querySelector("[data-chat-session] textarea")?.disabled===false'),'目标聊天输入与草稿就绪');
 await wait(()=>evaluate('document.body.innerText.includes("file-test")'),'测试模型偏好水合');
 await evaluate('document.querySelector("textarea").focus()');await win.webContents.insertText('生成文件链接');
 await wait(()=>evaluate('document.querySelector("[aria-label=发送]")?.disabled===false'),'实际发送按钮就绪');
 await evaluate((${submit.toString()})(sessionId));
 await evaluate('document.querySelector("[aria-label=发送]").click()');
 await wait(()=>evaluate('Array.from(document.querySelectorAll("[data-chat-session] [data-file-link]")).some(el=>el.textContent==="sample.ts:2:3")'),'成功 read 后反引号在流式中可点击');
 if(await evaluate('Array.from(document.querySelectorAll("[data-chat-session] [data-file-link]")).find(el=>el.textContent==="sample.ts:2:3").querySelector("[data-file-icon]")?.dataset.fileIcon')!=='typescript')throw new Error('正文反引号文件没有使用Material图标');
 checks.push('正文反引号文件使用Material图标');
 if(!await evaluate('(()=>{const link=Array.from(document.querySelectorAll("[data-chat-session] [data-file-link]")).find(el=>el.textContent==="sample.ts:2:3");const label=link.querySelector("[data-file-link-label]");return !link.querySelector("code")&&getComputedStyle(label).backgroundColor==="rgba(0, 0, 0, 0)"})()'))throw new Error('正文文件链接仍带代码标签或底色');
 checks.push('正文反引号文件链接没有背景');
 await wait(()=>evaluate('document.querySelector(".md-body [data-file-link-label]")?.querySelectorAll("[data-reveal]").length>1'),'真实流式标签包含渐显片段');
 const labelGaps=await evaluate('(()=>{const label=document.querySelector(".md-body [data-file-link-label]");const rects=Array.from(label.querySelectorAll("[data-reveal]")).map(el=>el.getBoundingClientRect());return rects.slice(1).map((r,i)=>r.left-rects[i].right)})()');
 if(labelGaps.some(gap=>Math.abs(gap)>0.75))throw new Error('流式文件名出现额外片段间距：'+JSON.stringify(labelGaps));
 checks.push('流式文件名的实际片段间距正常');
 win.setSize(1500,900);
 await evaluate('document.querySelector("[aria-label=展开标签页区]")?.click()');
 await wait(()=>evaluate('!!document.querySelector("[aria-label=打开内置浏览器]")'),'真实流式期间工作区启动页可用');
 await evaluate('document.querySelector("[aria-label=打开内置浏览器]").click()');
 await wait(()=>evaluate('document.querySelector("[aria-label=网页地址或搜索]")?.disabled===false'),'流式期间浏览器就绪');
 const browserFixture=${JSON.stringify(endpoint + "/browser")};
 await evaluate('document.querySelector("[aria-label=网页地址或搜索]").focus()');
 await win.webContents.insertText(browserFixture);
 await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
 win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});win.webContents.sendInputEvent({type:'char',keyCode:'\\r'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
 await wait(()=>Promise.resolve(webContents.getAllWebContents().some(w=>w.getType()==='webview'&&w.getURL()===browserFixture)),'流式期间真实网页可导航');
 const streamGuest=webContents.getAllWebContents().find(w=>w.getType()==='webview'&&w.getURL()===browserFixture);
 await wait(()=>streamGuest.executeJavaScript('!!document.querySelector("#stream-form")'),'流式期间网页表单就绪');
 streamGuest.focus();await streamGuest.executeJavaScript('document.querySelector("#stream-form").focus()');await streamGuest.insertText('stream-kept');
 if(!await evaluate('!!document.querySelector("[aria-label=停止]")'))throw new Error('打开浏览器中断了Agent流式');
 checks.push('本地SSE持续时浏览器独立导航与输入，不中断Agent');
 await fetch(${JSON.stringify(endpoint + '/release')});await evaluate('window.fileTestTerminal');
 if(streamGuest.isDestroyed()||await streamGuest.executeJavaScript('document.querySelector("#stream-form").value')!=='stream-kept')throw new Error('流式完成重建了网页');
 checks.push('真实Agent流式完成后同guest表单仍保留');
 // 隐藏窗口不保证推进合成器时钟；显式完成已创建的有限渐显过渡，核对真正 static 管线。
 await wait(()=>evaluate('(()=>{for(const root of document.querySelectorAll("[data-slot=markdown-root]"))for(const animation of root.getAnimations({subtree:true}))if(animation instanceof CSSTransition&&(animation.transitionProperty==="opacity"||animation.transitionProperty==="color"))animation.finish();return !document.querySelector("[data-md-streaming=true]")})()'),'终态静态解析完成');
 await wait(()=>evaluate('Array.from(document.querySelectorAll("[data-chat-session] [data-file-link]")).some(el=>el.textContent==="sample.ts:2:3")'),'反引号终态仍可点击');
 await new Promise((resolve,reject)=>{
   const requestId='file-regression-reload';
   const timer=setTimeout(()=>{ipcMain.removeListener('workspace:flushed',listener);reject(new Error('重载前保存超时'))},5000);
   const listener=(event,payload)=>{if(event.sender!==win.webContents||payload.requestId!==requestId)return;clearTimeout(timer);ipcMain.removeListener('workspace:flushed',listener);if(payload.error)reject(new Error(payload.error));else resolve()};
   ipcMain.on('workspace:flushed',listener);win.webContents.send('workspace:flush',{requestId});
 });
 checks.push('测试主动重载前等待真实工作区事务提交');
 loaded = new Promise(done=>win.webContents.once('did-finish-load',done));win.reload();await loaded;
 await wait(()=>evaluate('document.querySelectorAll("[data-chat-session] [data-file-link]").length>=9'),'重载后正文文件链接水合');
 await wait(()=>evaluate('Array.from(document.querySelectorAll("[data-chat-session] [data-file-link]")).some(el=>el.textContent==="sample.ts:2:3")'),'重载后真实工具词表仍生效');
 await wait(()=>Promise.resolve(webContents.getAllWebContents().some(w=>w.getType()==='webview'&&w.getURL()===browserFixture)),'重载后浏览器和工作区宽度水合完成');
 await evaluate('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
 await evaluate('document.querySelector("[aria-label=收起工作区]").click()');
 await wait(()=>evaluate('document.querySelector("[data-workspace]")?.inert===true'),'真实工作区收起后释放正文空间');
 win.setSize(1500,900);
 await evaluate('Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async value=>{window.fileTestCopiedPath=value}}});undefined');
 await evaluate('window.filePointerEvents=[];for(const type of ["mousedown","mouseup","contextmenu"]){document.addEventListener(type,event=>window.filePointerEvents.push({type,target:event.target.outerHTML?.slice(0,250),x:event.clientX,y:event.clientY}),true)};undefined');
 const linkPoint=await evaluate('(()=>{const link=Array.from(document.querySelectorAll("[data-chat-session] [data-file-link]")).find(el=>el.textContent==="sample.ts:2:3");link.scrollIntoView({block:"center"});const r=link.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()');
 const move=point=>win.webContents.sendInputEvent({type:'mouseMove',...point});
 // 隐藏窗口显式推进浮层布局与有限入场动画，避免在旧浮层坐标上派发下一次点击。
 const settleTooltip=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{for(const tooltip of document.querySelectorAll("[role=tooltip]"))for(const animation of tooltip.getAnimations({subtree:true}))if(animation.effect.getTiming().iterations!==Infinity)animation.finish();resolve()})))');
 const press=async(point,button='left')=>{move(point);await settleTooltip();win.webContents.sendInputEvent({type:'mouseDown',...point,button,clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',...point,button,clickCount:1})};
 move(linkPoint);
 await wait(()=>evaluate('document.querySelector("[role=tooltip]")?.textContent.includes('+${JSON.stringify(JSON.stringify(join(workspace, 'sample.ts')))}+')'),'真实hover的Tooltip显示完整绝对路径');
 await settleTooltip();
 if(!await evaluate('(()=>{const tooltip=document.querySelector("[role=tooltip]");const button=tooltip.querySelector("button").getBoundingClientRect();const text=tooltip.querySelector("p").getBoundingClientRect();const icon=tooltip.querySelector("button svg").getBoundingClientRect();return Math.abs(button.top+button.height/2-text.top-text.height/2)<1&&icon.width>=parseFloat(getComputedStyle(document.documentElement).fontSize)-0.1})()'))throw new Error('Tooltip复制图标未放大或未垂直居中');
 checks.push('Tooltip复制图标放大并垂直居中');
 const copyPoint=await evaluate('(()=>{const r=document.querySelector("[role=tooltip] [aria-label=复制完整路径]").getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()');
 await press(copyPoint);
 await wait(()=>evaluate('window.fileTestCopiedPath==='+${JSON.stringify(JSON.stringify(join(workspace, 'sample.ts')))}),'实际指针可点击Tooltip复制路径');
 if(await evaluate('document.querySelector("[data-workspace-panel]:not([hidden]) [data-file-preview]")!==null'))throw new Error('复制Tooltip误打开文件预览');
 await press(await evaluate('(()=>{const r=Array.from(document.querySelectorAll("[data-chat-session] [data-file-link]")).find(el=>el.textContent==="sample.ts:2:3").getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()'),'right');
 await wait(()=>evaluate('document.querySelector("[role=menu]")?.innerText.includes("复制完整路径")'),'正文链接支持真实右键菜单');
 await evaluate('window.fileTestCopiedPath="";Array.from(document.querySelectorAll("[role=menuitem]")).find(el=>el.textContent==="复制完整路径").click()');
 await wait(()=>evaluate('window.fileTestCopiedPath==='+${JSON.stringify(JSON.stringify(join(workspace, 'sample.ts')))}),'右键菜单复制实际绝对路径');
 const click = async label => { await evaluate('Array.from(document.querySelectorAll("[data-chat-session] [data-file-link]")).find(el=>el.textContent==='+JSON.stringify(label)+').click()'); };
 const body = () => evaluate('(()=>{const root=document.querySelector("[data-workspace-panel]:not([hidden]) [data-file-preview]");return (root?.innerText??"")+Array.from(root?.querySelectorAll("diffs-container")??[]).flatMap(el=>Array.from(el.shadowRoot?.querySelectorAll("[data-line]")??[],line=>line.textContent??"")).join("")})()');
 await click('源码样本'); await wait(async()=> (await body()).includes('const second = 2'),'源码按真实文件读取');
 await wait(()=>evaluate('(()=>{const root=document.querySelector("[data-workspace-panel]:not([hidden]) [data-code-preview] diffs-container")?.shadowRoot;return !!root?.querySelector("[data-line]")&&!root.querySelector("[contenteditable=true],textarea")})()'),'Pierre实际源码只读');
 await evaluate('document.querySelector("[data-file-toolbar] [aria-label=文件操作]").click()');
 await wait(()=>evaluate('Array.from(document.querySelectorAll("[role=menuitem]")).some(el=>el.textContent==="文件信息")'),'全局文件工具行提供信息入口');
 await evaluate('Array.from(document.querySelectorAll("[role=menuitem]")).find(el=>el.textContent==="文件信息").click()');
 await wait(()=>evaluate('(()=>{const info=document.querySelector("[role=dialog]");return !!info&&info.querySelector("p.break-all")?.textContent.endsWith("sample.ts")&&info.textContent.includes("当前文件")})()'),'文件信息显示源码绝对路径和当前文件版本');
 await evaluate('document.querySelector("[role=dialog] [data-slot=dialog-close]").click()');
 await wait(()=>evaluate('!document.querySelector("[role=dialog]")'),'文件信息关闭后继续真实定位');
 for(const label of ['源码样本','片段行列样本','冒号片段样本','数字片段样本','sample.ts:2:3']){await click(label);await wait(async()=> (await body()).includes('已定位：第 2 行，第 3 列'),'实际预览行列：'+label);}
 await click('Markdown样本'); await wait(()=>evaluate('document.querySelector("[data-workspace-panel]:not([hidden]) [data-file-preview] img")?.naturalWidth>0'),'Markdown 本地图片依赖');
 await wait(async()=> (await body()).includes('外部资源未自动加载'),'外部资源隔离');
 await click('图片样本'); await wait(()=>evaluate('document.querySelector("[data-workspace-panel]:not([hidden]) [data-file-preview] img")?.naturalWidth>0'),'图片 Blob 预览');
 await click('PDF样本');
 await wait(()=>evaluate('(()=>{const c=document.querySelector("[data-workspace-panel]:not([hidden]) [data-file-preview] canvas");if(!c||!c.width)return false;const d=c.getContext("2d").getImageData(0,0,c.width,c.height).data;for(let i=0;i<d.length;i+=32)if(d[i+3]>0&&d[i]<230)return true;return false})()'),'PDF.js 真实页面绘制');
 await click('Word样本');await wait(()=>evaluate('!!document.querySelector("[data-workspace-panel]:not([hidden]) [data-docx-document] section")'),'Word真实纸张预览');
 await click('表格样本');await wait(()=>evaluate('!!document.querySelector("[data-workspace-panel]:not([hidden]) [data-xlsx-preview] canvas")'),'XLSX实际网格画布');
 await click('幻灯片样本');await wait(()=>evaluate('!!document.querySelector("[data-workspace-panel]:not([hidden]) [data-pptx-ready=true]")'),'PPTX实际幻灯片');
 await click('音频样本');await wait(()=>evaluate('document.querySelector("[data-workspace-panel]:not([hidden]) [data-file-preview] audio")?.readyState>=1'),'WAV 音频加载');
 await click('目录样本');await wait(async()=> (await body()).includes('目录可在文件管理器中打开'),'目录动作入口');
 await click('源码样本');await wait(async()=> (await body()).includes('const second = 2'),'重新打开源码');
 const sourceTab=await evaluate('document.querySelector("[data-workspace-panel]:not([hidden]) [data-file-preview]").dataset.fileTabId');
 for(const zoom of [1,1.25,1.5]) {
  win.webContents.setZoomFactor(zoom);win.setSize(1500,900);
  await wait(()=>evaluate('!matchMedia("(max-width:760px)").matches&&document.querySelector("[data-workspace]")?.inert===false'),'放宽恢复原文件工作区开态 '+zoom);
  win.setSize(400,750);
  await wait(()=>evaluate('document.querySelector("[data-workspace]")?.inert===true&&document.querySelector("[data-sidebar-clip]")?.inert===true&&document.querySelector("[data-sidebar-clip]").getBoundingClientRect().width<1&&document.querySelector("[aria-label=展开侧边栏]")?.disabled===true'),'400px及缩放左右侧栏同步自动收起 '+zoom);
  await evaluate('document.querySelector("[aria-label=展开标签页区]").click()');
  await wait(()=>evaluate('(()=>{const panel=document.querySelector("[data-workspace][data-workspace-mode=split] [data-workspace-panel]:not([hidden]) [data-file-preview]"),chat=document.querySelector("[data-workspace-frame]")?.firstElementChild;return !!panel&&!!chat&&!chat.inert&&chat.closest("[inert]")===null})()'),'400px及缩放保持并排且聊天可交互 '+zoom);
  if(await evaluate('document.querySelector("[data-workspace-panel]:not([hidden]) [data-file-preview]")?.dataset.fileTabId')!==sourceTab)throw new Error('自动收起/重开改变了原文件标签');
  await wait(async()=> (await body()).includes('const second = 2'),'自动收起后原源码真实渲染保留 '+zoom);
  await evaluate('document.querySelector("[aria-label=展开工作区]").click()');
  await wait(()=>evaluate('document.querySelector("[data-workspace]")?.dataset.workspaceMode==="expanded"&&document.querySelector("[data-workspace-frame]")?.firstElementChild.inert===true'),'窄窗仅手动占满时禁用聊天 '+zoom);
  await evaluate('document.querySelector("[aria-label=恢复并排]").click()');
  await wait(()=>evaluate('document.querySelector("[data-workspace]")?.dataset.workspaceMode==="split"&&document.querySelector("[data-workspace-frame]")?.firstElementChild.inert===false'),'恢复并排重新开放聊天 '+zoom);
 }
 win.webContents.setZoomFactor(1);win.setSize(1500,900);
 await wait(()=>evaluate('!!document.querySelector("[data-workspace][data-workspace-mode=split] [data-workspace-panel]:not([hidden]) [data-file-preview]")'),'宽窗右栏恢复');
 await wait(()=>evaluate('!document.querySelector("[role=dialog]")'),'宽窗无残留 Dialog 遮挡');
 await wait(()=>evaluate('(()=>{const el=document.querySelector("[data-home-tabs] [data-workspace-panel]:not([hidden]) [data-file-preview]");if(!el)return false;const r=el.getBoundingClientRect();return r.width>200&&r.left>=0&&r.right<=innerWidth+1})()'),'宽窗预览位于可见视口');
 const layout=await evaluate('(()=>{const rows=[];let el=document.querySelector("[data-home-tabs] [data-workspace-panel]:not([hidden]) [data-file-preview]");for(let i=0;el&&i<6;i++,el=el.parentElement){const r=el.getBoundingClientRect();rows.push({tag:el.tagName,slot:el.dataset.slot,x:r.x,width:r.width,style:el.getAttribute("style")})}return rows})()');
 await win.webContents.capturePage();
 await new Promise(done=>setTimeout(done,150));
 await win.webContents.capturePage().then(image=>writeFileSync(${JSON.stringify(join(evidence, 'preview.png'))},image.toPNG()));
 const closingTab=await evaluate('document.querySelector("[data-workspace-panel]:not([hidden])").dataset.workspacePanel');
 await evaluate('(()=>{const id=document.querySelector("[data-workspace-panel]:not([hidden])").dataset.workspacePanel;document.getElementById("workspace-tab-"+id).nextElementSibling.click()})()');
 await wait(()=>evaluate('!Array.from(document.querySelectorAll("[data-workspace-panel]")).some(panel=>panel.dataset.workspacePanel==='+JSON.stringify(closingTab)+')'),'关闭仅释放目标文件标签');
 const result={passed:true,electron:process.versions.electron,chromium:process.versions.chrome,checks,errors,layout};
 writeFileSync(${JSON.stringify(join(evidence, 'result.json'))},JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
} catch(error) {
 const diagnostics={failedAfter:checks.at(-1),fileViews:{inFlightCount:fileViewRequests.size,inFlight:[...fileViewRequests.values()].slice(0,24),leaseCount:fileViewLeases.size,leases:[...fileViewLeases.values()].slice(0,32),recent:fileViewTrace}};
 if(win&&!win.isDestroyed()){
  try {await win.webContents.capturePage().then(image=>writeFileSync(${JSON.stringify(join(evidence, 'failure.png'))},image.toPNG()))}catch(cause){diagnostics.captureError=String(cause)}
  diagnostics.dom=await evaluate(${JSON.stringify('(' + fileFailureSnapshot.toString() + ')()')}).catch(cause=>({error:String(cause)}));
  errors.push(await evaluate('(document.querySelector("[data-workspace-panel]:not([hidden]) [data-file-preview]")?.innerText??"").slice(0,4000)').catch(()=>''));
  errors.push(await evaluate('(document.querySelector("[data-workspace-panel]:not([hidden]) [data-file-preview]")?.innerHTML??"").slice(0,12000)').catch(()=>''));
  errors.push(await evaluate('JSON.stringify({pointer:window.filePointerEvents?.slice(-24),roots:Array.from(document.querySelectorAll("[data-slot=markdown-root]")).slice(0,16).map(root=>({streaming:root.dataset.mdStreaming,text:root.textContent.slice(0,200),animations:root.getAnimations({subtree:true}).slice(0,8).map(a=>({type:a.constructor.name,property:a.transitionProperty,state:a.playState}))}))})').catch(()=>''));
 }
 const result={passed:false,checks,errors,error:String(error),stack:error.stack,diagnostics};writeFileSync(${JSON.stringify(join(evidence, 'result.json'))},JSON.stringify(result,null,2));console.error(result);
} finally {app.quit();}})();
`)
let child
try {
  const env = { ...process.env, COGENT_HOME: home, USERPROFILE: home, HOME: home }
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  child = spawn(electron, [driver], { cwd: process.cwd(), stdio: 'inherit', windowsHide: true, env })
  const exitCode = await new Promise((done, fail) => { child.once('error', fail); child.once('exit', done) })
  if (exitCode !== 0) throw new Error('文件 Electron 驱动异常退出：'+exitCode)
  const result = existsSync(join(evidence, 'result.json')) ? JSON.parse(readFileSync(join(evidence, 'result.json'), 'utf8')) : { passed: false }
  process.exitCode = result.passed ? 0 : 1
} finally {
  if (child && child.exitCode === null) child.kill()
  pendingText?.destroy()
  await new Promise(done => server.close(done))
  // root 只来自本脚本 mkdtemp；不接受外部传入的删除路径。
  if (!root.startsWith(join(tmpdir(), 'cogent-file-electron-'))) throw new Error('临时目录边界错误')
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
