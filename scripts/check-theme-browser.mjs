/** 隐藏项目当前 Electron 窗口验收实际 CSS；独立 Vite 与临时 profile 在结束时一并收口。 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import electron from 'electron'

const directory = mkdtempSync(join(tmpdir(), 'cogent-theme-browser-'))
const vite = await createServer({ configFile: 'tests/browser-harness.config.ts', server: { host: '127.0.0.1', port: 5191, strictPort: true } })
let child
try {
  await vite.listen()
  const driver = join(directory, 'driver.cjs')
  writeFileSync(driver, `
const {app,BrowserWindow}=require('electron');
app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});
 win.webContents.on('console-message',details=>{if(details.level==='error')console.error(details.message)});
 await win.loadURL('http://127.0.0.1:5191/tests/renderer/lib/theme/theme.browser.html');
 const result=await win.webContents.executeJavaScript('new Promise((resolve)=>{const timer=setInterval(()=>{if(window.themeResult){clearInterval(timer);resolve(window.themeResult)}},50);setTimeout(()=>{clearInterval(timer);resolve({passed:false,error:"浏览器验收超时"})},60000)})');
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
  // directory 来自本轮 mkdtemp，清理仅限这个已解析的临时 profile。
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
