/** 隔离 Electron/profile 逐帧测量真实侧栏，覆盖 DPI 与减少动画；退出时回收服务及进程。 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import electron from 'electron'

const profile = process.argv.includes('--profile')
const directory = mkdtempSync(join(tmpdir(), 'cogent-sidebar-animation-'))
const vite = await createServer({ configFile: 'tests/browser-harness.config.ts', server: { host: '127.0.0.1', port: 5198, strictPort: true } })
let child
try {
  await vite.listen()
  const driver = join(directory, 'driver.cjs')
  writeFileSync(driver, `
const {app,BrowserWindow}=require('electron');
const {createHash}=require('node:crypto');
app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
app.commandLine.appendSwitch('force-device-scale-factor', process.env.COGENT_SIDEBAR_DPR || '1');
setTimeout(()=>{console.error('侧栏动画验收超时');app.exit(1)},90000);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1000,height:800,useContentSize:true,webPreferences:{backgroundThrottling:false,offscreen:true}});
 // 离屏窗口也按 60fps 绘制；普通隐藏窗口可能把 rAF 降成低频，漏掉过渡中的坏帧。
 win.webContents.setFrameRate(60);
 win.webContents.on('did-fail-load',(_event,code,message)=>console.error('侧栏验收页加载失败',code,message));
 win.webContents.on('render-process-gone',(_event,details)=>console.error('侧栏验收渲染进程退出',details));
 win.webContents.on('console-message',details=>{if(details.level==='error')console.error(details.message)});
 await win.loadURL('about:blank');
 win.webContents.debugger.attach('1.3');
 await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:process.env.COGENT_SIDEBAR_REDUCED==='1'?'reduce':'no-preference'}]});
 console.log('正在加载侧栏动画验收页');
 if(process.env.COGENT_SIDEBAR_PIXEL_ONLY!=='1' && !${profile}) {
   await win.loadURL('http://127.0.0.1:5198/tests/renderer/features/home/sidebar-animation.browser.html');
   const result=await win.webContents.executeJavaScript('new Promise((resolve)=>{const timer=setInterval(()=>{if(window.sidebarAnimationResult){clearInterval(timer);resolve(window.sidebarAnimationResult)}},50);setTimeout(()=>{clearInterval(timer);resolve({passed:false,error:"侧栏动画验收超时："+document.documentElement.dataset.sidebarStage})},60000)})');
   console.log(JSON.stringify({electron:process.versions.electron,chromium:process.versions.chrome,dpr:await win.webContents.executeJavaScript('devicePixelRatio'),...result},null,2));
   if(!result.passed) { app.exit(1); return; }
 }
 if(process.env.COGENT_SIDEBAR_REDUCED!=='1') {
   await win.loadURL('http://127.0.0.1:5198/tests/renderer/features/home/sidebar-animation.browser.html?pixels');
   await win.webContents.executeJavaScript('new Promise(resolve=>{const t=setInterval(()=>{if(window.sidebarPixelHarness){clearInterval(t);resolve(true)}},20)})');
   console.log(JSON.stringify({longList:await win.webContents.executeJavaScript('window.sidebarPixelHarness.checkLongList()')}));
   if(${profile}) {
     await win.webContents.debugger.sendCommand('Performance.enable');
     const metrics=async()=>Object.fromEntries((await win.webContents.debugger.sendCommand('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
     const rows=[];
     for(const count of [24,300]) for(const target of ['最近','项目','会话列表']) for(let repeat=0;repeat<4;repeat++) for(const variant of ['before','after']) {
       // 基线只在验收页关闭屏外跳过，其他布局、数据、时长及组件实例保持相同。
       let css;
       if(variant==='before') css=await win.webContents.insertCSS('.scrollbar-native [data-slot="context-menu-trigger"]{content-visibility:visible;contain-intrinsic-size:none}');
       await win.webContents.executeJavaScript('window.sidebarPixelHarness.prepare(300,'+count+',0,false)');
       if(repeat===0) await win.webContents.executeJavaScript('window.sidebarPixelHarness.animate('+JSON.stringify(target)+')');
       const before=await metrics();
       const frames=await win.webContents.executeJavaScript('(async()=>{const gaps=[];let last;let stopped=false;const tick=t=>{if(last!==undefined)gaps.push(t-last);last=t;if(!stopped)requestAnimationFrame(tick)};requestAnimationFrame(tick);await window.sidebarPixelHarness.animate('+JSON.stringify(target)+');stopped=true;return gaps})()');
       const after=await metrics();
       rows.push({count,target,variant,repeat,layoutMs:(after.LayoutDuration-before.LayoutDuration)*1000,styleMs:(after.RecalcStyleDuration-before.RecalcStyleDuration)*1000,taskMs:(after.TaskDuration-before.TaskDuration)*1000,frameMax:Math.max(...frames)});
       if(css) await win.webContents.removeInsertedCSS(css);
     }
     const summary=[];
     for(const count of [24,300]) for(const target of ['最近','项目','会话列表']) for(const variant of ['before','after']) {
       const group=rows.filter(r=>r.count===count&&r.target===target&&r.variant===variant);
       const mean=key=>Number((group.reduce((sum,r)=>sum+r[key],0)/group.length).toFixed(2));
       summary.push({count,target,variant,layoutMs:mean('layoutMs'),styleMs:mean('styleMs'),taskMs:mean('taskMs'),frameMax:mean('frameMax')});
     }
     console.log(JSON.stringify({electron:process.versions.electron,chromium:process.versions.chrome,dpr:await win.webContents.executeJavaScript('devicePixelRatio'),summary},null,2));
     app.exit(0);
     return;
   }
   let active;
   win.webContents.on('console-message',details=>{
     if(active && details.message.startsWith('SIDEBAR_CLIP:')) active.clipWidth=Number(details.message.slice(13));
     if(active && details.message.startsWith('SIDEBAR_PHASE:')) active.phase=details.message.slice(14);
   });
   function sample(image) {
     if(!active) return;
     // 窗口尺寸固定，每组只读取一次 PNG 尺寸，逐帧直接读位图，避免编码挤掉中间帧。
     if(active.bitmapWidth===undefined) active.bitmapWidth=image.toPNG().readUInt32BE(16);
     const width=active.bitmapWidth, pixels=image.toBitmap(), scale=width/1000;
     for(const region of active.regions) {
       // 恢复显示时 paint 事件可能仍交付先前完全收起的帧；整栏只比收拢可见帧及首尾稳定帧。
       if(active.target==='会话列表' && region.name==='新聊天' && (active.phase==='opening' || active.clipWidth<64)) continue;
       const x=Math.floor(region.x*scale), y=Math.floor(region.y*scale), right=Math.ceil((region.x+region.width)*scale), bottom=Math.ceil((region.y+region.height)*scale);
       const hash=createHash('sha256');
       for(let row=y;row<bottom;row++) hash.update(pixels.subarray((row*width+x)*4,(row*width+right)*4));
       active.hashes[region.name].add(hash.digest('hex'));
       active.samples[region.name]++;
     }
     active.frames++;
   }
   win.webContents.on('paint',(_event,_rect,image)=>sample(image));
   const results=[];
   for(const offset of [0,0.4]) for(const dark of [false,true]) for(const count of [4,300]) {
     const regions=await win.webContents.executeJavaScript('window.sidebarPixelHarness.prepare(300,'+count+','+offset+','+dark+')');
     for(const name of ['项目','最近','会话列表']) {
       active={target:name,phase:'ready',clipWidth:300,regions:name==='会话列表'?regions.filter(r=>r.name!=='搜索'):regions,hashes:Object.fromEntries(regions.map(r=>[r.name,new Set()])),samples:Object.fromEntries(regions.map(r=>[r.name,0])),frames:0};
       sample(await win.webContents.capturePage());
       // 整栏收拢时图标完整露出的窗口很短，连续两轮开合收集中间帧。
       for(let cycle=0;cycle<(name==='会话列表'?2:1);cycle++) await win.webContents.executeJavaScript('window.sidebarPixelHarness.animate('+JSON.stringify(name)+')');
       sample(await win.webContents.capturePage());
       const result={offset,dark,count,target:name,frames:active.frames,variants:Object.fromEntries(active.regions.map(r=>[r.name,active.hashes[r.name].size])),samples:active.samples};
       results.push(result);
       active=undefined;
     }
   }
   const failures=results.filter(r=>r.frames<12 || Object.entries(r.variants).some(([name,count])=>count!==1 || r.samples[name]<4));
   const passed=failures.length===0;
   console.log(JSON.stringify({dpr:await win.webContents.executeJavaScript('devicePixelRatio'),passed,pixelCases:results.length,pixelFrames:results.reduce((sum,r)=>sum+r.frames,0),failures},null,2));
   app.exit(passed?0:1);
   return;
 }
 app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
`)
  const modes = profile ? [['1.25', '0']] : process.env.COGENT_SIDEBAR_DPR ? [[process.env.COGENT_SIDEBAR_DPR, '0']] : [['1', '0'], ['1.25', '0'], ['1.5', '0'], ['1', '1']]
  for (const [scale, reduced] of modes) {
    const env = { ...process.env, COGENT_SIDEBAR_DPR: scale, COGENT_SIDEBAR_REDUCED: reduced }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron, [driver], { stdio: 'inherit', windowsHide: true, env })
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)) })
    if (code !== 0) { process.exitCode = code; break }
  }
} finally {
  if (child && child.exitCode === null) child.kill()
  await vite.close()
  // directory 是本轮 mkdtemp 创建的独立系统临时目录，不接收外部目标路径。
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
