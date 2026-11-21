/** 真 Electron 产品链：输入→工具→正式卡→字节预览→原生动作→进程重启。 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import electron from 'electron'
const root = mkdtempSync(join(tmpdir(), 'cogent-outputs-electron-'))
const home = join(root, 'home'), workspace = join(root, 'workspace'), evidence = resolve('tmp/outputs-electron')
for (const dir of [home, workspace, evidence]) mkdirSync(dir, { recursive: true })
writeFileSync(join(home, 'settings.json'), JSON.stringify({ version: 1, closeBehavior: 'quit', soundEnabled: false, toastEnabled: false }))
writeFileSync(join(workspace, '说明.md'), '# 交付说明\n\n![随附图片](picture.png)\n\n[未保存依赖](missing.txt)\n\n[交付报告](' + encodeURIComponent('报告 #%.txt') + ')')
copyFileSync(resolve('reference/pi/packages/ai/test/data/red-circle.png'), join(workspace, 'picture.png'))
writeFileSync(join(workspace, 'data.zip'), 'zip bytes')
const report = paths => ({ tool: 'report_outputs', args: { deliverables: paths.map(path => ({ path, note: '用户交付文件' })) } })
let actions = [{ tool: 'write', args: { path: '报告 #%.txt', content: '申报时A' } }, report(['报告 #%.txt', '说明.md', 'picture.png', 'data.zip']), { tool: 'write', args: { path: '报告 #%.txt', content: '最终交付B' } }, { text: '完成，交付文件见下方。`报告 #%.txt`', hold: true }]
let finish, pending, call = 0
const server = createServer((request, response) => {
  if (request.url === '/release') { finish(); response.end('ok'); return }
  if (request.url === '/clear') { actions = [report(['data.zip']), report(['missing.txt']), report([]), { text: '已撤回交付' }]; response.end('ok'); return }
  request.resume(); request.on('end', () => {
    const action = actions.shift()
    if (!action) { response.writeHead(500); response.end('未计划的模型请求'); return }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const frame = (delta, finish_reason) => ({ id: 'outputs-test', object: 'chat.completion.chunk', created: 0, model: 'outputs-test', choices: [{ index: 0, delta, finish_reason }] })
    if (action.tool) {
      response.write(`data: ${JSON.stringify(frame({ role: 'assistant', tool_calls: [{ index: 0, id: 'output-call-' + ++call, type: 'function', function: { name: action.tool, arguments: JSON.stringify(action.args) } }] }, null))}\n\n`)
      response.write(`data: ${JSON.stringify(frame({}, 'tool_calls'))}\n\n`); response.end('data: [DONE]\n\n'); return
    }
    response.write(`data: ${JSON.stringify(frame({ role: 'assistant', content: action.text }, null))}\n\n`)
    const complete = () => { response.write(`data: ${JSON.stringify({ ...frame({}, 'stop'), usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`); response.end('data: [DONE]\n\n'); pending = undefined }
    if (action.hold) { pending = response; finish = complete } else complete()
  })
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const endpoint = `http://127.0.0.1:${server.address().port}`
const spec = { home, workspace, evidence, root, endpoint, entry: pathToFileURL(resolve('out/main/index.js')).href }
const driver = join(root, 'driver.mjs')
writeFileSync(driver, `const spec=${JSON.stringify(spec)};\n` + String.raw`
import { app, BrowserWindow, shell, dialog } from 'electron';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
app.setPath('userData',join(spec.root,'profile'));app.commandLine.appendSwitch('disable-gpu');
BrowserWindow.prototype.show=function(){};
const phase=process.env.OUTPUT_PHASE, checks=[],errors=[],opened=[];
const saved=join(spec.root,'另存结果.txt');
shell.openPath=async path=>{opened.push(path);return ''};
dialog.showSaveDialog=async()=>({canceled:false,filePath:saved});
const created=new Promise(done=>app.once('browser-window-created',(_event,win)=>{win.webContents.once('did-finish-load',()=>done(win));win.webContents.on('did-fail-load',(_event,code,text)=>console.error('[load]',code,text));win.webContents.on('render-process-gone',(_event,details)=>console.error('[driver] renderer gone',details))}));
let win;
const evaluate=source=>win.webContents.executeJavaScript(source,true);
const wait=async(condition,label)=>{const end=Date.now()+30000;while(Date.now()<end){if(await condition()){checks.push(label);console.log('[验收] '+label);return}await new Promise(done=>setTimeout(done,50))}throw new Error('超时：'+label)};
const content=()=>evaluate('document.querySelector("[data-file-preview]")?.innerText??""');
const clickPreview=async name=>evaluate('Array.from(document.querySelectorAll("[data-output-card]")).find(card=>card.innerText.includes('+JSON.stringify(name)+')).querySelector("button").click()');
const clickOutputMenu=async name=>evaluate('Array.from(document.querySelectorAll("[data-output-card]")).find(card=>card.innerText.includes('+JSON.stringify(name)+')).querySelector("[aria-haspopup=menu]").click()');
const reload=async()=>{const loaded=new Promise(done=>win.webContents.once('did-finish-load',done));win.reload();await loaded};
const send=async text=>{
 await wait(()=>evaluate('document.querySelector("[data-chat-session] textarea")?.disabled===false'),'目标聊天实际输入框就绪');
 await evaluate('document.querySelector("textarea").focus()');await win.webContents.insertText(text);
 await wait(()=>evaluate('document.querySelector("[aria-label=发送]")?.disabled===false'),'实际发送按钮就绪');
 await evaluate('window.outputTerminal=new Promise(resolve=>{const un=window.cogent.onEngineEvent(e=>{if(e.method==="run.completed"||e.method==="run.failed"){un();resolve(e)}})});undefined');
 await evaluate('document.querySelector("[aria-label=发送]").click()');
};
await import(spec.entry);
void(async()=>{try{
 win=await created;win.setSize(1500,900);win.webContents.on('console-message',(_event,level,message)=>{if(level>=3)errors.push(message)});
 await wait(()=>evaluate('typeof window.cogent==="object"'),'产品preload就绪');
 if(phase==='first'){
  await evaluate('(async()=>{await window.cogent.setCustomProviders([{id:"custom/outputs-test",name:"产物验收模型",baseUrl:'+JSON.stringify(spec.endpoint+'/v1')+',models:[],modelDefs:[{id:"outputs-test",reasoning:false,input:["text"],contextWindow:128000,maxTokens:4096}]}],[]);await window.cogent.setApiKey("custom/outputs-test","isolated-key");await window.cogent.saveSettings({activeProviderId:"custom/outputs-test",activeModelId:"outputs-test",thinkingLevel:"off"});await window.cogent.engineRequest("session.create",{title:"产物卡片验收",cwd:'+JSON.stringify(spec.workspace)+',permissionMode:"auto"})})()');
  await reload();
 }
 await wait(()=>evaluate('Array.from(document.querySelectorAll("header")).some(el=>el.innerText.includes("产物卡片验收"))'),'目标聊天主体恢复');
 if(phase==='first'){
  await wait(()=>evaluate('document.body.innerText.includes("outputs-test")'),'模型设置水合');await send('生成并交付测试文件');
  await wait(()=>evaluate('document.querySelector("[data-md-streaming=true]")?.innerText.includes("交付文件")'),'真实终答流仍在输出');
  if(await evaluate('document.querySelectorAll("[data-output-card]").length')!==0)throw new Error('流式期间提前显示正式卡');checks.push('申报成功但流式未结束时无正式卡');
  await fetch(spec.endpoint+'/release');await evaluate('window.outputTerminal');
 }
 await wait(()=>evaluate('document.querySelectorAll("[data-output-card]").length===3'),'正式卡首屏显示三项');
 await evaluate('Array.from(document.querySelectorAll("button")).find(el=>el.innerText.includes("展开其余")).click()');
 await wait(()=>evaluate('document.querySelectorAll("[data-output-card]").length===4'),'展开后四项完整可见');
 if(await evaluate('Array.from(document.querySelectorAll("[data-output-card] [data-file-icon]")).map(icon=>icon.dataset.fileIcon).join(",")')!=='document,markdown,image,zip')throw new Error('产物文件图标未按类型匹配');
 checks.push('产物使用Material文件类型图标');
 if(!await evaluate('Array.from(document.querySelectorAll("[data-output-card] [data-file-icon]")).every(icon=>getComputedStyle(icon.parentElement).backgroundColor==="rgba(0, 0, 0, 0)")'))throw new Error('产物图标仍有背景');
 checks.push('产物图标不加背景');
 await evaluate('Promise.all(Array.from(document.querySelectorAll("[data-file-icon]")).map(icon=>new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>image.naturalWidth>0?resolve():reject(new Error("图标无尺寸"));image.onerror=()=>reject(new Error("图标资源加载失败："+icon.dataset.fileIcon));image.src=getComputedStyle(icon).backgroundImage.slice(5,-2)})))');
 checks.push('打包后本地图标资源可实际解码');
 if(!await evaluate('Array.from(document.querySelectorAll("[data-output-card]")).every(card=>card.querySelectorAll("button").length===2&&!/字节|用户交付文件|已保存交付副本|另存为/.test(card.innerText))'))throw new Error('正常文件行仍有冗余信息或独立动作');
 checks.push('文件行只常显名称、类型与打开组合钮');
 if(phase==='first'){
  await clickOutputMenu('报告 #%.txt');await wait(()=>evaluate('document.querySelector("[role=menu]")?.innerText.includes("另存为")'),'另存与原件动作收进下拉菜单');
  await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true}).then(image=>writeFileSync(join(spec.evidence,'file-menu.png'),image.toPNG()));
  await clickOutputMenu('报告 #%.txt');await wait(()=>evaluate('document.querySelector("[role=menu]")===null'),'下拉菜单可以关闭');
 }
 await clickPreview('报告 #%.txt');await wait(async()=>(await content()).includes('最终交付B'),'默认预览交付最终字节B');
 await wait(async()=>(await content()).includes('交付副本'),'预览明确标交付版本');
 if(phase==='first'){
  writeFileSync(join(spec.workspace,'报告 #%.txt'),'当前原件C');rmSync(join(spec.workspace,'picture.png'));
  await clickPreview('说明.md');await wait(()=>evaluate('document.querySelector("[data-file-preview] img")?.naturalWidth>0'),'删除原图后Markdown仍使用同清单副本');
  await evaluate('Array.from(document.querySelectorAll("[data-file-preview] [data-file-link]")).find(el=>el.textContent==="未保存依赖").click()');
  await wait(async()=>(await content()).includes('依赖未保存'),'未随附内链明确报依赖未保存');
  await clickPreview('说明.md');await wait(()=>evaluate('document.querySelector("[data-file-preview] img")?.naturalWidth>0'),'重新打开交付Markdown');
  await evaluate('Array.from(document.querySelectorAll("[data-file-preview] [data-file-link]")).find(el=>el.textContent==="交付报告").click()');
  await wait(async()=>(await content()).includes('最终交付B'),'交付Markdown内链打开同清单字节');
  await evaluate('Array.from(document.querySelectorAll("[data-file-preview] button")).find(el=>el.textContent==="重新加载").click()');
  await wait(async()=>(await content()).includes('最终交付B'),'交付内链子预览可以重新加载');
  await clickPreview('报告 #%.txt');await wait(async()=>(await content()).includes('最终交付B'),'原件改为C后交付仍为B');
  const descriptor=await evaluate('(async()=>{const sessions=await window.cogent.engineRequest("session.list",{});const [doc]=await window.cogent.engineRequest("outputs.get",{sessionId:sessions[0].id});const item=doc.published.find(item=>item.name==="报告 #%.txt");return window.cogent.engineRequest("outputs.resolve",{sessionId:doc.sessionId,turnId:doc.turnId,revision:doc.revision,outputId:item.outputId,version:"delivery"})})()');
  const handle={sessionId:descriptor.delivery.target.sessionId,fileId:descriptor.fileId};
  await evaluate('window.cogent.fileAction('+JSON.stringify({...handle,action:'save'})+')');
  if(readFileSync(saved,'utf8')!=='最终交付B')throw new Error('另存没有使用交付字节');checks.push('实际主进程另存动作取交付字节');
  await evaluate('window.cogent.fileAction('+JSON.stringify({...handle,action:'open'})+')');writeFileSync(opened.at(-1),'外部编辑');
  await clickPreview('报告 #%.txt');await wait(async()=>(await content()).includes('最终交付B'),'外部打开导出副本，改写不会损坏交付版本');
  rmSync(join(spec.workspace,'报告 #%.txt'));
  await clickOutputMenu('报告 #%.txt');await wait(()=>evaluate('document.querySelector("[role=menu]")!==null'),'原件删除后仍能打开文件菜单');
  await evaluate('Array.from(document.querySelectorAll("[role=menuitem]")).find(el=>el.textContent==="编辑当前原文件").click()');
  await wait(()=>evaluate('document.querySelector("[role=alertdialog]")?.innerText.includes("ENOENT")'),'编辑已删除原件使用错误弹窗');
  if(await evaluate('Array.from(document.querySelectorAll("[data-output-card]")).some(card=>card.innerText.includes("ENOENT"))'))throw new Error('操作错误仍插进文件行');
  checks.push('操作错误不插进文件行');
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))');
  await evaluate('Array.from(document.querySelectorAll("[role=alertdialog] button")).find(el=>el.textContent==="知道了").click()');
  await wait(()=>evaluate('document.querySelector("[role=alertdialog]")===null'),'错误弹窗可以关闭');
  await clickPreview('报告 #%.txt');await wait(async()=>(await content()).includes('最终交付B'),'关闭原件错误弹窗后交付副本仍可预览');
 }else{
  checks.push('产品进程重启后交付副本恢复，原件已删除');
  await evaluate('document.querySelector("[aria-label=关闭文件预览]").click()');
  await fetch(spec.endpoint+'/clear');await send('替换清空交付文件');await evaluate('window.outputTerminal');
  const docs=await evaluate('(async()=>{const sessions=await window.cogent.engineRequest("session.list",{});return window.cogent.engineRequest("outputs.get",{sessionId:sessions[0].id})})()');
  if(docs.length!==2||!docs.some(doc=>doc.declared&&doc.published.length===0)||!docs.some(doc=>doc.published.length===4))throw new Error('清空或回合归属错误');checks.push('新回合替换/非法候选/明确清空不影响旧回合卡');
 }
 await win.webContents.capturePage().then(image=>writeFileSync(join(spec.evidence,phase+'.png'),image.toPNG()));
 const result={passed:true,phase,checks,errors,electron:process.versions.electron};writeFileSync(join(spec.evidence,phase+'.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){if(win&&!win.isDestroyed())await win.webContents.capturePage().then(image=>writeFileSync(join(spec.evidence,phase+'-failure.png'),image.toPNG()));const result={passed:false,phase,checks,errors,error:String(error),stack:error.stack};writeFileSync(join(spec.evidence,phase+'.json'),JSON.stringify(result,null,2));console.error(result)}finally{app.quit()}})();
`)
let child
try {
  const results = []
  for (const phase of ['first', 'restore']) {
    const env = { ...process.env, COGENT_HOME: home, USERPROFILE: home, HOME: home, OUTPUT_PHASE: phase }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    child = spawn(electron, [driver], { cwd: process.cwd(), stdio: 'inherit', windowsHide: true, env })
    await new Promise((done, fail) => { child.once('error', fail); child.once('exit', done) })
    const file = join(evidence, phase + '.json'); const result = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { passed: false }
    results.push(result); if (!result.passed) break
  }
  const result = { passed: results.length === 2 && results.every(result => result.passed), results }; writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2)); process.exitCode = result.passed ? 0 : 1
} finally {
  if (child && child.exitCode === null) child.kill()
  pending?.destroy(); server.closeAllConnections(); await new Promise(done => server.close(done))
  if (!root.startsWith(join(tmpdir(), 'cogent-outputs-electron-'))) throw new Error('临时目录越界')
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
