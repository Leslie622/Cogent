/**
 * integration project 的 globalSetup（docs/模块/测试.md）：
 * 集成入口或 worker 缺失、或早于源码与构建输入时自动
 * `npm run build`。效果：`npm test` 一条命令即全绿，无需记得先 build；
 * 集成测试恒跑最新打包产物（单测直读源码）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ENTRIES = ['host', 'mcp', 'attachment-worker', 'search-worker', 'file-view-worker', 'change-diff-worker']
  .map((name) => join('out', 'main', `${name}.js`))
const SOURCE_ROOTS = ['src/host', 'src/electron', 'src/shared', 'src/protocol']
const BUILD_INPUTS = ['electron.vite.config.ts', 'package.json', 'package-lock.json', 'scripts/pdf-assets.ts', 'scripts/preview-licenses.ts']

const missingEntries = (): string[] => ENTRIES.filter((entry) => !existsSync(entry))

/** 目录树内最新 mtime（递归；不存在返回 0） */
function newestMtime(dir: string): number {
  if (!existsSync(dir)) return 0
  let best = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    best = Math.max(best, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs)
  }
  return best
}

export default function globalSetup(): void {
  const sourceMtime = Math.max(...SOURCE_ROOTS.map(newestMtime), ...BUILD_INPUTS.map((file) => statSync(file).mtimeMs))
  if (missingEntries().length > 0 || ENTRIES.some((entry) => statSync(entry).mtimeMs < sourceMtime)) {
    console.log('[integration global-setup] 构建产物缺失或过期，执行 npm run build …')
    const run = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', shell: true })
    if (run.status !== 0) throw new Error(`npm run build 失败（exit=${run.status ?? 'null'}）—— 集成测试依赖构建产物`)
    const missing = missingEntries()
    if (missing.length > 0) throw new Error(`构建后缺少集成入口：${missing.join('、')}`)
  }
}
