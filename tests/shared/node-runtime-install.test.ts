/** 从隔离目录执行真实下载脚本，完整记录才允许跳过网络。 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const platformDirs: Partial<Record<string, string>> = {
  'win32-x64': 'win-x64', 'linux-x64': 'linux-x64', 'linux-arm64': 'linux-arm64'
}
const platformDir = platformDirs[`${process.platform}-${process.arch}`]
const digest = (bytes: string): string => createHash('sha256').update(bytes).digest('hex')

it.skipIf(platformDir === undefined)('只在本机锁定版本的运行时、许可证与摘要完整一致时跳过', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cogent-runtime-install-'))
  const script = join(root, 'scripts', 'fetch-runtime.mjs')
  const destination = join(root, 'resources', 'runtime', platformDir!)
  const bin = join(destination, 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
  const license = join(destination, 'LICENSE')
  const manifest = join(destination, 'runtime.json')
  mkdirSync(join(root, 'scripts'))
  mkdirSync(join(destination, 'bin'), { recursive: true })
  copyFileSync(resolve('scripts/fetch-runtime.mjs'), script)
  writeFileSync(bin, 'binary', { mode: 0o755 })

  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url ?? '')
    response.writeHead(404).end()
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  try {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('测试 HTTP 服务未返回端口')
    const run = () => promisify(execFile)(process.execPath, [script], {
      env: { ...process.env, NODE_DIST_MIRROR: `http://127.0.0.1:${address.port}` }
    })
    await expect(run()).rejects.toThrow('下载失败 404')
    const nodeVersion = /^\/v([\d.]+)\/SHASUMS256\.txt$/.exec(requests[0])![1]
    const os = process.platform === 'win32' ? 'win' : 'linux'
    const extension = process.platform === 'win32' ? 'zip' : 'tar.gz'
    writeFileSync(license, 'license')
    writeFileSync(manifest, JSON.stringify({
      nodeVersion, platform: process.platform, arch: process.arch,
      archive: `node-v${nodeVersion}-${os}-${process.arch}.${extension}`,
      sha256: 'a'.repeat(64), executableSha256: digest('binary'), licenseSha256: digest('license')
    }))
    expect((await run()).stdout).toContain('跳过')
    expect(requests).toHaveLength(1)

    writeFileSync(bin, 'damaged')
    await expect(run()).rejects.toThrow('下载失败 404')
    expect(requests).toHaveLength(2)
    writeFileSync(bin, 'binary')
    rmSync(license)
    await expect(run()).rejects.toThrow('下载失败 404')
    expect(requests).toHaveLength(3)
  } finally {
    await new Promise<void>(done => server.close(() => done()))
    rmSync(root, { recursive: true, force: true })
  }
})
