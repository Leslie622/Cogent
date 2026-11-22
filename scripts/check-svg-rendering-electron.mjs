/** Windows 生产壳图形验收：实际启动策略、硬件加速总开关和 SVG 尺寸矩阵。 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { IconSearch, IconSettings, IconClock, IconFolder, IconHome, IconPuzzle, IconMessage, IconCircle, IconSquare, IconArrowUpRight } from '@tabler/icons-react'
import electron from 'electron'

if (process.platform !== 'win32') throw new Error('此验收针对 Windows 启动策略')
const root = mkdtempSync(join(tmpdir(), 'cogent-svg-electron-'))
const evidence = resolve('tmp/svg-rendering-electron')
mkdirSync(evidence, { recursive: true })
rmSync(join(evidence, 'result.json'), { force: true })
const samples = [
  ['搜索', IconSearch], ['设置', IconSettings], ['时钟', IconClock], ['文件夹', IconFolder],
  ['主页', IconHome], ['拼图', IconPuzzle], ['聊天', IconMessage], ['圆形', IconCircle],
  ['方形', IconSquare], ['斜箭头', IconArrowUpRight],
].map(([name, Icon]) => ({ name, svg: renderToStaticMarkup(createElement(Icon, { size: 24 })) }))
const driver = join(root, 'driver.mjs')
writeFileSync(driver, String.raw`
import { app, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const spec=JSON.parse(readFileSync(process.argv[2],'utf8'));
app.setPath('userData',spec.profile);
BrowserWindow.prototype.show=function(){};
const created=new Promise(done=>app.once('browser-window-created',(_event,win)=>win.webContents.once('did-finish-load',()=>done(win))));
const errors=[],checks=[];let win;
const evaluate=source=>win.webContents.executeJavaScript(source,true);
const wait=async(condition,label)=>{const end=Date.now()+25000;while(Date.now()<end){if(await condition()){checks.push(label);return}await new Promise(done=>setTimeout(done,50))}throw new Error('超时：'+label)};
const capture=async name=>{await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');await win.webContents.capturePage();await new Promise(done=>setTimeout(done,200));await win.webContents.capturePage().then(image=>writeFileSync(join(spec.evidence,name),image.toPNG()))};
await import(spec.entry);
void(async()=>{try{
 win=await created;win.webContents.setBackgroundThrottling(false);win.setSize(1200,850);
 win.webContents.on('console-message',details=>{if(details.level==='error')errors.push(details.message)});
 await wait(()=>evaluate('document.querySelector("[aria-label=搜索]")!==null'),'真实侧栏已加载');
 await wait(()=>app.getGPUFeatureStatus().rasterization==='disabled_software','生产 main 使用 CPU 栅格化');
 await wait(()=>app.getGPUFeatureStatus().gpu_compositing===(spec.acceleration?'enabled':'disabled_software'),spec.acceleration?'硬件加速开启时保留 GPU 合成':'总开关关闭时禁用 GPU 合成');
 await capture('sidebar.png');
 const panel='<div id="svg-probe" style="position:fixed;inset:40px 24px auto;z-index:2147483647;background:white;color:#111;padding:24px;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:24px">'+spec.samples.map(sample=>'<div style="display:flex;flex-direction:column;align-items:center;gap:12px">'+sample.svg+'<span>'+sample.name+'</span></div>').join('')+'</div>';
 await evaluate('document.body.insertAdjacentHTML("beforeend",'+JSON.stringify(panel)+')');
 for(const size of [16,24,48,96,128]){
  await evaluate('document.querySelectorAll("#svg-probe svg").forEach(svg=>{svg.style.width="'+size+'px";svg.style.height="'+size+'px"})');
  await wait(()=>evaluate('Array.from(document.querySelectorAll("#svg-probe svg")).every(svg=>Math.abs(svg.getBoundingClientRect().width-'+size+')<0.1)'),'实际 SVG 尺寸 '+size+'px');
  await capture('icons-'+size+'.png');
 }
 const result={passed:errors.length===0,acceleration:spec.acceleration,checks,errors,gpu:app.getGPUFeatureStatus(),hardwareAcceleration:app.isHardwareAccelerationEnabled(),dpr:await evaluate('devicePixelRatio'),electron:process.versions.electron};
 writeFileSync(spec.result,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){const result={passed:false,checks,errors,error:String(error),stack:error.stack};writeFileSync(spec.result,JSON.stringify(result,null,2));console.error(result)}finally{app.quit()}})();
`)

const results = []
let child
try {
  for (const acceleration of [true, false]) {
    const name = acceleration ? 'enabled' : 'disabled'
    const home = join(root, name, 'home'), output = join(evidence, name)
    mkdirSync(home, { recursive: true }); mkdirSync(output, { recursive: true })
    const resultPath = join(output, 'result.json')
    rmSync(resultPath, { force: true })
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ version: 1, hardwareAcceleration: acceleration, closeBehavior: 'quit', soundEnabled: false, toastEnabled: false }))
    const spec = { acceleration, samples, profile: join(root, name, 'profile'), evidence: output, result: resultPath, entry: pathToFileURL(resolve('out/main/index.js')).href }
    const specFile = join(root, name, 'spec.json')
    writeFileSync(specFile, JSON.stringify(spec))
    const env = { ...process.env, COGENT_HOME: home, USERPROFILE: home, HOME: home }
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    child = spawn(electron, [driver, specFile], { cwd: process.cwd(), env, stdio: 'inherit', windowsHide: true })
    await new Promise((done, fail) => { child.once('error', fail); child.once('exit', done) })
    const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : { passed: false, error: '未生成本轮结果' }
    results.push(result)
    if (!result.passed) throw new Error('生产壳图形验收失败：'+name)
  }
  writeFileSync(join(evidence, 'result.json'), JSON.stringify({ passed: true, results }, null, 2))
} finally {
  if (child && child.exitCode === null) child.kill()
  if (!root.startsWith(join(tmpdir(), 'cogent-svg-electron-'))) throw new Error('临时目录越界')
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
