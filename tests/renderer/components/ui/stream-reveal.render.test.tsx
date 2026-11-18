/**
 * 流式逐词淡入的挂载语义测试（Markdown + stream-reveal 插件走真 Streamdown
 * 管线，docs/技术笔记/流式呈现动效.md 验收 2）：
 * - 首帧：单元逐个包 span[data-reveal=new] 带排期延迟；
 * - 追加帧：新单元 new、旧单元 settled 但 span 保留 —— 只包新单元时下一帧
 *   新词复用旧词 DOM 节点、动画不播（zcode 关键 bugfix 的回归钉）；
 * - 第二条消息首帧仍有 new：钉 Streamdown processor 缓存按插件函数名共用的
 *   坑（zcode 2026-11-06：启动后只有第一条消息有动画）—— 内容与第一条相同
 *   才钉得住：若实例被共用，第二条读到第一条的 committed（含同文本）→ 全
 *   settled，断言翻车；
 * - 同文块依真实实例分别记进度，细/粗分组追加仍复用旧 DOM；
 * - 原生分块重整与非前缀改写 settled，解析结构及清洗合同保持一致。
 * jsdom 不实现 CSS 过渡与 @starting-style，断言的是属性与排期样式；动效本身
 * 由 globals.css「逐词浮现」段承担。
 */
import { render } from '@testing-library/react'
import { StrictMode } from 'react'
import { describe, expect, it } from 'vitest'
import { Streamdown } from 'streamdown'
import { code } from '@streamdown/code'
import { cjk } from '@streamdown/cjk'
import { Markdown } from '@/components/ui/markdown'

const revealSpans = (): Element[] => Array.from(document.querySelectorAll('[data-reveal]'))
const expectSameNodes = (current: Element[], previous: Element[]): void => {
  previous.forEach((node, index) => expect(current[index]).toBe(node))
}

