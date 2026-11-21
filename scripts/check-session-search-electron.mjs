/** 真产品搜索验收：隔离磁盘语料、实际 Command/IPC/worker、过程展开与原文高亮。 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import electron from 'electron'

const root = mkdtempSync(join(tmpdir(), 'cogent-search-electron-'))
const home = join(root, 'home'), evidence = resolve('tmp/session-search-electron')
mkdirSync(join(home, 'sessions'), { recursive: true }); mkdirSync(evidence, { recursive: true })
// 异常退出不能复用上轮通过记录，本轮证据必须由本轮进程产生。
rmSync(join(evidence, 'result.json'), { force: true })
writeFileSync(join(home, 'settings.json'), JSON.stringify({ version: 1, closeBehavior: 'quit', soundEnabled: false, toastEnabled: false }))
const id = randomUUID(), projectId = randomUUID(), transcript = []
mkdirSync(join(home, 'projects'))
writeFileSync(join(home, 'projects', `${projectId}.json`), JSON.stringify({ version: 2, summary: { id: projectId, name: 'Cogent-测试', cwds: [root], createdAt: 1 } }))
for (const [index, title] of ['推荐架构图绘制工具', '编写设置页搜索实施文档', '调整工作时长显示格式', '调整工具分类与执行状态命名', '回应问候'].entries()) {
  const recentId = randomUUID()
  writeFileSync(join(home, 'sessions', `${recentId}.json`), JSON.stringify({ version: 1, summary: { id: recentId, title, createdAt: 1, updatedAt: 1, cwd: root, ...(index < 4 && { projectId }) }, transcript: [] }))
}
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
const assistant = (text, timestamp, calls = []) => ({ role: 'assistant', api: 'openai-completions', provider: 'test', model: 'test', timestamp, stopReason: 'stop', usage, content: [{ type: 'text', text }, ...calls] })
for (let i = 0; i < 40; i++) {
  const timestamp = 1000 + i * 10
  transcript.push({ role: 'user', content: `历史问题 ${i}`, timestamp })
  if (i === 3) {
    transcript.push(assistant('过程正文含有 **needlehistory**，需要先展开再定位。', timestamp + 1, [{ type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'file.txt' } }]))
    transcript.push({ role: 'toolResult', toolCallId: 'call', toolName: 'read', content: [{ type: 'text', text: '文件输出' }], isError: false, timestamp: timestamp + 2 })
  }
  transcript.push(assistant(`第 ${i} 轮最终回答。` + '布局占位文本。'.repeat(20), timestamp + 3))
}
const source = join(home, 'sessions', `${id}.json`)
const original = JSON.stringify({ version: 1, summary: { id, title: '调研 Cogent 会话搜索', createdAt: 1, updatedAt: 2, cwd: root, projectId }, transcript })
writeFileSync(source, original)
const spec = { root, home, evidence, id, entry: pathToFileURL(resolve('out/main/index.js')).href }
const driver = join(root, 'driver.mjs')
writeFileSync(driver, `const spec=${JSON.stringify(spec)};
` + String.raw`
import { app, BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
app.setPath('userData',join(spec.root,'profile'));
BrowserWindow.prototype.show=function(){};
const created=new Promise(done=>app.once('browser-window-created',(_event,win)=>win.webContents.once('did-finish-load',()=>done(win))));
const checks=[],errors=[];let win;
const evaluate=source=>win.webContents.executeJavaScript(source,true);
const capture=async name=>{await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');await win.webContents.capturePage();await new Promise(done=>setTimeout(done,200));await win.webContents.capturePage().then(image=>writeFileSync(join(spec.evidence,name),image.toPNG()))};
const wait=async(condition,label)=>{const end=Date.now()+25000;while(Date.now()<end){if(await condition()){checks.push(label);console.log('[验收] '+label);return}await new Promise(done=>setTimeout(done,50))}throw new Error('超时：'+label)};
await import(spec.entry);
void(async()=>{try{
 win=await created;win.webContents.setBackgroundThrottling(false);win.setMinimumSize(400,500);win.setSize(1200,850);win.webContents.on('console-message',details=>{if(details.level==='error')errors.push(details.message)});
 // 多会话的初始选中不承诺排序；从真实侧栏明确打开本次语料，不依赖文件枚举顺序。
 await wait(()=>evaluate('Array.from(document.querySelectorAll("button")).some(el=>el.textContent==="调研 Cogent 会话搜索")'),'临时聊天在侧栏可见');
 await evaluate('Array.from(document.querySelectorAll("button")).find(el=>el.textContent==="调研 Cogent 会话搜索").click()');
 await wait(()=>evaluate('document.querySelector("[data-chat-session]")?.dataset.chatSession==='+JSON.stringify(spec.id)),'历史聊天通过产品桥接加载');
 await evaluate('document.querySelector("[aria-label=搜索]").click()');
 await wait(()=>evaluate('document.activeElement?.getAttribute("cmdk-input")!==null&&document.activeElement?.tagName==="INPUT"'),'搜索打开并自动聚焦');
 await wait(()=>evaluate('document.querySelectorAll("[cmdk-item]").length===6&&Array.from(document.querySelectorAll("[cmdk-item]")).every(el=>!el.textContent.includes("未归类")&&!el.textContent.includes("1970")&&el.querySelector(".text-muted-foreground")?.textContent!=="1970/1/1")&&!document.querySelector("[data-slot=dialog-content][data-open]").textContent.includes("标题与聊天正文")'),'未搜索列表仅标题与实际项目名，无未归类、日期和右下角文案');
 await wait(()=>evaluate('document.querySelector("[aria-label=搜索项目]")===null&&document.querySelector("[data-slot=dialog-content] [role=checkbox]")===null'),'搜索浮层没有项目筛选或包含归档控件');
 const itemMetrics={};
 const readItem=()=>evaluate('(()=>{const item=document.querySelector("[cmdk-item]"),style=getComputedStyle(item),probe=document.createElement("span");probe.style.position="absolute";probe.style.color="var(--primary)";document.body.append(probe);const primary=getComputedStyle(probe).color;probe.style.color="var(--muted-foreground)";const muted=getComputedStyle(probe).color;probe.remove();return {color:style.color,titleColor:getComputedStyle(item.querySelector("span")).color,iconColor:getComputedStyle(item.querySelector("svg")).color,primary,muted,hovered:item.matches(":hover"),paddingLeft:parseFloat(style.paddingLeft),paddingRight:parseFloat(style.paddingRight),paddingTop:parseFloat(style.paddingTop),paddingBottom:parseFloat(style.paddingBottom)}})()');
 win.webContents.sendInputEvent({type:'mouseMove',x:5,y:5});
 await wait(async()=>{const state=itemMetrics.default=await readItem();return !state.hovered&&state.color===state.muted&&state.titleColor===state.muted&&state.iconColor===state.muted&&state.paddingLeft>=12&&state.paddingRight>=12&&state.paddingTop>=10&&state.paddingBottom>=10},'默认项的文字和图标为次要色，内边距为左右 12px、上下 10px');
 await capture('recent.png');
 const itemBounds=await evaluate('(()=>{const bounds=document.querySelector("[cmdk-item]").getBoundingClientRect();return {x:Math.round(bounds.left+bounds.width/2),y:Math.round(bounds.top+bounds.height/2)}})()');
 win.webContents.sendInputEvent({type:'mouseMove',...itemBounds});
 await wait(async()=>{const state=itemMetrics.hover=await readItem();return state.hovered&&state.color===state.primary&&state.titleColor===state.primary&&state.iconColor===state.primary},'hover 时文字和图标一起变为主色');
 await capture('hover.png');
 win.webContents.sendInputEvent({type:'mouseMove',x:5,y:5});
 await wait(async()=>{const state=itemMetrics.leave=await readItem();return !state.hovered&&state.color===state.muted&&state.iconColor===state.muted},'鼠标离开后恢复次要文字色');
 await win.webContents.insertText('needlehistory');
 await wait(()=>evaluate('(()=>{const spinner=document.querySelector("[data-slot=spinner][aria-label=正在搜索]");if(!spinner)return false;const bounds=spinner.getBoundingClientRect(),body=spinner.parentElement.getBoundingClientRect();window.searchMetrics={loadingHeight:document.querySelector("[data-slot=dialog-content][data-open]").offsetHeight,spinnerOffsetX:Math.abs(bounds.left+bounds.width/2-body.left-body.width/2),spinnerOffsetY:Math.abs(bounds.top+bounds.height/2-body.top-body.height/2)};return window.searchMetrics.spinnerOffsetX<1&&window.searchMetrics.spinnerOffsetY<1})()'),'搜索中 spinner 在固定结果区域居中');
 await wait(()=>evaluate('Array.from(document.querySelectorAll("[cmdk-item]")).some(el=>el.textContent.includes("needlehistory"))'),'正文命中摘要经实际 Host/worker 返回');
 await wait(()=>evaluate('document.querySelector("[cmdk-group-heading]")?.textContent==="聊天"&&document.querySelectorAll("[cmdk-item]").length===1'),'聊天分区每个会话仅一项，摘要在聊天行内');
 await wait(()=>evaluate('(()=>{const mark=getComputedStyle(document.querySelector("[cmdk-item] .search-mark"));return mark.color===getComputedStyle(document.querySelector("[cmdk-item]")).color&&mark.backgroundColor==="rgba(0, 0, 0, 0)"&&Number(mark.fontWeight)>=600})()'),'命中标记继承文字色、背景透明并加粗');
 await wait(()=>evaluate('(()=>{window.searchMetrics.resultHeight=document.querySelector("[data-slot=dialog-content][data-open]").offsetHeight;return Math.abs(window.searchMetrics.resultHeight-window.searchMetrics.loadingHeight)<1})()'),'结果与加载占位保持相同弹窗高度');
 await capture('search.png');
 await evaluate('Array.from(document.querySelectorAll("[cmdk-item]")).find(el=>el.textContent.includes("needlehistory")).click()');
 await wait(()=>evaluate('document.querySelector("[data-slot=dialog-content][data-open]")===null'),'选择结果关闭搜索浮层');
 await wait(()=>evaluate('CSS.highlights.get("cogent-search")?.size>0'),'选择摘要后原文高亮');
 await wait(()=>evaluate('Array.from(document.querySelectorAll("[data-search-message]")).some(el=>el.textContent.includes("needlehistory")&&el.closest("[hidden]")===null&&el.getBoundingClientRect().top>0&&el.getBoundingClientRect().top<innerHeight)'),'收起的过程正文展开且滚入视口');
 await capture('located.png');
 await evaluate('document.querySelector("[aria-label=关闭搜索高亮]").click()');
 await wait(()=>evaluate('!CSS.highlights.has("cogent-search")'),'关闭高亮释放 CSS 范围');
 // 侧栏折叠时仍可通过实际键盘入口打开。
 win.setSize(500,800);
 await wait(()=>evaluate('innerWidth<760&&document.querySelector("[data-sidebar-clip]")?.getBoundingClientRect().width===0'),'窄窗侧栏自动折叠');
 await evaluate('document.querySelector("textarea").focus();window.addEventListener("keydown",event=>{window.searchLastKey={key:event.key,ctrl:event.ctrlKey,prevented:event.defaultPrevented}})');win.webContents.focus();
 win.webContents.sendInputEvent({type:'keyDown',keyCode:'K',modifiers:['control']});
 win.webContents.sendInputEvent({type:'keyUp',keyCode:'K',modifiers:['control']});
 await wait(()=>evaluate('document.querySelector("[data-slot=dialog-content][data-open] [cmdk-input]")!==null'),'窄窗快捷键打开搜索');
 await capture('narrow.png');
 const result={passed:errors.length===0,checks,errors,metrics:{...await evaluate('window.searchMetrics'),items:itemMetrics},electron:process.versions.electron};writeFileSync(join(spec.evidence,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){if(win&&!win.isDestroyed())await win.webContents.capturePage().then(image=>writeFileSync(join(spec.evidence,'failure.png'),image.toPNG()));const result={passed:false,checks,errors,error:String(error),stack:error.stack};writeFileSync(join(spec.evidence,'result.json'),JSON.stringify(result,null,2));console.error(result)}finally{app.quit()}})();
`)
let child
try {
  const env = { ...process.env, COGENT_HOME: home, USERPROFILE: home, HOME: home }
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  child = spawn(electron, [driver], { cwd: process.cwd(), stdio: 'inherit', windowsHide: true, env })
  await new Promise((done, fail) => { child.once('error', fail); child.once('exit', done) })
  const result = existsSync(join(evidence, 'result.json')) ? JSON.parse(readFileSync(join(evidence, 'result.json'), 'utf8')) : { passed: false }
  if (readFileSync(source, 'utf8') !== original) { result.passed = false; result.error = '搜索修改了旧转录文件' }
  writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2))
  process.exitCode = result.passed ? 0 : 1
} finally {
  if (child && child.exitCode === null) child.kill()
  if (!root.startsWith(join(tmpdir(), 'cogent-search-electron-'))) throw new Error('临时目录越界')
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
