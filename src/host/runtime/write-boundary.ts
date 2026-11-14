/**
 * 写类工具的工作区根内判定。pi 内置 write/edit 不限路径，本判定不决定放拦
 *（auto/autonomous 完全放行、ask 越界弹面板可手许 —— 人是最终裁决者），
 * 只决定 ask 是否可吃「始终允许」规则：**规则 = 根内信任记忆，永不覆盖
 * 越界写**（审批面板对越界请求隐藏「始终允许此工作区」）。
 *
 * 判定口径：path.resolve 归一后做**小写化前缀比对**（Windows 大小写不敏感；
 * macOS 默认同样不敏感；Linux 区分大小写但小写化只是放宽不是漏放）。
 * 前缀比对必须补分隔符，否则 `C:\work` 会误放行 `C:\work-secret`。
 */
import { homedir } from 'node:os'
import { isAbsolute, resolve, sep } from 'node:path'

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
