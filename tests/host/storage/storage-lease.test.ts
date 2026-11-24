/** 真实 OS 端点排他：路径别名同锁、不同 owner 分域、强退后自动释放。 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { acquireStorageLease } from '../../../src/node/storage-lease'

it('活进程不可抢锁，路径别名不绕过，强退后可重新取得', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cogent-lease-')), alias = root + '-alias'
  symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const module = pathToFileURL(resolve('src/node/storage-lease.ts')).href
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { acquireStorageLease } from ${JSON.stringify(module)}; await acquireStorageLease(${JSON.stringify(root)}, 'host'); process.stdout.write('ready');`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  try {
    await new Promise<void>((done, reject) => {
      child.stdout.once('data', () => done())
      child.once('exit', code => reject(new Error(`lease child exited ${code}`)))
      child.once('error', reject)
    })
    await expect(acquireStorageLease(alias, 'host')).rejects.toThrow('占用')
    const shell = await acquireStorageLease(root, 'shell')
    await new Promise<void>(done => shell.close(() => done()))
    const other = await acquireStorageLease(join(root, 'other'), 'host')
    await new Promise<void>(done => other.close(() => done()))
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
    const recovered = await acquireStorageLease(alias, 'host')
    await new Promise<void>(done => recovered.close(() => done()))
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited }
    // 先确认 alias 是本测试创建的 junction，再移除链接本身。
    rmSync(alias, { force: true, recursive: process.platform === 'win32' })
    rmSync(root, { recursive: true, force: true })
  }
}, 15_000)
