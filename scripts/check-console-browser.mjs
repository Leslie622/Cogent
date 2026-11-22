/** 隐藏 Electron 验证控制台实际滚动与搜索，临时服务和独立 profile 随进程关闭。 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import electron from 'electron'

const directory = mkdtempSync(join(tmpdir(), 'cogent-console-'))
const vite = await createServer({ configFile: 'tests/browser-harness.config.ts', server: { host: '127.0.0.1', port: 5203, strictPort: true } })
let child
try {
  await vite.listen()
  const driver = join(directory, 'driver.cjs')
  writeFileSync(driver, `
const {app,BrowserWindow}=require('electron');
app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
const timeout=setTimeout(()=>{console.error('控制台阅读验收超时');app.exit(1)},60000);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1400,height:1000,webPreferences:{offscreen:true,backgroundThrottling:false}});
 win.webContents.setFrameRate(60);
 win.webContents.on('console-message',details=>{if(details.level==='error')console.error(details.message)});
 await win.loadURL('http://127.0.0.1:5203/tests/renderer/features/console/console.browser.html');
 win.webContents.debugger.attach('1.3');
 await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
 const result=await win.webContents.executeJavaScript('new Promise((resolve,reject)=>{const timer=setInterval(()=>{if(window.verifyConsoleReading&&document.querySelector(".cm-editor")){clearInterval(timer);window.verifyConsoleReading().then(resolve,reject)}},50)})');
 console.log(JSON.stringify({electron:process.versions.electron,chromium:process.versions.chrome,...result},null,2));
 clearTimeout(timeout);
 app.exit(result.passed?0:1);
}).catch(error=>{console.error(error);app.exit(1)});
`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(electron, [driver], { stdio: 'inherit', windowsHide: true, env })
  process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)) })
} finally {
  if (child && child.exitCode === null) child.kill()
  await vite.close()
  // 只清理本轮新建且已核对位于系统临时目录内的路径，不能触及用户 profile。
  const target = resolve(directory)
  const withinTemp = relative(resolve(tmpdir()), target)
  if (withinTemp === '' || withinTemp.startsWith('..') || isAbsolute(withinTemp)) throw new Error('临时目录越界')
  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
