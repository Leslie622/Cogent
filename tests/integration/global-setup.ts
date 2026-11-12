/**
 * integration project 的 globalSetup（docs/计划-测试体系.md D5）：
 * 守卫构建产物新鲜度 —— out/main/service.js 缺失、或比引擎侧源码
 * （agent-service / electron / shared / protocol）任一文件旧，就自动
 * `npm run build`。效果：`npm test` 一条命令即全绿，无需记得先 build；
 * 集成测试恒跑最新打包产物（单测直读源码，两层口径分工见计划 D5）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SERVICE = join('out', 'main', 'service.js')
const SOURCE_ROOTS = ['src/agent-service', 'src/electron', 'src/shared', 'src/protocol']

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
  const serviceMtime = existsSync(SERVICE) ? statSync(SERVICE).mtimeMs : 0
  const sourceMtime = Math.max(...SOURCE_ROOTS.map(newestMtime))
  if (serviceMtime < sourceMtime) {
    console.log('[integration global-setup] 构建产物缺失或过期，执行 npm run build …')
    const run = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', shell: true })
    if (run.status !== 0) throw new Error(`npm run build 失败（exit=${run.status ?? 'null'}）—— 集成测试依赖构建产物`)
  }
}