describe('Markdown 流式逐词淡入（stream-reveal 插件）', () => {
  it('首帧：每个单元包 span 标 new 并带排期延迟', () => {
    const { unmount } = render(<Markdown content="拍板决策" streaming />)
    const spans = revealSpans()
    expect(spans.map((el) => el.textContent)).toEqual(['拍', '板', '决', '策'])
    for (const el of spans) {
      expect(el).toHaveAttribute('data-reveal', 'new')
      expect(el.getAttribute('style')).toMatch(/--reveal-delay:/)
    }
    unmount()
  })

  it('追加帧：新单元 new，旧单元 settled 且 span 保留（key 稳定，动画不中断的契约）', () => {
    const { rerender, unmount } = render(<Markdown content="拍板决" streaming />)
    const previous = revealSpans()
    // 上一帧 effect 已提交本块边界；本帧只读同一实例的进度。
    // 合帧已前移入口：直接传 prop 应立即呈现，reveal 新旧单元断言不变。
    rerender(<Markdown content="拍板决策" streaming />)
    expect(revealSpans().some((el) => el.textContent === '策')).toBe(true)
    const byText = new Map(revealSpans().map((el) => [el.textContent, el.getAttribute('data-reveal')]))
    expect(byText.get('策')).toBe('new')
    expect(byText.get('拍')).toBe('settled')
    expect(byText.get('板')).toBe('settled')
    expect(byText.get('决')).toBe('settled')
    // 旧单元的 span 不拆（拆了 = 新词复用旧 DOM，动画只播一帧）
    expect(revealSpans()).toHaveLength(4)
    expectSameNodes(revealSpans(), previous)
    unmount()
  })

  it('第二条消息首帧仍有 new：processor 缓存按插件函数名共用即翻车（zcode 2026-11-06 回归钉）', () => {
    const first = render(<Markdown content="拍板决策" streaming />)
    expect(revealSpans().every((el) => el.getAttribute('data-reveal') === 'new')).toBe(true)
    first.unmount()
    // 同内容重挂：若插件实例被共用，state.committed 已含该文本 → 全 settled
    const second = render(<Markdown content="拍板决策" streaming />)
    expect(revealSpans().every((el) => el.getAttribute('data-reveal') === 'new')).toBe(true)
    second.unmount()
  })

  it('大批 live 正文压成有限连续组：完整文本仍首帧存在，不再601个单元同时淡入', () => {
    const text = '好'.repeat(601)
    const { unmount } = render(<Markdown content={text} streaming />)
    const spans = revealSpans()
    expect(spans).toHaveLength(32)
    expect(spans.every((el) => el.getAttribute('data-reveal') === 'new')).toBe(true)
    expect(spans.map((el) => el.textContent).join('')).toBe(text)
    unmount()
  })

  it('同块普通文本与粗体各601字时，64个新组仍在250ms起跳窗口内且全文完整', () => {
    const plain = '好'.repeat(601)
    const bold = '强'.repeat(601)
    const view = render(<Markdown content={`${plain} **${bold}**`} streaming />)
    const spans = Array.from(view.container.querySelectorAll<HTMLElement>('[data-reveal="new"]'))
    expect(spans).toHaveLength(64)
    expect(view.container.querySelector('[data-streamdown="strong"]')!.textContent).toBe(bold)
    expect(view.container.querySelector('.md-body')!.textContent).toBe(`${plain} ${bold}`)
    const delays = spans.map((node) => Number.parseFloat(node.style.getPropertyValue('--reveal-delay')))
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...delays)).toBeLessThanOrEqual(250)
    view.unmount()
  })

  it('同批两个601字段落各保留32个新组，共享消息排期不突破250ms起跳窗口', () => {
    const first = '甲'.repeat(601)
    const second = '乙'.repeat(601)
    const view = render(<Markdown content={`${first}\n\n${second}`} streaming />)
    const paragraphs = Array.from(view.container.querySelectorAll('p'))
    expect(paragraphs.map((node) => node.textContent)).toEqual([first, second])
    expect(paragraphs.map((node) => node.querySelectorAll('[data-reveal="new"]').length)).toEqual([32, 32])
    const spans = Array.from(view.container.querySelectorAll<HTMLElement>('[data-reveal="new"]'))
    const delays = spans.map((node) => Number.parseFloat(node.style.getPropertyValue('--reveal-delay')))
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...delays)).toBeLessThanOrEqual(250)
    view.unmount()
  })

  it('流式表格保持结构静态：不把单元格文字拆成大量 reveal span', () => {
    const { unmount } = render(<Markdown content={'| A | B |\n| - | - |\n| 好 | 世界 |'} streaming />)
    expect(document.querySelector('table')).not.toBeNull()
    expect(revealSpans()).toHaveLength(0)
    unmount()
  })

  it('流式代码块保持完整静态内容：不为动画干扰异步高亮', () => {
    const text = '```ts\nconst value = 1\n```'
    const { unmount } = render(<Markdown content={text} streaming />)
    expect(document.querySelector('pre')).not.toBeNull()
    expect(revealSpans()).toHaveLength(0)
    unmount()
  })

  it('静态模式（历史消息）不挂插件：无 span，正文原样', () => {
    const { unmount } = render(<Markdown content="拍板决策" />)
    expect(revealSpans()).toHaveLength(0)
    expect(document.querySelector('.md-body')?.textContent).toBe('拍板决策')
    unmount()
  })

  it('StrictMode 双挂载后追加立即呈现，reveal 管线仍生效（组件不再拥有合帧 timer）', () => {
    const { rerender, unmount } = render(
      <StrictMode>
        <Markdown content="拍板" streaming />
      </StrictMode>
    )
    rerender(
      <StrictMode>
        <Markdown content="拍板决策" streaming />
      </StrictMode>
    )
    // 不等待组件 timer：入口发布之后没有第二次 30ms 延迟。
    expect(revealSpans().some((el) => el.textContent === '策')).toBe(true)
    unmount()
  })

  it('先后出现的相同段落各自记进度，第二段从首字渐显且第一段 DOM 保留', () => {
    const text = '拍板决策'
    const view = render(<Markdown content={text} streaming />)
    const firstParagraph = view.container.querySelector('p')!
    const firstSpans = Array.from(firstParagraph.querySelectorAll('[data-reveal]'))
    view.rerender(<Markdown content={`${text}\n\n${text}`} streaming />)
    const paragraphs = view.container.querySelectorAll('p')
    expect(paragraphs).toHaveLength(2)
    expect(paragraphs[0]).toBe(firstParagraph)
    expectSameNodes(Array.from(paragraphs[0].querySelectorAll('[data-reveal]')), firstSpans)
    const secondSpans = Array.from(paragraphs[1].querySelectorAll('[data-reveal]'))
    expect(secondSpans.map((node) => node.textContent).join('')).toBe(text)
    expect(secondSpans.every((node) => node.getAttribute('data-reveal') === 'new')).toBe(true)
    view.rerender(<Markdown content={`${text}\n\n${text}好了`} streaming />)
    const nextSecond = view.container.querySelectorAll('p')[1]
    expectSameNodes(Array.from(nextSecond.querySelectorAll('[data-reveal]')), secondSpans)
    expect(Array.from(nextSecond.querySelectorAll('[data-reveal="new"]')).map((node) => node.textContent).join('')).toBe('好了')
    view.unmount()
  })

  it('同一批的相同段落分别排期，不用相同文本 key 合并候选', () => {
    const view = render(<Markdown content={'拍板\n\n拍板'} streaming />)
    const paragraphs = Array.from(view.container.querySelectorAll('p'))
    const spans = paragraphs.map((paragraph) => Array.from(paragraph.querySelectorAll<HTMLElement>('[data-reveal]')))
    expect(spans.map((nodes) => nodes.map((node) => node.textContent).join(''))).toEqual(['拍板', '拍板'])
    expect(spans.flat().every((node) => node.dataset.reveal === 'new')).toBe(true)
    const delays = spans.map((nodes) => nodes.map((node) => Number.parseFloat(node.style.getPropertyValue('--reveal-delay'))))
    expect(delays[1][0]).toBeGreaterThan(delays[0].at(-1)!)
    view.unmount()
  })

  it.each([96, 601])('%i字后连续追加，旧文本组不重分，新字获得新 DOM', (length) => {
    const initial = '好'.repeat(length)
    const view = render(<Markdown content={initial} streaming />)
    const before = revealSpans()
    const beforeText = before.map((node) => node.textContent)
    view.rerender(<Markdown content={`${initial}甲`} streaming />)
    expectSameNodes(revealSpans(), before)
    expect(before.map((node) => node.textContent)).toEqual(beforeText)
    const firstAppend = revealSpans().at(-1)!
    expect(firstAppend.textContent).toBe('甲')
    expect(before).not.toContain(firstAppend)
    expect(firstAppend).toHaveAttribute('data-reveal', 'new')
    view.rerender(<Markdown content={`${initial}甲乙`} streaming />)
    const after = revealSpans()
    expectSameNodes(after, before)
    expect(after.at(-2)).toBe(firstAppend)
    expect(firstAppend).toHaveAttribute('data-reveal', 'settled')
    expect(after.at(-1)!.textContent).toBe('乙')
    expect(after.at(-1)).not.toBe(firstAppend)
    expect(after.at(-1)).toHaveAttribute('data-reveal', 'new')
    expect(view.container.querySelector('.md-body')!.textContent).toBe(`${initial}甲乙`)
    view.unmount()
  })

  it('不同消息同时出现同文块，进度和 processor 均各自独立', () => {
    const view = render(<><Markdown content="拍板" streaming /><Markdown content="拍板" streaming /></>)
    const roots = Array.from(view.container.querySelectorAll('.md-body'))
    const before = roots.map((root) => Array.from(root.querySelectorAll('[data-reveal]')))
    expect(before.flat().every((node) => node.getAttribute('data-reveal') === 'new')).toBe(true)
    view.rerender(<><Markdown content="拍板" streaming /><Markdown content="拍板决策" streaming /></>)
    const after = Array.from(view.container.querySelectorAll('.md-body'))
    expectSameNodes(Array.from(after[0].querySelectorAll('[data-reveal]')), before[0])
    expectSameNodes(Array.from(after[1].querySelectorAll('[data-reveal]')), before[1])
    expect(Array.from(after[1].querySelectorAll('[data-reveal="new"]')).map((node) => node.textContent).join('')).toBe('决策')
    view.unmount()
  })

  it.each([
    ['引用定义', '第一段\n\n链接 [文档][id]', '\n\n[id]: https://example.com'],
    ['脚注定义', '第一段\n\n脚注', '[^n]\n\n[^n]: 注释正文'],
  ])('%s使原生多块合并时旧正文不重新进入渐显', (_name, initial, appended) => {
    const view = render(<Markdown content={initial} streaming />)
    expect(view.container.querySelectorAll('p')).toHaveLength(2)
    view.rerender(<Markdown content={initial + appended} streaming />)
    expect(view.container.querySelector('a')).not.toBeNull()
    expect(revealSpans().every((node) => node.getAttribute('data-reveal') === 'settled')).toBe(true)
    view.unmount()
  })

  it('脚注定义在同一块内补全时，解析语义回填不重播旧正文', () => {
    const initial = '第一段\n\n脚注[^n]'
    const view = render(<Markdown content={initial} streaming />)
    view.rerender(<Markdown content={`${initial}\n\n[^n]: 注释正文`} streaming />)
    expect(view.container.querySelector('a')).not.toBeNull()
    expect(revealSpans().every((node) => node.getAttribute('data-reveal') === 'settled')).toBe(true)
    view.unmount()
  })

  it('非前缀改写立即可读，新的块进度不沿用改写前内容', () => {
    const view = render(<Markdown content={'拍板\n\n原文'} streaming />)
    view.rerender(<Markdown content={'新的\n\n正文'} streaming />)
    expect(view.container.querySelector('.md-body')!.textContent).toBe('新的正文')
    expect(revealSpans().every((node) => node.getAttribute('data-reveal') === 'settled')).toBe(true)
    view.rerender(<Markdown content={'新的\n\n正文追加'} streaming />)
    expect(revealSpans().filter((node) => node.getAttribute('data-reveal') === 'new').map((node) => node.textContent).join('')).toBe('追加')
    view.unmount()
  })

  it.each([
    ['未闭合强调', '开头 **加粗', '开头 **加粗文字** 后续'],
    ['行内代码', '开头 `value', '开头 `value` 后续'],
    ['列表续接', '- 列表甲\n- 列表乙', '- 列表甲\n- 列表乙\n\n- 列表丙'],
    ['Setext标题', '标题', '标题\n===\n\n正文'],
    ['表格', '| 甲 | 乙 |', '| 甲 | 乙 |\n| - | - |\n| 内容 | 值 |'],
  ])('%s的结构重整继续等同原生 Streamdown', (_name, initial, next) => {
    const view = render(<Markdown content={initial} streaming />)
    view.rerender(<Markdown content={next} streaming />)
    const native = render(<Streamdown mode="streaming" plugins={{ code, cjk }} isAnimating animated={false} lineNumbers={false} linkSafety={{ enabled: false }}>{next}</Streamdown>)
    const structure = (root: HTMLElement) => Array.from(root.querySelectorAll('p,h1,h2,strong,em,ul,ol,li,table,thead,tbody,tr,th,td,code'))
      .map((node) => [node.tagName, node.textContent])
    expect(structure(view.container)).toEqual(structure(native.container))
    expect(view.container.querySelector('.md-body')!.textContent).toBe(native.container.firstElementChild!.textContent)
    view.unmount()
    native.unmount()
  })

  it('块 adapter 保留原生清洗，不能把 raw HTML 的事件属性或 script 带进 DOM', () => {
    const view = render(<Markdown content={'<div onclick="alert(1)">安全正文</div>\n\n<script>alert(1)</script>'} streaming />)
    expect(view.container.querySelector('script')).toBeNull()
    expect(view.container.querySelector('[onclick]')).toBeNull()
    expect(view.container.textContent).toContain('安全正文')
    view.unmount()
  })
})
