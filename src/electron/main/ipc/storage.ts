/**
 * storage 域 IPC：设置页「存储」分区的占用统计源。只读扫描存储根
 * （storageRoot() = COGENT_HOME ?? ~/.cogent）顶层条目并递归累计字节数。
 * 存储根归 main 管（工作区模块单写者纪律），占用呈现自然也由壳侧供给，
 * 引擎不感知自身落盘的展示口径。无载荷 —— 没有需要校验的信任边界入参。
 *
 * 与 zcode 资源管理器存储页（扫描任务 + 进度订阅 + 清理流）对比后的取舍：
 * ~/.cogent 顶层布局小、扫描在秒级，同步式「一次请求一份快照」够用；
 * 分类映射、排序、字节格式化都在渲染层纯函数（storage-view.ts + 单测），
 * 壳契约只报每条目字节数的事实。
 */
import { handleTrusted } from './trusted'
import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC, type StorageUsageEntry } from '../../../shared/ipc'
import { storageRoot } from '../storage-root'

/** 递归累计目录字节数。符号链接不跟随：目标不属于存储根本体，且跟随会产生环 */
async function dirBytes(dir: string): Promise<number> {
  let total = 0
  const stack: string[] = [dir]
  while (stack.length > 0) {
    const current = stack.pop() as string
    // 外部世界边界（约定 §1.1）：扫描期间目录被并发删除 / 无权限是常态，
    // 跳过该层继续（du 同款口径），不让整次统计失败
    let dirents
    try {
      dirents = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const dirent of dirents) {
      const path = join(current, dirent.name)
      if (dirent.isDirectory()) stack.push(path)
      else if (dirent.isFile()) {
        try {
          total += (await stat(path)).size
        } catch {
          // 同上：中途消失 / 不可读的单个文件不计入
        }
      }
    }
  }
  return total
}

export function registerStorageIpc(): void {
  handleTrusted(IPC.storageUsage, async () => {
    const root = storageRoot()
    // 根尚未创建 = 应用从未写过任何数据（首启常态），0 字节是事实而非降级
    if (!existsSync(root)) return { root, totalBytes: 0, entries: [] }
    const dirents = await readdir(root, { withFileTypes: true })
    const entries: StorageUsageEntry[] = []
    for (const dirent of dirents) {
      const path = join(root, dirent.name)
      // 中途消失的顶层条目按 0 字节计（同 dirBytes 的外部世界口径）
      let bytes = 0
      try {
        bytes = dirent.isDirectory()
          ? await dirBytes(path)
          : dirent.isFile()
            ? (await stat(path)).size
            : 0
      } catch {
        bytes = 0
      }
      entries.push({ name: dirent.name, dir: dirent.isDirectory(), bytes })
    }
    const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0)
    return { root, totalBytes, entries }
  })
}
