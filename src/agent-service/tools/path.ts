/**
 * 工具路径解析 —— 相对路径的基解析 + 写类工具的工作区软边界。
 *
 * 边界口径（D2 修订，2026-11-10 用户驳回原“全工具限界”设计）：
 * - **只读工具不限界**（对齐 Claude Code：Read/Glob/Grep 默认全盘允许）——
 *   相对路径相对“基根”解析（绑定主根，无绑定 = 用户主目录），绝对路径任意；
 * - **写/exec 类工具软边界**（批次 2 消费）：resolve 后必须落在工作区根
 *   （无根会话 = 主目录）内，越界以工具 error 结果返回（模型可见原因，
 *   会自我纠正），不静默拒绝也不崩进程 —— OS 级硬沙箱不做（前计划 D6）。
 *
 * 判定口径：path.resolve 归一后做**小写化前缀比对**（Windows 大小写不敏感；
 * macOS 默认同样不敏感；Linux 区分大小写但小写化只是放宽不是漏放）。
 * 前缀比对必须补分隔符，否则 `C:\work` 会误放行 `C:\work-secret`。
 */
import { isAbsolute, resolve, sep } from 'node:path'

/** 越界错误文案前缀（写类工具返回给模型；提示有效根让它自我纠正） */
export function outsideRootsMessage(roots: string[]): string {
  return `写入路径超出工作区边界。可写根目录：${roots.join('、')}`
}

/**
 * 相对路径 → 基根下的绝对路径（只读工具用，不设界）。
 * 绝对路径原样归一。基根 = 工作区绑定根（首个为主根），无绑定时调用方
 * 传用户主目录 —— 保证"任何会话都有工具"的主流口径（桌面应用的 launch cwd）。
 */
export function resolveAgainstBase(input: string, baseRoots: string[]): string {
  return isAbsolute(input) ? resolve(input) : resolve(baseRoots[0], input)
}

/**
 * 把模型给的路径解析为**限界根内**的绝对路径（写/exec 类工具用）。
 * 返回 null = 越界 —— 调用方以工具 error 结果返回，不 throw
 * （throw 在 pi 里同为 error 结果，但走文本更可控）。
 */
export function resolveWithinRoots(input: string, roots: string[]): string | null {
  if (roots.length === 0) return null
  // 相对路径相对首个根解析（主根，系统提示词已声明该规则）
  const absolute = isAbsolute(input) ? resolve(input) : resolve(roots[0], input)
  const normalizedRoots = roots.map((r) => resolve(r))
  for (const root of normalizedRoots) {
    const a = absolute.toLowerCase()
    const b = root.toLowerCase()
    // 等长 = 路径即根本身（读目录会由各工具自行报"不是文件"，边界上属于根内）；
    // resolve 已归一分隔符，前缀比对只需补一个 sep 防 `C:\work` 误放行 `C:\work-x`
    if (a === b || a.startsWith(b + sep)) {
      return absolute
    }
  }
  return null
}
