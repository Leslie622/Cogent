/**
 * 代码/表格行级过渡的 DOM 合同回归（docs/模块/消息呈现.md 验收 1+2）。
 * 两层合同：
 * - 行身份（探针复验过，防依赖升级静默漂移）：流式追加代码行 = 旧行 span
 *   同节点、新行新 span；异步高亮上色不换行元素；表格旧 tr 保留、新行新 tr
 *   —— 这是 globals.css 行级 mount-only 淡入（@starting-style）成立的前提：
 *   旧行元素保留才不会重播，新行是新挂载才会淡入。
 * - 作用域标记 data-md-streaming：流式（含视觉收尾暂留）为 'true'、
 *   static/历史无；终态翻转只摘属性不换行 DOM。
 * jsdom 不实现 CSS 过渡与 @starting-style，动效本身按测试用例册真机验收。
 */
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Markdown } from '@/components/ui/markdown'

const codeElement = (): HTMLElement => {
  const body = document.querySelector("[data-streamdown='code-block-body']")
  expect(body).not.toBeNull()
  const code = body!.querySelector('code')
  expect(code).not.toBeNull()
  return code!
}

describe('流式代码块行身份（mount-only 淡入的前提）', () => {
  it('追加行：旧行 span 同节点、新行是新 span、code 父元素保留', () => {
    const { rerender, unmount } = render(<Markdown content={'```ts\nconst a = 1\n'} streaming />)
    const code = codeElement()
    const before = Array.from(code.children)
    expect(before[0].textContent).toContain('const a = 1')
    expect(before.every((el) => el.tagName === 'SPAN')).toBe(true)

    rerender(<Markdown content={'```ts\nconst a = 1\nconst b = 2\n'} streaming />)
    const codeAgain = codeElement()
    expect(codeAgain).toBe(code)
    const after = Array.from(codeAgain.children)
    after.slice(0, before.length).forEach((el, index) => expect(el).toBe(before[index]))
    expect(after.length).toBe(before.length + 1)
    expect(after[after.length - 1].textContent).toContain('const b = 2')
    unmount()
  })

  it('围栏闭合（未闭合→完整代码块）不重排旧行', () => {
    const { rerender, unmount } = render(<Markdown content={'```ts\nconst a = 1\nconst b = 2\n'} streaming />)
    const before = Array.from(codeElement().children)
    rerender(<Markdown content={'```ts\nconst a = 1\nconst b = 2\nconst c = 3\n```'} streaming />)
    const after = Array.from(codeElement().children)
    after.slice(0, before.length).forEach((el, index) => expect(el).toBe(before[index]))
    unmount()
  })

  it('异步高亮到达：行元素不换（token 上色不改行 span）', { timeout: 30_000 }, async () => {
    const { unmount } = render(<Markdown content={'```ts\nconst value = 42\n'} streaming />)
    const code = codeElement()
    const before = Array.from(code.children)
    // 高亮 token 的行内 span 带 --sdm-c 颜色变量（fallback 无色）；
    // jsdom 里 shiki 走 JS 正则引擎动态加载，秒级但异步。
    await vi.waitFor(() => {
      expect(code.querySelector('[style*="--sdm-c"]')).not.toBeNull()
    }, { timeout: 25_000 })
    const after = Array.from(code.children)
    expect(after.length).toBe(before.length)
    after.forEach((el, index) => expect(el).toBe(before[index]))
    unmount()
  })
})

describe('流式表格行身份', () => {
  it('追加行：旧 tr 同节点、新行是新 tr、table 保留', () => {
    const head = '| A | B |\n| --- | --- |\n| 1 | 2 |\n'
    const { rerender, unmount } = render(<Markdown content={head} streaming />)
    const table = document.querySelector('table')
    expect(table).not.toBeNull()
    const before = Array.from(table!.querySelectorAll('tr'))
    // 分隔线不渲染成 tr：头行(thead) + 1 数据行(tbody) = 2
    expect(before.length).toBe(2)

    rerender(<Markdown content={`${head}| 3 | 4 |\n`} streaming />)
    expect(document.querySelector('table')).toBe(table)
    const after = Array.from(table!.querySelectorAll('tr'))
    before.forEach((row, index) => expect(after[index]).toBe(row))
    expect(after.length).toBe(before.length + 1)
    expect(after[after.length - 1].textContent).toContain('3')
    unmount()
  })
})

describe('data-md-streaming 作用域标记（行级淡入只在流式作用域生效）', () => {
  it('流式渲染根为 true，且真落在 code-block-body 的祖先上（CSS 选择器合同）', () => {
    const { unmount } = render(<Markdown content={'```ts\nconst a = 1\n'} streaming />)
    const root = document.querySelector("[data-slot='markdown-root']")
    expect(root).toHaveAttribute('data-md-streaming', 'true')
    // 与 globals.css 行级淡入同构的作用域链，防选择器漂移
    expect(root!.querySelector("[data-streamdown='code-block-body'] code > span")).not.toBeNull()
    unmount()
  })

  it('static/历史渲染无标记（零动画）', () => {
    const { unmount } = render(<Markdown content={'```ts\nconst a = 1\n```'} />)
    expect(document.querySelector('[data-md-streaming]')).toBeNull()
    unmount()
  })

  it('流式翻终态：无在播过渡时标记立即摘除（终态/历史零动画）', async () => {
    const { rerender, unmount } = render(<Markdown content={'```ts\nconst a = 1\nconst b = 2\n'} streaming />)
    rerender(<Markdown content={'```ts\nconst a = 1\nconst b = 2\n```'} />)
    // jsdom 无真实过渡，收尾 effect 立即转 static；摘标记后 static 树即使
    // 重挂也无 scoped 规则 = 不重播（浏览器行为另由 markdown-terminal 的
    // 行淡入收尾等待回归钉住）。
    await vi.waitFor(() => {
      expect(document.querySelector('[data-md-streaming]')).toBeNull()
    })
    unmount()
  })
})
