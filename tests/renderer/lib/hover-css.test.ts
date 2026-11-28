/** 全局悬停默认规则与滑动层样式的存在性断言：jsdom 不加载样式表，这里只守规则不被误删、
 *  不被挪出 base 层（真实层叠与时长由 Electron 探针验证）。 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

// vitest 的 web 工程里 import.meta.url 不是 file 协议，按进程工作目录（项目根）定位
const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/globals.css'), 'utf8')

it('base 层默认过渡：按 hover: 类与浮层行 data-slot 命中，时长读外观变量，不含 transform', () => {
  const start = css.indexOf(":where([class*='hover:']")
  expect(start).toBeGreaterThan(0)
  // 规则必须仍在 @layer base 之内：从最近的层起点到这里花括号深度为正
  const layerStart = css.lastIndexOf('@layer base {', start)
  const depth = [...css.slice(layerStart, start)].reduce((d, ch) => d + (ch === '{' ? 1 : ch === '}' ? -1 : 0), 0)
  expect(depth).toBeGreaterThan(0)
  const rule = css.slice(start, css.indexOf('}', start))
  expect(rule).toContain("[data-slot$='-menu-item']")
  expect(rule).toContain("[data-slot$='-menu-sub-trigger']")
  expect(rule).toContain("[data-slot='select-item']")
  expect(rule).toContain('background-color var(--hover-transition-duration, 150ms) ease-out')
  expect(rule).toContain('color var(--hover-transition-duration, 150ms) ease-out')
  expect(rule).not.toContain('transform')
  expect(rule).not.toContain('translate')
})

it('滑动层：胶囊垫底、行底色压制、减少动画强制 0ms；侧栏专用胶囊已并入通用层', () => {
  expect(css).toMatch(/\.hover-slide-pill\s*\{[^}]*z-index:\s*-1/)
  expect(css).toContain('[data-hover-slide][data-pill-over] {')
  expect(css).toContain('--hover-transition-duration: 0ms !important')
  expect(css).not.toContain('.sidebar-hover-pill')
})
