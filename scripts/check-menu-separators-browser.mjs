/** 独立 Electron profile 按物理像素比较菜单和通用分隔线，退出时关闭子进程与 Vite。 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import electron from 'electron'

const directory = mkdtempSync(join(tmpdir(), 'cogent-menu-separators-'))
const output = process.env.COGENT_MENU_SCREENSHOTS
const vite = await createServer({ configFile: 'tests/browser-harness.config.ts', server: { host: '127.0.0.1', port: 5197, strictPort: true } })
let child
try {
  await vite.listen()
  const driver = join(directory, 'driver.cjs')
  writeFileSync(driver, `
const {app,BrowserWindow}=require('electron');
const {writeFileSync,mkdirSync}=require('node:fs');
const {join}=require('node:path');
app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
app.commandLine.appendSwitch('force-device-scale-factor', process.env.COGENT_MENU_DPR || '1.25');
const timeout=setTimeout(()=>{console.error('菜单分隔线验收超时');app.exit(1)},90000);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:500,height:450,useContentSize:true,webPreferences:{backgroundThrottling:false}});
 await win.loadURL('http://127.0.0.1:5197/tests/renderer/components/ui/menu-separators.browser.html');
 const dpr=await win.webContents.executeJavaScript('devicePixelRatio');
 const output=${JSON.stringify(output ? resolve(output) : null)};
 if(output) mkdirSync(output,{recursive:true});
 const rows=[];
 function sampleLines(screenshot,lines,vertical=false) {
   const png=screenshot.toPNG();
   // PNG 的宽高是实际位图尺寸，避免把 NativeImage 的 DIP 尺寸当成物理像素。
   const width=png.readUInt32BE(16), height=png.readUInt32BE(20);
   const pixels=screenshot.toBitmap();
   if(pixels.length!==width*height*4) throw new Error('截图位图尺寸不一致');
   const ratio=width/500;
   return lines.map(line=>{
     const cross=Math.round((vertical?line.y+line.height/2:line.x+line.width/2)*ratio);
     const origin=vertical?line.x:line.y, extent=vertical?line.width:line.height;
     const start=Math.floor(origin*ratio)-3, end=Math.ceil((origin+extent)*ratio)+3;
     const scan=[];
     for(let position=start;position<end;position++) {
       const x=vertical?position:cross, y=vertical?cross:position;
       const p=(y*width+x)*4;
       scan.push({position,rgb:[pixels[p+2],pixels[p+1],pixels[p]]});
     }
     const background=scan[0].rgb;
     const ink=scan.filter(row=>row.rgb.some((value,index)=>value!==background[index]));
     return {origin,extent,ink};
   });
 }
 for(const size of ['default','lg']) for(const font of [11,14,16]) for(const dark of [false,true]) for(const offset of [0,0.4,0.8]) {
   const lines=await win.webContents.executeJavaScript('window.menuSeparatorHarness.show('+JSON.stringify(size)+','+font+','+dark+','+offset+')');
   if(lines.length!==2) throw new Error('菜单分隔线数量错误：'+lines.length);
   const screenshot=await win.webContents.capturePage();
   const samples=sampleLines(screenshot,lines);
   const passed=JSON.stringify(samples[0].ink.map(row=>row.rgb))===JSON.stringify(samples[1].ink.map(row=>row.rgb)) && samples[0].ink.length===Math.floor(dpr);
   rows.push({size,font,dark,offset,passed,samples});
   if(output && size==='lg' && font===14 && !dark && offset===0) writeFileSync(join(output,'menu-'+dpr+'.png'),screenshot.toPNG());
 }
 for(const kind of ['horizontal','vertical','button-group-horizontal','button-group-vertical']) for(const font of [11,14,16]) for(const dark of [false,true]) for(const offset of [0,0.4,0.8]) {
   const lines=await win.webContents.executeJavaScript('window.menuSeparatorHarness.showSeparators('+JSON.stringify(kind)+','+font+','+dark+','+offset+')');
   if(lines.length!==2) throw new Error('通用分隔线数量错误：'+lines.length);
   const screenshot=await win.webContents.capturePage();
   const samples=sampleLines(screenshot,lines,kind.endsWith('vertical'));
   const passed=JSON.stringify(samples[0].ink.map(row=>row.rgb))===JSON.stringify(samples[1].ink.map(row=>row.rgb)) && samples[0].ink.length===Math.floor(dpr);
   rows.push({kind,font,dark,offset,passed,samples});
   if(output && font===14 && !dark && offset===0) writeFileSync(join(output,kind+'-'+dpr+'.png'),screenshot.toPNG());
 }
 const failures=rows.filter(row=>!row.passed);
 console.log(JSON.stringify({electron:process.versions.electron,chromium:process.versions.chrome,dpr,cases:rows.length,passed:failures.length===0,
   failures:failures.map(({size,kind,font,dark,offset,samples})=>({size,kind,font,dark,offset,lines:samples.map(line=>line.ink.map(row=>row.rgb))}))},null,2));
 clearTimeout(timeout);
 app.exit(failures.length===0?0:1);
}).catch(error=>{console.error(error);app.exit(1)});
`)
  process.exitCode = 0
  const scales = process.env.COGENT_MENU_DPR ? [process.env.COGENT_MENU_DPR] : ['1', '1.25', '1.5', '2']
  for (const scale of scales) {
    const env = { ...process.env, COGENT_MENU_DPR: scale }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron, [driver], { stdio: 'inherit', windowsHide: true, env })
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)) })
    if (code !== 0) process.exitCode = code
  }
} finally {
  if (child && child.exitCode === null) child.kill()
  await vite.close()
  // directory 由系统临时目录创建，清理前确认没有越出本次测试的独立目录。
  if (relative(tmpdir(), directory).startsWith('..')) throw new Error('测试临时目录越界')
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
