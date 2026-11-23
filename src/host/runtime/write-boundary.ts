/**
 * 写类工具的工作区根内判定。pi 内置 write/edit 不限路径，本判定不决定放拦
 *（auto/autonomous 完全放行、ask 越界弹面板可手许 —— 人是最终裁决者），
 * 只决定 ask 是否可吃「始终允许」规则：**规则 = 根内信任记忆，永不覆盖
 * 越界写**（审批面板对越界请求隐藏「始终允许此工作区」）。
 *
 * 相对路径按工具工作目录解析，目录比较使用 Node 的平台路径语义。
 */
import { isAbsolute, relative, sep } from 'node:path'
import { resolveToolFilePath } from './files/paths'

/**
 * 返回实际包含目标的工作区根，给规则表匹配。原根字符串也是已保存规则的标识。
 */
export function matchingWriteRoots(input: string, cwd: string, roots: string[]): string[] {
  let absolute: string
  try {
    absolute = resolveToolFilePath(input, { cwd, platform: process.platform })
  } catch (error) {
    // 文件 URL 的无效主机、转义或协议语法无法归入已授权根。
    if (error instanceof TypeError || error instanceof URIError) return []
    throw error
  }
  return roots.filter((root) => {
    const inside = relative(root, absolute)
    return !isAbsolute(inside) && inside !== '..' && !inside.startsWith('..' + sep)
  })
}
