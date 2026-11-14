/**
 * 写类工具的工作区软边界（阶段 1.3 自 tools/path.ts 迁入，语义不变）。
 *
 * 边界口径（D2 修订沿用）：pi 内置 write/edit 不限路径（绝对路径直写任意
 * 位置，reference/pi write.ts），Cogent 的"写限工作区根内"承诺由**审批层**
 * 兜底 —— decideApproval 在 mode 矩阵与规则表**之前**做本判定（越界恒拒，
 * 与旧工具执行层 resolveWithinRoots 同优先序：边界 > 规则表 > mode）。
 * block reason 进模型可见的工具错误结果（带可写根提示，模型可自我纠正）。
 *
 * 判定口径：path.resolve 归一后做**小写化前缀比对**（Windows 大小写不敏感；
 * macOS 默认同样不敏感；Linux 区分大小写但小写化只是放宽不是漏放）。
 * 前缀比对必须补分隔符，否则 `C:\work` 会误放行 `C:\work-secret`。
 */
import { homedir } from 'node:os'
import { isAbsolute, resolve, sep } from 'node:path'

/** 越界错误文案（block reason → 模型可见的工具错误结果；提示有效根让它自我纠正） */
export function outsideRootsMessage(roots: string[]): string {
  return `写入路径超出工作区边界。可写根目录：${roots.join('、')}`
}

/**
 * `~` 前缀展开为主目录：模型与用户都惯写 `~/.xxx`，展开后走既有解析。
 * 仅 `~` 与 `~/` 开头展开（`~user` 形态 Windows 无对应物，不碰）。
 */
function expandTilde(input: string): string {
  if (input === '~' || input.startsWith('~/') || input.startsWith('~\\')) {
    return homedir() + input.slice(1)
  }
  return input
}

/**
 * 把模型给的路径解析为**限界根内**的绝对路径（写类工具用）。
 * 返回 null = 越界 —— 调用方以 block 结果返回，不 throw。
 */
export function resolveWithinRoots(input: string, roots: string[]): string | null {
  if (roots.length === 0) return null
  // 相对路径相对首个根解析（主根，系统提示词已声明该规则）
  const expanded = expandTilde(input)
  const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(roots[0], expanded)
  const normalizedRoots = roots.map((r) => resolve(r))
  for (const root of normalizedRoots) {
    const a = absolute.toLowerCase()
    const b = root.toLowerCase()
    // 等长 = 路径即根本身（边界上属于根内）；resolve 已归一分隔符，
    // 前缀比对只需补一个 sep 防 `C:\work` 误放行 `C:\work-x`
    if (a === b || a.startsWith(b + sep)) {
      return absolute
    }
  }
  return null
}
