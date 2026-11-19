/** 通过真实 CLI 验证字号门禁，包含带前缀、模板、CSS 和颜色类的代表场景。 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

it.each([
  ['normal.tsx', 'const view = <span className="text-sm md:text-xs text-[#abcdef] text-foreground" />', true],
  ['pixel.tsx', 'const view = <span className="md:text-[13px]" />', false],
  ['rem.tsx', 'const view = <span className="text-[0.8rem]" />', false],
  ['style.tsx', 'const view = <span style={{ fontSize: 13 }} />', false],
  ['variable.tsx', 'const view = <span className="text-[length:var(--own-size)]" />', false],
  ['dynamic.tsx', 'const view = <span className={`text-[${size}px]`} />', false],
  ['direct.ts', 'document.body.style.fontSize = "13px"', false],
  ['escape.css', '.label { font-size: 13px; }', false],
  ['property.tsx', 'const view = <span style={{ ["fontSize"]: 13 }} />', false],
  ['bracket.ts', 'document.body.style["fontSize"] = "13px"', false],
  ['mutate.ts', 'document.body.style.setProperty(property, "13px")', false],
  ['variable.css', '.label { --text-sm: 13px; }', false],
  ['color.tsx', 'const view = <span className="hover:text-[color:var(--brand)] text-xs!" />', true],
])('字号检查 %s 的退出状态与诊断符合约束', (filename, source, allowed) => {
  const directory = mkdtempSync(join(tmpdir(), 'cogent-typography-'))
  const file = join(directory, filename)
  try {
    writeFileSync(file, source)
    const result = spawnSync(process.execPath, ['scripts/check-typography.mjs', file], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(allowed ? 0 : 1)
    if (!allowed) expect(result.stderr).toContain(`${filename}:1:`)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
