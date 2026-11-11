/**
 * 文件写变更队列（步骤 3.2）—— 同文件的写操作串行化，不同文件照常并行。
 *
 * 搬运自 pi 上游 reference/pi/packages/coding-agent/src/core/tools/file-mutation-queue.ts
 * （MIT License, Copyright (c) 2025 Mario Zechner），算法原样。为什么需要：
 * pi 引擎并行执行同一批工具调用（tools-approval 笔记实测同批 glob 三连并行），
 * 两个 write 同时落一个文件 = 截断/分块写交错，内容互相撕裂；按目标路径建
 * Promise 链把同文件写排成一队即可。edit（批次 3.3）入同一队列 —— write 整写
 * 与 edit 读改写撞同一文件同样会撕裂。
 *
 * 键 = realpath（符号链接/大小写归一到真实路径）；目标文件还不存在时
 * （ENOENT/ENOTDIR）退回 resolve 后的路径 —— 首个写创建文件后，后续写走
 * realpath 命中同一条队。registrationQueue 把"查键-接链"这段注册区本身串行，
 * 防两个并发注册在 Map 读写上交错插队。
 */

import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'

const fileMutationQueues = new Map<string, Promise<void>>()
let registrationQueue = Promise.resolve()

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

async function getMutationQueueKey(filePath: string): Promise<string> {
  const resolvedPath = resolve(filePath)
  try {
    return await realpath(resolvedPath)
  } catch (error) {
    if (isMissingPathError(error)) {
      return resolvedPath
    }
    throw error
  }
}

/**
 * 把 fn 排进目标文件的变更队列执行：同文件前序写完成后才开跑，完成后放行
 * 后继。fn 抛错也放行（finally），队列本身不因单次失败卡死。
 */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const registration = registrationQueue.then(async () => {
    const key = await getMutationQueueKey(filePath)
    const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve()

    let releaseNext!: () => void
    const nextQueue = new Promise<void>((resolveQueue) => {
      releaseNext = resolveQueue
    })
    const chainedQueue = currentQueue.then(() => nextQueue)
    fileMutationQueues.set(key, chainedQueue)

    return { key, currentQueue, chainedQueue, releaseNext }
  })
  // 注册段吞错保持链活（真错误会在 await registration 处原样抛给调用方）
  registrationQueue = registration.then(
    () => undefined,
    () => undefined
  )

  const { key, currentQueue, chainedQueue, releaseNext } = await registration
  await currentQueue
  try {
    return await fn()
  } finally {
    releaseNext()
    // 队尾是自己才删项：后继已注册时删掉会把后继的链头丢掉
    if (fileMutationQueues.get(key) === chainedQueue) {
      fileMutationQueues.delete(key)
    }
  }
}
