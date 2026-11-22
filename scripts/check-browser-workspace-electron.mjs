/** 隔离完整产品 main/preload 的浏览器原生链：不访问用户资料，不启动开发服务。 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import electron from 'electron'

const workspace = resolve('.')
const evidence = resolve('tmp/browser-workspace-electron')
mkdirSync(evidence, { recursive: true })
const root = mkdtempSync(join(evidence, 'run-'))
const home = join(root, 'home'); mkdirSync(home)
writeFileSync(join(home, 'settings.json'), JSON.stringify({ version: 1, closeBehavior: 'quit', soundEnabled: false, toastEnabled: false }))
const driver = join(root, 'driver.mjs')
const fixture = `<title>原生浏览器验收</title><style>body{background:#17385c;color:white;font:18px sans-serif}</style><input id="form" value="initial"><p id="text">原生网页查找测试 browser probe</p><input id="upload" type="file"><button id="prompt" onclick="window.answer=prompt('输入测试','default')">输入</button><a id="link" target="_blank" href="/page?id=popup">新标签</a><a id="download" href="/download">下载</a>`
writeFileSync(driver, `
import { app, BrowserWindow, webContents, session, dialog } from 'electron';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import childProcess from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const ownedChildren=new Set();const spawnChild=childProcess.spawn;childProcess.spawn=(...args)=>{const child=spawnChild(...args);if(child.pid)ownedChildren.add(child.pid);return child};syncBuiltinESMExports();
app.setPath('userData', ${JSON.stringify(join(root, 'profile'))});
mkdirSync(${JSON.stringify(join(root, 'downloads'))},{recursive:true});app.setPath('downloads',${JSON.stringify(join(root, 'downloads'))});
const result={electron:process.versions.electron,chrome:process.versions.chrome,scope:'product main/preload/native browser; guest placement is probe DOM, not BrowserPane UI acceptance',flags:process.argv,checks:[],capacity:[],downloads:[],requests:[],stages:[],beforeUnload:{events:[],questions:[]},errors:[]};
const started=Date.now();let win;let stopping=false;const owned=[];
const stage=name=>{result.stage=name;result.stages.push({name,at:Date.now()-started})};
const server=createServer((req,res)=>{
 result.requests.push(req.url);
 if(req.url.startsWith('/redirect')){res.writeHead(302,{location:'/page?id=redirected'});res.end();return;}
 if(req.url.startsWith('/download')){res.writeHead(200,{'content-type':'application/octet-stream','content-disposition':'attachment; filename="probe.txt"'});res.end('isolated-download');return;}
 res.setHeader('content-type','text/html; charset=utf-8');res.setHeader('set-cookie','browserProbe=isolated; SameSite=Lax');
 res.end(${JSON.stringify(fixture)});
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const url='http://127.0.0.1:'+server.address().port;
const evaluate=source=>win.webContents.executeJavaScript(source,true);
const wait=async(test,label,ms=15000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await test())return;await new Promise(done=>setTimeout(done,30));}throw new Error('超时 '+label)};
const rpc=(method,params)=>evaluate('window.cogent.browserRequest('+JSON.stringify(method)+','+JSON.stringify(params)+')');
const create=async(id,privateGroupId)=>{
 const reservation=await rpc('reserve',{scopeId:'browser-probe',tabId:id,...(privateGroupId?{privateGroupId}: {})});
 const webId=await evaluate('(async()=>{const root=document.querySelector("#probe")??Object.assign(document.body.appendChild(document.createElement("div")),{id:"probe"});root.style="position:fixed;inset:100px 100px 80px;background:white;z-index:100";const view=document.createElement("webview");view.dataset.probe='+JSON.stringify(id)+';view.style="position:absolute;inset:0;width:100%;height:100%;display:flex";view.setAttribute("partition",'+JSON.stringify(reservation.partition)+');view.setAttribute("allowpopups", "");view.src='+JSON.stringify(reservation.bootstrapUrl)+';const ready=new Promise(done=>view.addEventListener("dom-ready",()=>done(view.getWebContentsId()),{once:true}));root.append(view);return await ready})()');
 await rpc('attach',{lease:reservation.lease,webContentsId:webId});await rpc('visibility',{lease:reservation.lease,active:true});
 const guest=webContents.fromId(webId);const value={...reservation,guest,id};owned.push(value);return value;
};
const close=async(tab)=>{await rpc('release',{lease:tab.lease});await evaluate('document.querySelector("[data-probe='+tab.id+']")?.remove()');};
const samples=()=>{const metrics=app.getAppMetrics();return{at:Date.now()-started,processes:metrics.length,workingSetKiB:metrics.reduce((sum,item)=>sum+item.memory.workingSetSize,0),privateBytesKiB:metrics.reduce((sum,item)=>sum+item.memory.privateBytes,0),cpu:metrics.reduce((sum,item)=>sum+item.cpu.percentCPUUsage,0),byType:metrics.map(item=>({type:item.type,pid:item.pid,memory:item.memory,cpu:item.cpu.percentCPUUsage}))};};
const finish=async()=>{if(stopping)return;stopping=true;stage('cleanup-start');clearTimeout(watchdog);for(const tab of owned){if(!tab.guest.isDestroyed())await close(tab);}server.closeAllConnections();await new Promise(done=>server.close(done));result.elapsedMs=Date.now()-started;result.ownedPids=[...new Set([...ownedChildren,...app.getAppMetrics().map(item=>item.pid)])];writeFileSync(${JSON.stringify(join(root, 'result.json'))},JSON.stringify(result,null,2));app.quit();setTimeout(()=>app.exit(2),7000).unref()};
// 测试异常写进报告并退出，避免 Electron 默认错误弹窗阻塞自动化和用户桌面。
process.on('uncaughtException',error=>{result.errors.push(String(error.stack||error));void finish()});
process.on('unhandledRejection',error=>{result.errors.push(String(error?.stack||error));void finish()});
const watchdog=setTimeout(()=>{result.errors.push('整体240s watchdog');void finish()},240000);
dialog.showMessageBox=async()=>({response:0,checkboxChecked:false});dialog.showMessageBoxSync=()=>0;
const created=new Promise(done=>app.once('browser-window-created',(_event,value)=>done(value)));
await import(${JSON.stringify(pathToFileURL(resolve(workspace, 'out/main/index.js')).href)});
void(async()=>{try{
 win=await created;if(win.webContents.isLoading())await new Promise(done=>win.webContents.once('did-finish-load',done));
 await wait(()=>evaluate('typeof window.cogent?.browserRequest==="function"'),'main preload browser bridge');
 samples();await new Promise(done=>setTimeout(done,1200));result.blankBaseline=samples();result.gpu=await app.getGPUInfo('basic');
 const tab=await create('first');
 await rpc('navigate',{lease:tab.lease,url:url+'/page?id=first'});
 const security=await tab.guest.executeJavaScript('({sdk:typeof window.cogentHost,node:typeof require,process:typeof process,prompt:String(window.prompt)})');
 if(security.sdk!=='undefined'||security.node!=='undefined'||security.process!=='undefined')throw new Error('guest泄露Node或Host SDK '+JSON.stringify(security));
 result.checks.push('普通网页无Host SDK/Node');
 await tab.guest.executeJavaScript('document.querySelector("#form").value="kept";window.scrollTo(0,20);localStorage.setItem("probe","kept")');
 await rpc('visibility',{lease:tab.lease,active:false});await evaluate('document.querySelector("[data-probe=first]").hidden=true;document.querySelector("[data-probe=first]").style.display="none"');
 await evaluate('document.querySelector("[data-probe=first]").hidden=false;document.querySelector("[data-probe=first]").style.display="flex"');await rpc('visibility',{lease:tab.lease,active:true});
 if(await tab.guest.executeJavaScript('document.querySelector("#form").value')!=='kept')throw new Error('hidden属性切换丢表单');
 result.checks.push('真实hidden属性切换保持相同guest与表单');
 await evaluate('window.browserProbeEvents=[];window.cogent.onBrowserEvent(event=>{window.browserProbeEvents.push(event);if(event.type==="prompt")void window.cogent.browserRequest("promptReply",{lease:'+JSON.stringify(tab.lease)+',requestId:event.requestId,value:"answered"})});undefined');
 await tab.guest.executeJavaScript('document.querySelector("#prompt").click()');
 if(await tab.guest.executeJavaScript('window.answer')!=='answered')throw new Error('prompt桥未返回用户输入');
 result.checks.push('沙箱prompt窄桥及主窗口回答');
 await rpc('navigate',{lease:tab.lease,url:url+'/redirect'});
 await tab.guest.executeJavaScript('history.pushState({},"","/page?id=spa")');
 const history=await rpc('history',{lease:tab.lease});if(history.entries.some(entry=>'pageState'in entry)||!history.entries.some(entry=>entry.url.includes('id=spa')))throw new Error('history丢SPA或含pageState');
 result.checks.push('重定向/SPA/native history白名单投影');
 await rpc('find',{lease:tab.lease,text:'browser probe'});await wait(()=>evaluate('window.browserProbeEvents.some(event=>event.type==="find"&&event.matches>0)'),'find result');
 await rpc('zoom',{lease:tab.lease,factor:1.25});if(Math.abs(tab.guest.getZoomFactor()-1.25)>0.01)throw new Error('zoom不生效');
 result.checks.push('真实页面查找与缩放');
 const peer=await create('peer');await rpc('navigate',{lease:peer.lease,url:url+'/page?id=peer'});
 if(await peer.guest.executeJavaScript('localStorage.getItem("probe")')!=='kept')throw new Error('普通profile未共享站点存储');
 const privateTab=await create('private','private-group');await rpc('navigate',{lease:privateTab.lease,url:url+'/page?id=private'});
 if(await privateTab.guest.executeJavaScript('localStorage.getItem("probe")')!==null)throw new Error('临时profile混入普通数据');
 if((await rpc('history',{lease:privateTab.lease})).entries.length)throw new Error('私密历史被导出');
 result.checks.push('普通/临时profile隔离与私密历史不导出');
 await close(peer);await close(privateTab);
 const guarded=await create('beforeunload');await rpc('navigate',{lease:guarded.lease,url:url+'/page?id=beforeunload'});
 const guardedId=guarded.guest.id;result.beforeUnload.guestId=guardedId;
 for(const name of ['will-prevent-unload','did-start-navigation','did-fail-load','did-stop-loading','destroyed'])guarded.guest.on(name,(event,...args)=>result.beforeUnload.events.push({name,at:Date.now()-started,stage:result.stage,defaultPrevented:event?.defaultPrevented,args:args.filter(value=>typeof value==='string'||typeof value==='number'||typeof value==='boolean'),destroyed:guarded.guest.isDestroyed()}));
 await guarded.guest.executeJavaScript('window.addEventListener("beforeunload",event=>{event.preventDefault();event.returnValue=""})');
 const guardedPoint=await guarded.guest.executeJavaScript('(()=>{const r=document.querySelector("#form").getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
 win.show();win.focus();guarded.guest.focus();guarded.guest.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...guardedPoint});guarded.guest.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...guardedPoint});
 await wait(()=>guarded.guest.executeJavaScript('navigator.userActivation.hasBeenActive'),'beforeunload真实用户输入激活');
 await guarded.guest.executeJavaScript('document.querySelector("#form").value="unsaved"');
 let unloadQuestions=0;dialog.showMessageBoxSync=(_window,options)=>{unloadQuestions++;result.beforeUnload.questions.push({choice:1,at:Date.now()-started,stage:result.stage,title:options.title});return 1};
 stage('beforeunload-cancel-request');
 const cancelledClose=await rpc('close',{lease:guarded.lease});if(cancelledClose.closed||guarded.guest.isDestroyed()||unloadQuestions!==1)throw new Error('取消beforeunload仍关闭网页或未触发原生关闭询问');
 result.beforeUnload.cancelledClose=cancelledClose;stage('beforeunload-cancel-reply');
 if(await guarded.guest.executeJavaScript('document.querySelector("#form").value')!=='unsaved')throw new Error('取消关闭后丢失表单');
 stage('beforeunload-cancel-form-retained');await new Promise(done=>setTimeout(done,200));
 if(guarded.guest.isDestroyed()||webContents.fromId(guardedId)!==guarded.guest)throw new Error('取消回复后原guest仍异步销毁或被替换');
 if(await guarded.guest.executeJavaScript('document.querySelector("#form").value')!=='unsaved')throw new Error('取消回复200ms后丢失原表单');
 stage('beforeunload-cancel-stable');
 dialog.showMessageBoxSync=(_window,options)=>{unloadQuestions++;result.beforeUnload.questions.push({choice:0,at:Date.now()-started,stage:result.stage,title:options.title});return 0};stage('beforeunload-confirm-request');const confirmedClose=await rpc('close',{lease:guarded.lease});if(!confirmedClose.closed||!guarded.guest.isDestroyed()||unloadQuestions!==2)throw new Error('确认beforeunload未释放原生网页');
 result.beforeUnload.confirmedClose=confirmedClose;stage('beforeunload-confirm-reply');
 await close(guarded);dialog.showMessageBoxSync=()=>0;result.checks.push('真实beforeunload取消保留表单、确认后关闭guest');
 session.fromPartition(tab.partition).on('will-download',(_event,item)=>{item.setSavePath(${JSON.stringify(join(root, 'probe.txt'))});result.downloads.push({phase:'start',url:item.getURL()});item.on('updated',(_event,state)=>result.downloads.push({phase:'update',state,received:item.getReceivedBytes()}));item.once('done',(_event,state)=>result.downloads.push({phase:'done',state,path:item.getSavePath()}));});
 await rpc('visibility',{lease:tab.lease,active:true});await rpc('zoom',{lease:tab.lease,factor:1});
 const point=await tab.guest.executeJavaScript('(()=>{const r=document.querySelector("#download").getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
 win.show();win.focus();tab.guest.focus();tab.guest.sendInputEvent({type:'mouseMove',...point});tab.guest.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});tab.guest.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
 await wait(async()=> (await rpc('downloads',{lease:tab.lease})).some(item=>item.state==='completed'),'真实下载完成');if(readFileSync(${JSON.stringify(join(root, 'probe.txt'))},'utf8')!=='isolated-download')throw new Error('下载字节与夹具不一致');result.checks.push('真实Session下载保存、字节与终态');
 stage('capacity');const resident=[tab];
 for(const count of [1,5,10,20]){while(resident.length<count){const page=await create('capacity'+resident.length);await rpc('navigate',{lease:page.lease,url:url+'/page?id='+resident.length});await rpc('visibility',{lease:page.lease,active:false});await evaluate('(()=>{const view=document.querySelector("[data-probe='+page.id+']");view.hidden=true;view.style.display="none"})()');resident.push(page)}samples();await new Promise(done=>setTimeout(done,1200));samples();const measurements=[];for(let i=0;i<3;i++){await new Promise(done=>setTimeout(done,1200));measurements.push(samples())}const sorted=measurements.map(item=>item.cpu).sort((a,b)=>a-b);result.capacity.push({resident:count,...measurements.at(-1),measurements,cpuSummary:{p50:sorted[1],p95:sorted[2],max:sorted[2]}});}
 for(const page of resident.slice(1))await close(page);
 for(let index=0;index<100;index++){const page=await create('loop'+index);await rpc('navigate',{lease:page.lease,url:url+'/page?id=loop'});await close(page)}
 if(!owned.filter(page=>page!==tab).every(page=>page.guest.isDestroyed()))throw new Error('关闭循环后guest残留');
 result.checks.push('100次guest创建/关闭零残留');
 const bitmap=await win.capturePage();writeFileSync(${JSON.stringify(join(root, 'browser.png'))},bitmap.toPNG());
 }catch(error){result.failedStage=result.stage;result.errors.push(String(error.stack||error))}finally{await finish()}})();
`)
const syntax = spawnSync(process.execPath, ['--check', driver], { encoding: 'utf8', windowsHide: true })
if (syntax.status !== 0) throw new Error(syntax.stderr)
const child = spawn(electron, [driver], { env: { ...process.env, COGENT_HOME: home, USERPROFILE: home, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
child.stdout.on('data', data => process.stdout.write(data))
child.stderr.on('data', data => process.stderr.write(data))
const timeout = setTimeout(() => child.kill(), 135000)
const code = await new Promise(done => child.once('exit', done))
clearTimeout(timeout)
console.log(JSON.stringify({ root, result: join(root, 'result.json'), exitCode: code }))
const report=JSON.parse(readFileSync(join(root,'result.json'),'utf8'));const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}};const end=Date.now()+5000;while(report.ownedPids?.some(alive)&&Date.now()<end)await new Promise(done=>setTimeout(done,100));report.cleanup={remainingPids:report.ownedPids?.filter(alive)??[]};report.passed=code===0&&report.errors.length===0&&report.cleanup.remainingPids.length===0;writeFileSync(join(root,'result.json'),JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1
