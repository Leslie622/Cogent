/** 进程存活期的存储独占：Windows 命名管道 / Linux 抽象 Unix socket，由 OS 在崩溃时释放。 */
import { createServer, type Server } from 'node:net'
import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync } from 'node:fs'

export async function acquireStorageLease(root: string, owner: 'host' | 'shell'): Promise<Server> {
  mkdirSync(root, { recursive: true })
  const real = realpathSync.native(root)
  const canonical = process.platform === 'win32' ? real.toLowerCase() : real
  const digest = createHash('sha256').update(`${owner}:${canonical}`).digest('hex')
  if (process.platform !== 'win32' && process.platform !== 'linux')
    throw new Error('存储独占目前只支持 Windows 与 Linux')
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\cogent-${digest}` : `\0cogent-${digest}`
  const server = createServer(socket => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    server.once('error', error => reject(new Error(`数据目录已被其他 ${owner} 占用，或无法取得独占权（${real}）: ${error.message}`)))
    server.listen(path, () => resolve())
  })
  // 不用心跳猜死亡，不允许活进程被抢锁；保持引用直到调用方完成清理。
  return server
}
