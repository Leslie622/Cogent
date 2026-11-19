/** 快照与生成物必须一致；模拟上游改 CSS/新增令牌，检查入口能给出变更诊断。 */
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('本地基准检查通过，外部变化只报告，不覆写快照', () => {
  const cli = ['scripts/themd-theme.mjs', '--check']
  const baseline = spawnSync(process.execPath, cli, { encoding: 'utf8' })
  expect(baseline.status, baseline.stderr).toBe(0)
  const directory = mkdtempSync(join(tmpdir(), 'cogent-themd-'))
  const local = resolve('src/renderer/src/lib/theme/upstream')
  const savedManifest = readFileSync(join(local, 'manifest.json'), 'utf8')
  const manifest = JSON.parse(savedManifest) as { files: Record<string, string> }
  try {
    for (const file of Object.keys(manifest.files)) {
      const target = join(directory, file)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, readFileSync(join(local, `${file.split('/').at(-1)}.txt`)))
    }
    writeFileSync(join(directory, 'src/styles/theme-base.css'), '.themd-prose h1 { font-size: 3em; }')
    writeFileSync(join(directory, 'src/lib/theme/tokens.ts'), "export const TOKEN_VAR = { 'new.key': '--t-new' }")
    const result = spawnSync(process.execPath, [...cli, directory], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('上游有变化：src/styles/theme-base.css')
    expect(result.stdout).toContain('上游有变化：src/lib/theme/tokens.ts')
    expect(readFileSync(join(local, 'manifest.json'), 'utf8')).toBe(savedManifest)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
