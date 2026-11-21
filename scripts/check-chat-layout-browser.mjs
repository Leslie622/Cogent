/** 隐藏 Electron 验证真实聊天布局与工作行裁切，独立服务和临时 profile 随进程关闭。 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import electron from 'electron'

const directory = mkdtempSync(join(tmpdir(), 'cogent-chat-layout-'))
const vite = await createServer({ configFile: 'tests/browser-harness.config.ts', server: { host: '127.0.0.1', port: 5195, strictPort: true } })
let child
try {
  await vite.listen()
  const driver = join(directory, 'driver.cjs')
  writeFileSync(driver, `
const {app,BrowserWindow}=require('electron');
app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
setTimeout(()=>{console.error('聊天布局驱动超时');app.exit(1)},150000);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1400,height:1100,webPreferences:{backgroundThrottling:false}});
 win.webContents.on('console-message',details=>{if(details.level==='error')console.error(details.message)});
 await win.loadURL('http://127.0.0.1:5195/tests/renderer/features/home/chat-layout.browser.html');
 const result=await win.webContents.executeJavaScript('new Promise((resolve)=>{const timer=setInterval(()=>{if(window.chatLayoutResult){clearInterval(timer);resolve(window.chatLayoutResult)}},50);setTimeout(()=>{clearInterval(timer);resolve({passed:false,error:"聊天布局验收超时："+document.documentElement.dataset.chatLayoutStage})},120000)})');
 console.log(JSON.stringify({electron:process.versions.electron,chromium:process.versions.chrome,...result},null,2));
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
  // directory 是本轮系统临时目录下的独立 profile，清理不触及用户会话。
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
