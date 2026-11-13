/**
 * 目录递归遍历器 —— glob / grep 共用的文件枚举底座（计划 D9：纯 JS 自研，
 * 不引 ripgrep/fd 二进制，跨平台零外部依赖；3.6 起用 `ignore` 包应用
 * .gitignore/.ignore 规则 —— 规则语义复杂（否定 !、目录尾斜杠、** 等），
 * 自解析是陷阱重灾区，ignore 包是 git 规范的权威 JS 实现）。
 *
 * 边界与上限：
 * - 内置忽略表（node_modules / .git / AppData / Library 等）恒生效 —— 无绑定
 *   会话以用户主目录为扫描基，缓存目录不忽略时一次 glob 就把遍历预算吃光；
 * - .gitignore / .ignore 逐目录层叠生效（步骤 3.6 对齐上游 fd 口径）：
 *   规则只影响其所在目录以下；**嵌套 git 仓库是边界** —— 外层规则止步于
 *   子仓（外层 ignore 可忽略子仓目录本身从而整支跳过；未被忽略而进入时，
 *   仓内只受子仓自己的规则约束，上游 issue #5960 同口径）；
 * - gitignore 语义上只对"被 git 跟踪的世界"有意义，但独立目录带 .gitignore
 *   也是常见用法（上游 fd --no-require-git 同判）—— 有规则文件就应用；
 * - 遍历文件数上限：防符号链接环与巨型 monorepo 把工具卡死 —— 到顶即截断，
 *   truncated 标记让工具在结果里提示模型缩小范围（配 path 子目录限定）。
 */
import { access, readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import ignore from 'ignore'

/** 内置忽略目录名（不区分大小写；只按目录名匹配，文件不受影响） */
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

/** 一层 ignore 规则：base = 规则文件所在目录，成员路径相对 base（posix） */
interface IgnoreLayer {
  base: string
  rules: ReturnType<typeof ignore>
}

/** 读目录的 .gitignore/.ignore（存在才返回层；空规则文件不建层省判定） */
async function loadIgnoreLayer(dir: string): Promise<IgnoreLayer | null> {
  const patterns: string[] = []
  for (const name of ['.gitignore', '.ignore']) {
    try {
      const content = await readFile(join(dir, name), 'utf-8')
      patterns.push(...content.split(/\r?\n/))
    } catch {
      // 无此文件是常态
    }
  }
  if (patterns.length === 0) return null
  return { base: dir, rules: ignore().add(patterns) }
}

/** entry（绝对路径）是否被某层规则忽略（目录按带尾斜杠形态再试一次 ——
 *  目录专属规则如 "build/" 只匹配目录） */
function isIgnoredByLayers(absolute: string, isDir: boolean, layers: IgnoreLayer[]): boolean {
  for (const layer of layers) {
    const rel = relative(layer.base, absolute).split(sep).join('/')
    if (rel.startsWith('../')) continue // 层基不在祖先链上（防御，正常不出现）
    if (layer.rules.ignores(rel)) return true
    if (isDir && rel !== '' && layer.rules.ignores(`${rel}/`)) return true
  }
  return false
}

/**
 * 从 scanRoot 向上收集祖先 ignore 层（到最近的 .git 仓库根为止，含仓库根
 * 自己的规则；无仓库则收到盘符 —— 独立目录的 .gitignore 也应用，上游
 * fd --no-require-git 同判）。层序从浅到深，供"任一层命中即忽略"判定。
 *
 * 已知近似（技术笔记记录）：跨层否定反悔（深层 !pattern 反悔浅层忽略）不
 * 支持 —— 单文件内的否定由 ignore 包正确处理，跨文件否定是 git 的深水区，
 * fd 全语义的代价远超收益。
 */
async function loadAncestorLayers(scanRoot: string): Promise<IgnoreLayer[]> {
  const chain: string[] = []
  let cur = scanRoot
  for (;;) {
    chain.push(cur)
    // .git 存在 = 仓库根：它的规则要（下面加载），但不再往上（更上层规则
    // 属于外层世界，git 语义不作用于本仓）
    if (await exists(join(cur, '.git'))) break
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  const layers: IgnoreLayer[] = []
  for (const dir of chain.reverse()) {
    const layer = await loadIgnoreLayer(dir)
    if (layer !== null) layers.push(layer)
  }
  return layers
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * 递归枚举 scanRoots（各根已是绝对路径，含语义由调用方决定——绑定根或主目录
 * 或模型给的绝对 path）下的全部普通文件。BFS 队列避免深递归栈；目录顺序天然
 * 稳定 = 结果可复现。
 */
export async function walkFiles(scanRoots: string[]): Promise<WalkResult> {
  const files: string[] = []
  let truncated = false
  // 根目录集合（去重比较用）：根自身的 .git 不是"嵌套仓边界"—— 祖先层
  // 收集已在 loadAncestorLayers 正确止步于根，遍历期再清层会把根自己的
  // .gitignore 规则一并误杀
  const rootSet = new Set(scanRoots.map((r) => resolve(r)))
  /** 队列元素：目录 + 该目录生效的 ignore 层（祖先 + 途经各层） */
  const queue: Array<{ dir: string; layers: IgnoreLayer[] }> = []
  for (const root of scanRoots) {
    // 根可能是单个文件（grep/glob 的 path 参数允许指文件）：直接进结果，
    // 不走目录遍历（readdir 对文件抛 ENOTDIR，静默跳过 = 文件级搜索恒空 ——
    // 冒烟 S32 揪出的存量缺口）
    try {
      const info = await stat(root)
      if (info.isFile()) {
        files.push(root)
        continue
      }
    } catch {
      // 不存在/不可 stat：入队走 readdir 的既有失败路径（空反馈可纠正）
    }
    queue.push({ dir: root, layers: await loadAncestorLayers(root) })
  }

  while (queue.length > 0) {
    if (files.length >= MAX_WALK_FILES) {
      truncated = true
      break
    }
    const { dir, layers: parentLayers } = queue.shift()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // 目录不存在/无权限：跳过该分支继续其余（外部世界失败是常态；多为模型
      // 给的 path 笔误，glob/grep 会因零结果给出可纠正的空反馈）
      continue
    }
    // 本目录自己的规则层（.gitignore/.ignore）；嵌套仓库 = 外层规则边界：
    // 遍历中发现的含 .git 目录（非 scanRoot 本身）是子仓根，丢弃全部外层
    // 从子仓重新起层（外层要忽略整个子仓得靠外层规则命中子仓目录 entry）
    let layers = parentLayers
    if (!rootSet.has(resolve(dir)) && entries.some((e) => e.name === '.git')) {
      layers = []
    }
    const own = await loadIgnoreLayer(dir)
    if (own !== null) {
      layers = [...layers, own]
    }

    for (const entry of entries) {
      const full = join(dir, entry.name)
      const isDir = entry.isDirectory()
      if (IGNORED_DIRS.has(entry.name.toLowerCase())) continue
      if (entry.name === '.gitignore' || entry.name === '.ignore') {
        // 规则文件本身不进结果（对搜索是噪音；规则已生效）
        continue
      }
      if (isIgnoredByLayers(full, isDir, layers)) continue
      if (isDir) {
        queue.push({ dir: full, layers })
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
