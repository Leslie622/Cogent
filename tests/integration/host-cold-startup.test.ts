/** 真实产物及首次出现的依赖文件路径：防止热缓存掩盖启动前的小文件加载回归。 */
import { spawn } from 'node:child_process'
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { makeTempDir, removeDir } from './harness'

async function captureStartup(entry: string, root: string): Promise<string[]> {
  const home = join(root, 'home')
  const manifest = join(root, 'loaded.json')
  mkdirSync(home, { recursive: true })
  const child = spawn(process.execPath, ['--import', pathToFileURL(resolve('tests/integration/startup-module-trace.mjs')).href, entry], {
    env: { ...process.env, COGENT_HOME: home, PI_CODING_AGENT_DIR: join(home, 'pi'),
      HOME: home, USERPROFILE: home, COGENT_HTTP_RPC: '1', COGENT_STARTUP_MODULES_OUT: manifest },
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
  })
  let diagnostics = ''
  child.stderr.on('data', (data: Buffer) => { diagnostics += data.toString() })
  const lines = createInterface({ input: child.stdout })
  let initialized = false
  try {
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error(`冷依赖启动超过 60000ms：${diagnostics}`))
      }, 60_000)
      child.once('error', reject)
      child.once('close', (code) => {
        clearTimeout(timer)
        if (code === 0 && initialized) done()
        else reject(new Error(`Host 未完成握手（exit=${code}）：${diagnostics}`))
      })
      lines.on('line', (line) => {
        const frame = JSON.parse(line) as { result?: { service?: string } }
        initialized = frame.result?.service === 'cogent-agent'
        child.stdin.end()
      })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { client: 'cold-startup-test', protocolVersion: 3 } }) + '\n')
    })
    return JSON.parse(readFileSync(manifest, 'utf8')) as string[]
  } finally {
    lines.close()
    child.kill()
  }
}

it('新依赖路径首次启动可就绪，握手前不再逐文件加载 coding-agent 与 TypeBox', async () => {
  const root = makeTempDir('cogent-cold-startup-')
  try {
    const original = join(root, 'original')
    const loaded = await captureStartup(resolve('out/main/host.js'), original)
    const modules = resolve('node_modules')
    const dependencies = loaded.filter((file) => file.startsWith(modules + sep))
    // 旧构建在握手前加载近两千个文件；约束真实加载量，避免只检查配置字面值。
    expect(dependencies.length).toBeLessThan(600)
    expect(dependencies.filter((file) => file.includes(`${sep}node_modules${sep}typebox${sep}`) && /\.[cm]?js$/.test(file))).toEqual([])

    const snapshot = join(root, 'fresh-install')
    const files = new Set(dependencies)
    // import.meta.resolve 只定位原 SDK；保留它的公开入口文件与元数据供资源定位。
    files.add(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')))
    for (const file of [...files]) {
      for (let directory = dirname(file); directory.startsWith(modules + sep); directory = dirname(directory)) {
        const metadata = join(directory, 'package.json')
        if (existsSync(metadata)) files.add(metadata)
      }
    }
    for (const file of files) {
      const target = join(snapshot, 'node_modules', file.slice(modules.length + 1))
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(file, target)
    }
    cpSync(resolve('out/main'), join(snapshot, 'main'), { recursive: true })
    writeFileSync(join(snapshot, 'package.json'), JSON.stringify({ type: 'module' }))
    const freshStarted = performance.now()
    const freshLoaded = await captureStartup(join(snapshot, 'main/host.js'), join(root, 'fresh-home'))
    expect(freshLoaded.some((file) => file.startsWith(join(snapshot, 'node_modules') + sep))).toBe(true)
    expect(freshLoaded.some((file) => file.startsWith(modules + sep))).toBe(false)
    console.info(`[cold-startup] 握手前依赖文件 ${dependencies.length} 个；新路径首次启动 ${Math.round(performance.now() - freshStarted)}ms`)
  } finally {
    removeDir(root)
  }
})
