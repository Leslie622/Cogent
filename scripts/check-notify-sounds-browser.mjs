/** 隔离验证开发与构建 file 页面中的提示音，不启动应用或读取用户配置。 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { build, createServer } from 'vite'
import electron from 'electron'

const directory = mkdtempSync(join(tmpdir(), 'cogent-notify-browser-'))
const configFile = 'tests/browser-harness.config.ts'
const page = 'tests/renderer/lib/notify.browser.html'
const vite = await createServer({ configFile, server: { host: '127.0.0.1', port: 0 } })
let child
try {
  const output = join(directory, 'site')
  await build({ configFile, logLevel: 'error', base: './', build: {
    outDir: output, emptyOutDir: false, rollupOptions: { input: resolve(page) }
  } })
  await vite.listen()
  const urls = [new URL(page, vite.resolvedUrls.local[0]).href, pathToFileURL(join(output, page)).href]
  const driver = join(directory, 'driver.cjs')
  writeFileSync(driver, `
const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(join(directory, 'profile'))});
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
  try {
    const results=[];
    for(const url of ${JSON.stringify(urls)}) {
      const win=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});
      win.webContents.setAudioMuted(true);
      await win.loadURL(url);
      const result=await win.webContents.executeJavaScript('new Promise((resolve,reject)=>{const interval=setInterval(()=>{if(window.notifySoundResult){clearInterval(interval);clearTimeout(timeout);resolve(window.notifySoundResult)}},20);const timeout=setTimeout(()=>{clearInterval(interval);reject(new Error("提示音验收超时"))},15000)})');
      results.push({url,...result});
      win.destroy();
    }
    console.log(JSON.stringify({electron:process.versions.electron,passed:results.every(result=>result.passed),results},null,2));
    app.exit(results.every(result=>result.passed)?0:1);
  } catch(error) {console.error(error);app.exit(1)}
});
`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(electron, [driver], { windowsHide: true, stdio: 'inherit', env })
  const timeout = setTimeout(() => child.kill(), 40000)
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', code => resolve(code ?? 1))
    })
  } finally { clearTimeout(timeout) }
} finally {
  if (child && child.exitCode === null) child.kill()
  await vite.close()
}
