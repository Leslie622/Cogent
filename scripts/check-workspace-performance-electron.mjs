/** 串行正常GPU性能/矩阵验收。冷启动与热切换分开，容量数据不混作主UI性能。 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { cpus, totalmem, release, platform, arch } from 'node:os'
import { spawn } from 'node:child_process'

const evidence = resolve('tmp/workspace-performance')
mkdirSync(evidence, { recursive: true })
const run = (script, env) => new Promise((done, reject) => {
  const child = spawn(process.execPath, [script, '--performance'], { cwd: process.cwd(), stdio: 'inherit', windowsHide: true, env: { ...process.env, ...env } })
  child.once('error', reject)
  child.once('exit', (code, signal) => done({ code, signal }))
})
const report = {
  recordedAt: new Date().toISOString(),
  machine: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryMiB: Math.round(totalmem() / 1024 ** 2) },
  runs: [], passed: true,
  limits: { switchP95: 100, switchMax: 250, visibleTreeRows: 200, logicalClose: 500 },
  boundaries: ['Windows Chromium正常GPU自动窗口；非物理DPI/IME/摄像头设备认证', '热切换、树容量和批量关闭均在同一次产品运行内采样；重启由 test:workspace-electron 验证']
}
for (const [name, dpr, measured] of [
  ['warmup', 1, false], ['sample-1', 1, true], ['sample-2', 1, true], ['sample-3', 1, true],
  ['dpr-1.25', 1.25, true], ['dpr-1.5', 1.5, true], ['dpr-2', 2, true]
]) {
  const destination = join(evidence, name)
  const execution = await run('scripts/check-workspace-electron.mjs', { WORKSPACE_DPR: String(dpr), WORKSPACE_EVIDENCE: destination })
  const read = phase => { const path = join(destination, 'result-' + phase + '-dpr' + dpr + '.json'); return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null }
  const create = read('create')
  const verdict = {
    name, dpr, measured, execution, create,
    functional: execution.code === 0 && create?.passed === true,
    switches: create?.measurements?.switches?.p95 <= report.limits.switchP95 && create?.measurements?.switches?.max <= report.limits.switchMax,
    tree: create?.measurements?.treeDom <= report.limits.visibleTreeRows,
    logicalClose: create?.measurements?.closeLogicalTabs <= report.limits.logicalClose
  }
  report.runs.push(verdict)
  if (!verdict.functional || (measured && !(verdict.switches && verdict.tree && verdict.logicalClose))) report.passed = false
  writeFileSync(join(evidence, 'result.json'), JSON.stringify(report, null, 2))
  if (!verdict.functional) break
}
console.log(JSON.stringify({ passed: report.passed, runs: report.runs.map(run => ({ name: run.name, functional: run.functional, switches: run.switches, tree: run.tree, logicalClose: run.logicalClose })), result: join(evidence, 'result.json') }, null, 2))
if (!report.passed) process.exitCode = 1
