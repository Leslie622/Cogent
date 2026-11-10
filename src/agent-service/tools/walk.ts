/**
 * 目录递归遍历器 —— glob / grep 共用的文件枚举底座（计划 D9：纯 JS 自研，
 * 不引 ripgrep 二进制，跨平台零依赖）。
 *
 * 边界与上限：
 * - 默认忽略 node_modules / .git / AppData / Library 等（D2 修订后无绑定会话
 *   以用户主目录为扫描基 —— 不忽略缓存目录时主目录一次 glob 就把遍历预算
 *   吃光且净是噪音；按目录名匹配，项目内的同名目录会被一并忽略，可接受）；
 * - 遍历文件数上限：防符号链接环与巨型 monorepo 把工具卡死 —— 到顶即截断，
 *   truncated 标记让工具在结果里提示模型缩小范围（配 path 子目录限定）。
 */
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** 忽略目录名（不区分大小写；只按目录名匹配，文件不受影响） */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  // 主目录场景的缓存/系统目录（Windows AppData、macOS Library、通用点缓存）
  'appdata',
  'library',
  '.cache',
  '.npm'
])

/** 单次遍历的文件数硬上限（截断标记由调用方消费） */
const MAX_WALK_FILES = 20_000

export interface WalkResult {
  /** 命中文件的绝对路径 */
  files: string[]
  /** true = 达到遍历上限被截断（结果可能不完整，需提示模型缩小范围） */
  truncated: boolean
}

/**
 * 递归枚举 scanRoots（各根已是绝对路径，含语义由调用方决定——绑定根或主目录
 * 或模型给的绝对 path）下的全部普通文件。BFS 队列避免深递归栈；目录顺序天然
 * 稳定 = 结果可复现。
 */
export async function walkFiles(scanRoots: string[]): Promise<WalkResult> {
  const files: string[] = []
  let truncated = false
  const queue: string[] = [...scanRoots]

  while (queue.length > 0) {
    if (files.length >= MAX_WALK_FILES) {
      truncated = true
      break
    }
    const dir = queue.shift()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // 目录不存在/无权限：跳过该分支继续其余（外部世界失败是常态；多为模型
      // 给的 path 笔误，glob/grep 会因零结果给出可纠正的空反馈）
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name.toLowerCase())) queue.push(full)
      } else if (entry.isFile()) {
        files.push(full)
        if (files.length >= MAX_WALK_FILES) {
          truncated = true
          break
        }
      }
    }
  }
  return { files, truncated }
}

/** glob 模式 → 正则（** 跨目录、* 单段、? 单字符；分隔符统一按 posix 比较） */
export function globToRegex(pattern: string): RegExp {
  const posix = pattern.replace(/\\/g, '/')
  let regex = '^'
  for (let i = 0; i < posix.length; i++) {
    const ch = posix[i]
    if (ch === '*') {
      if (posix[i + 1] === '*') {
        // `**/` 与 `**` 都当"任意层级"（含零层）——模型常写 `**/*.ts`
        regex += '(?:[^/]+/)*'
        i += posix[i + 2] === '/' ? 2 : 1
      } else {
        regex += '[^/]*'
      }
    } else if (ch === '?') {
      regex += '[^/]'
    } else {
      regex += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(regex + '$')
}

/** 绝对路径 → 相对某根的 posix 风格相对路径（不在任何根下返回 null，仅作显示） */
export function relativeDisplay(absolute: string, roots: string[]): string | null {
  const normalized = resolve(absolute)
  for (const root of roots.map((r) => resolve(r))) {
    const rel = normalized.slice(root.length)
    if (rel.startsWith('\\') || rel.startsWith('/')) return rel.slice(1).replace(/\\/g, '/')
  }
  return null
}
