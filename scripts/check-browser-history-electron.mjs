/** 隔离真实 BrowserTabRuntime：已加载过 bootstrap 的 guest 仅恢复公开 URL 栈。 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { build } from 'vite'
import electron from 'electron'
const evidence = resolve('tmp/browser-history-electron')
mkdirSync(evidence, { recursive: true })
const root = mkdtempSync(join(evidence, 'run-'))
const home = join(root, 'home'); mkdirSync(home)
await build({ configFile: false, logLevel: 'error', build: { ssr: resolve('src/electron/main/browser/runtime.ts'), outDir: join(root, 'bundle'), emptyOutDir: false, rollupOptions: { external: ['electron', 'zod'], output: { entryFileNames: 'runtime.mjs', format: 'es' } } } })
const driver = join(root, 'driver.mjs')
writeFileSync(driver, `
import {app,BrowserWindow,protocol,webContents} from 'electron';
import {createServer} from 'node:http';import{writeFileSync}from'node:fs';
import {BrowserTabRuntime} from ${JSON.stringify(pathToFileURL(join(root, 'bundle/runtime.mjs')).href)};
app.setPath('userData',${JSON.stringify(join(root, 'profile'))});
protocol.registerSchemesAsPrivileged([{scheme:'cogent-preview',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
const result={electron:process.versions.electron,scope:'real product BrowserTabRuntime, isolated native guest; public URL toolbar history',checks:[],errors:[],requests:[]};let win;let guest;
const server=createServer((req,res)=>{result.requests.push(req.url);res.setHeader('content-type','text/html');res.end('<title>'+req.url+'</title><input value="restored">')});
const finish=()=>{clearTimeout(timer);if(win&&!win.isDestroyed())win.destroy();server.close();writeFileSync(${JSON.stringify(join(root, 'result.json'))},JSON.stringify(result,null,2));app.exit(result.errors.length?1:0)};
const timer=setTimeout(()=>{result.errors.push('watchdog 25s');finish()},25000);
const wait=async(test)=>{const end=Date.now()+5000;while(Date.now()<end){if(await test())return;await new Promise(done=>setTimeout(done,20))}throw new Error('navigation timeout')};
void app.whenReady().then(async()=>{try{
 await new Promise(done=>server.listen(0,'127.0.0.1',done));const base='http://127.0.0.1:'+server.address().port;
 const runtime=new BrowserTabRuntime({getProtectedPorts:()=>[]});
 app.on('web-contents-created',(_event,contents)=>contents.on('will-attach-webview',(event,preferences,params)=>{if(runtime.configureAttachment(contents,preferences,params)!==true)event.preventDefault();delete preferences.preload}));
 win=new BrowserWindow({show:false,webPreferences:{webviewTag:true,contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
 await win.loadURL('data:text/html,<div id="root"></div>');const owner=win.webContents;
 const reservation=runtime.reserve(owner,{scopeId:'probe',tabId:'history'});
 const id=await owner.executeJavaScript('(async()=>{const view=document.createElement("webview");view.setAttribute("partition",'+JSON.stringify(reservation.partition)+');view.src='+JSON.stringify(reservation.bootstrapUrl)+';const ready=new Promise(done=>view.addEventListener("dom-ready",()=>done(view.getWebContentsId()),{once:true}));document.body.append(view);return await ready})()');
 guest=webContents.fromId(id);runtime.attach(owner,reservation.lease,id);await runtime.navigate(owner,reservation.lease,base+'/before');
 await runtime.restore(owner,reservation.lease,[{url:base+'/first',title:'first'},{url:base+'/second',title:'second'}],0);
 result.history=runtime.history(owner,reservation.lease);
 if(guest.getURL()!==base+'/first'||result.history.entries.length!==2||result.history.index!==0)throw new Error('public stack restore failed');
 if(result.requests.includes('/second'))throw new Error('restore loaded nonselected history URL');
 result.checks.push('已提交bootstrap后可恢复public URL/title栈，首次仅载入选中页');
 runtime.command(owner,reservation.lease,'forward');await wait(()=>guest.getURL()===base+'/second'&&!guest.isLoading());
 if(runtime.history(owner,reservation.lease).index!==1)throw new Error('forward index mismatch');result.checks.push('工具条前进重新导航第二页');
 runtime.command(owner,reservation.lease,'back');await wait(()=>guest.getURL()===base+'/first'&&!guest.isLoading());
 if(runtime.history(owner,reservation.lease).index!==0)throw new Error('back index mismatch');result.checks.push('工具条后退重新导航第一页');
 await guest.executeJavaScript('history.pushState({},"","/third")');await wait(()=>runtime.history(owner,reservation.lease).entries.at(-1).url===base+'/third');
 const final=runtime.history(owner,reservation.lease);if(final.entries.length!==2||final.index!==1||runtime.state(owner,reservation.lease).canGoForward)throw new Error('new navigation did not truncate forward history');
 result.checks.push('新SPA导航截断旧前进分支并保留正确工具条状态');
 runtime.release(owner,reservation.lease);await wait(()=>guest.isDestroyed());result.checks.push('关闭恢复标签后无guest残留');
}catch(error){result.errors.push(String(error.stack||error))}finally{finish()}});
`)
const syntax = spawnSync(process.execPath, ['--check', driver], { encoding: 'utf8', windowsHide: true })
if (syntax.status) throw new Error(syntax.stderr)
const child = spawn(electron, [driver], { env: { ...process.env, COGENT_HOME: home }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.on('data', data => process.stdout.write(data)); child.stderr.on('data', data => process.stderr.write(data))
const timer = setTimeout(() => child.kill(), 35000)
const code = await new Promise(done => child.once('exit', done)); clearTimeout(timer)
console.log(JSON.stringify({ root, exitCode: code })); if (code !== 0) process.exitCode = 1
