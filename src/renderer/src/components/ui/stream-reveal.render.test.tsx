/**
 * 流式逐词淡入的挂载语义测试（Markdown + stream-reveal 插件走真 Streamdown
 * 管线，计划/流式呈现动效.md 验收 2）：
 * - 首帧：单元逐个包 span[data-reveal=new] 带排期延迟；
 * - 追加帧：新单元 new、旧单元 settled 但 span 保留 —— 只包新单元时下一帧
 *   新词复用旧词 DOM 节点、动画不播（zcode 关键 bugfix 的回归钉）；
 * - 第二条消息首帧仍有 new：钉 Streamdown processor 缓存按插件函数名共用的
 *   坑（zcode 2026-11-06：启动后只有第一条消息有动画）—— 内容与第一条相同
 *   才钉得住：若实例被共用，第二条读到第一条的 committed（含同文本）→ 全
 *   settled，断言翻车；
 * - 非增量（超限挂载）整段 settled 不动画。
 * jsdom 不实现 CSS 过渡与 @starting-style，断言的是属性与排期样式；动效本身
 * 由 globals.css「逐词浮现」段承担。
 */
import { render } from '@testing-library/react'
import { StrictMode } from 'react'
import { describe, expect, it } from 'vitest'
import { Markdown } from '@/components/ui/markdown'

const revealSpans = (): Element[] => Array.from(document.querySelectorAll('[data-reveal]'))

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

  it('追加帧：新单元 new，旧单元 settled 且 span 保留（key 稳定，动画不中断的契约）', async () => {
    const { rerender, unmount } = render(<Markdown content="拍板决" streaming />)
    // 上一帧 effect 已 commit；本帧读 committed=['拍板决'] 判新旧。
    // rerender 后立即断言：新字不在 DOM（30ms 合帧窗口未 flush —— 钉固定
    // 节拍存在，排期器以 30ms 批为前提是快模型积压修复的核心）
    rerender(<Markdown content="拍板决策" streaming />)
    expect(revealSpans().some((el) => el.textContent === '策')).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 40))
    const byText = new Map(revealSpans().map((el) => [el.textContent, el.getAttribute('data-reveal')]))
    expect(byText.get('策')).toBe('new')
    expect(byText.get('拍')).toBe('settled')
    expect(byText.get('板')).toBe('settled')
    expect(byText.get('决')).toBe('settled')
    // 旧单元的 span 不拆（拆了 = 新词复用旧 DOM，动画只播一帧）
    expect(revealSpans()).toHaveLength(4)
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

  it('非增量帧（超 600 字符的挂载/回填）：整段 settled、不动画', () => {
    const { unmount } = render(<Markdown content={'好'.repeat(601)} streaming />)
    const spans = revealSpans()
    expect(spans.length).toBe(601)
    expect(spans.every((el) => el.getAttribute('data-reveal') === 'settled')).toBe(true)
    unmount()
  })

  it('静态模式（历史消息）不挂插件：无 span，正文原样', () => {
    const { unmount } = render(<Markdown content="拍板决策" />)
    expect(revealSpans()).toHaveLength(0)
    expect(document.querySelector('.md-body')?.textContent).toBe('拍板决策')
    unmount()
  })

  it('StrictMode 双挂载后流式仍能 flush —— 卸载 cleanup 只 clear 不置 null 时，合帧 timer 死于 StrictMode 首轮清理，此后 displayContent 恒停初值、收尾一次性直通全部内容（真机「不流式、一股脑」的回归钉）', async () => {
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
    // 合帧窗口 30ms：修复后 flush 生效，新字带 span 上屏
    await new Promise((resolve) => setTimeout(resolve, 45))
    expect(revealSpans().some((el) => el.textContent === '策')).toBe(true)
    unmount()
  })
})
