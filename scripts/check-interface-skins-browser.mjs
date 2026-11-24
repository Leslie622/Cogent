/** 隐藏的 Electron 使用独立 profile 验证皮肤 CSS 与窄窗，退出时关闭服务及测试进程。 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import electron from 'electron'

const directory = mkdtempSync(join(tmpdir(), 'cogent-interface-skins-'))
const output = process.env.COGENT_SKIN_SCREENSHOTS
const vite = await createServer({ configFile: 'tests/browser-harness.config.ts', server: { host: '127.0.0.1', port: 5196, strictPort: true } })
let child
try {
  await vite.listen()
  const driver = join(directory, 'driver.cjs')
  writeFileSync(driver, `
const {app,BrowserWindow}=require('electron');
const {writeFileSync,mkdirSync}=require('node:fs');
const {join}=require('node:path');
app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
setTimeout(()=>{console.error('界面皮肤验收超时');app.exit(1)},120000);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1120,height:850,useContentSize:true,webPreferences:{offscreen:true,backgroundThrottling:false}});
 win.webContents.setFrameRate(60);
 win.webContents.on('console-message',details=>{if(details.level==='error')console.error(details.message)});
 console.log('正在加载界面皮肤验收页');
 await win.loadURL('http://127.0.0.1:5196/tests/renderer/features/settings/interface-skins.browser.html');
 console.log('验收页已加载，开始明暗与宽度矩阵');
 const rows=[];
 const palettes=[];
 // 分数 DPR 会把请求的 1120px 舍入成 innerWidth 1121；预期列数属于场景，不能靠视口精确相等推断。
 for(const [width,columns] of [[1120,6],[400,3]]) {
   win.setContentSize(width,850);
   rows.push(...await win.webContents.executeJavaScript('window.interfaceSkinHarness.verify('+columns+')'));
   win.setContentSize(width,600);
   palettes.push(...await win.webContents.executeJavaScript('window.interfaceSkinHarness.verifyThemeColors()'));
 }
 const output=${JSON.stringify(output ? resolve(output) : null)};
 if(output) {
   mkdirSync(output,{recursive:true});
   const scenes=['ink','mint','honey','parchment','sea','dusk'].flatMap(id=>[false,true].map(dark=>[1120,id,dark]));
   scenes.push([400,'dusk',true]);
   for(const [width,id,dark] of scenes) {
     win.setContentSize(width,850);
     // 离屏窗口没有桌面材质，截图用中性明暗底承接 alpha，避免暗色被默认白底冲淡。
     win.setBackgroundColor(dark?'#171717':'#ffffff');
     await win.webContents.executeJavaScript('window.interfaceSkinHarness.select('+JSON.stringify(id)+','+dark+')');
     await win.webContents.executeJavaScript('document.querySelector(".scrollbar-gutter-stable").scrollTop=0');
     await new Promise(resolve=>setTimeout(resolve,200));
     writeFileSync(join(output,id+'-'+(dark?'dark':'light')+'-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
   }
   for(const dark of [false,true]) {
     win.setContentSize(1120,730);
     await win.webContents.executeJavaScript('window.interfaceSkinHarness.showThemeColors('+dark+')');
     await new Promise(resolve=>setTimeout(resolve,200));
     const bounds=await win.webContents.executeJavaScript(${JSON.stringify('(()=>{const r=document.querySelector(\'[role=dialog][aria-label="强调色选择器"]\').getBoundingClientRect();return {x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)}})()')});
     writeFileSync(join(output,'theme-colors-'+(dark?'dark':'light')+'.png'),(await win.webContents.capturePage(bounds)).toPNG());
     await win.webContents.executeJavaScript(${JSON.stringify('document.querySelector(\'button[aria-label="选择颜色"]\').click()')});
   }
 }
 console.log(JSON.stringify({electron:process.versions.electron,chromium:process.versions.chrome,passed:true,cases:rows.length,widths:[1120,400],skins:6,modes:2,palettes,screenshots:output},null,2));
 app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(electron, [driver], { stdio: 'inherit', windowsHide: true, env })
  process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)) })
} finally {
  if (child && child.exitCode === null) child.kill()
  await vite.close()
  // directory 来自系统临时目录的 mkdtemp，独立测试 profile 不含用户数据。
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
