/** 独立 Electron profile 验证输入聚焦边界和按钮尺寸，结束时关闭临时服务及进程。 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import electron from 'electron'

const directory = mkdtempSync(join(tmpdir(), 'cogent-input-group-'))
const vite = await createServer({ configFile: 'tests/browser-harness.config.ts', server: { host: '127.0.0.1', port: 5199, strictPort: true } })
let child
try {
  await vite.listen()
  const driver = join(directory, 'driver.cjs')
  writeFileSync(driver, `
const {app,BrowserWindow}=require('electron');
app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
const timeout=setTimeout(()=>{console.error('输入聚焦验收超时');app.exit(1)},60000);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:850,height:700,webPreferences:{offscreen:true,backgroundThrottling:false}});
 win.webContents.setFrameRate(60);
 win.webContents.on('console-message',details=>{if(details.level==='error')console.error(details.message)});
 await win.loadURL('http://127.0.0.1:5199/tests/renderer/components/ui/input-group.browser.html?driver');
 // 导航完成后再调用调试协议；空白页上等待命令会阻塞加载。隐藏窗口通过 Chromium 模拟焦点。
 win.webContents.debugger.attach('1.3');
 await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
 await win.webContents.executeJavaScript('new Promise(resolve=>{const timer=setInterval(()=>{if(window.verifyInputGroup){clearInterval(timer);window.verifyInputGroup().then(resolve)}},50)})');
 const report=await win.webContents.executeJavaScript('new Promise(resolve=>{const timer=setInterval(()=>{const report=document.querySelector("#report")?.textContent;if(report&&report!=="运行中"){clearInterval(timer);resolve(report)}},50)})');
 const passed=report.startsWith('通过');
 console.log(JSON.stringify({electron:process.versions.electron,chromium:process.versions.chrome,passed,report},null,2));
 clearTimeout(timeout);
 app.exit(passed?0:1);
}).catch(error=>{console.error(error);app.exit(1)});
`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(electron, [driver], { stdio: 'inherit', windowsHide: true, env })
  process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)) })
} finally {
  if (child && child.exitCode === null) child.kill()
  await vite.close()
  // 删除前核对绝对路径仍在系统临时目录下，不能清理项目或用户 profile。
  const target = resolve(directory)
  const withinTemp = relative(resolve(tmpdir()), target)
  if (withinTemp === '' || withinTemp.startsWith('..') || isAbsolute(withinTemp)) throw new Error('临时目录越界')
  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
