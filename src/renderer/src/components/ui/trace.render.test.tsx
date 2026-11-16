/**
 * Trace 折叠族挂载语义测试：keepMounted —— 收起不卸载（回归钉）。
 * 折叠卡顿（2026-11-16 用户实测）主源 = Panel 关闭即卸载，每次展开都要在
 * 点击任务里同步重挂载整棵子树（Streamdown/Shiki/工具卡）；keepMounted 后
 * 内容 hidden 常驻，展开只剩浏览器 layout+paint。钉的行为 = 收起态内容
 * 仍在文档且不可见，点击开合路径不受影响（TraceCollapsible 家族消费：
 * RunTrace / Reasoning / ToolCard / CompactionBar 全走本件；开合动画走
 * CSS 过渡，jsdom 不参与，本件只钉挂载语义）。
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace'

describe('TraceCollapsible 挂载语义（keepMounted）', () => {
  it('收起态内容常驻 DOM 但不可见（hidden）：展开零重挂载 —— 折叠卡顿修复的行为契约', () => {
    render(
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceTitle>头条</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <div>过程内容</div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    )
    // 常驻（keepMounted）：卸载语义回归时本断言即翻车
    expect(screen.getByText('过程内容')).toBeInTheDocument()
    // 收起不占渲染：Base UI 对 keepMounted 的收起面板挂 hidden
    expect(screen.getByText('过程内容')).not.toBeVisible()
  })

  it('轨道必须显式 minmax(0,…)：裸 0fr/1fr 带自动最小尺寸（= 内层 12px padding 地板），收起末段钉死 12px 再瞬跳 —— 2026-11-16 fold-lab 逐帧采样的真凶，类名钉防"简化"回裸 fr；内层纵向 padding 必须随开合收拢（静态 padding 的尾段裁的是空隙，观感"留一点高度 opacity 式消失"）', () => {
    const { container } = render(
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceTitle>头条</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <div>过程内容</div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    )
    const panel = container.querySelector('[data-slot=trace-collapsible-content]')
    expect(panel?.className).toContain('grid-rows-[minmax(0,0fr)]')
    expect(panel?.className).toContain('data-open:grid-rows-[minmax(0,1fr)]')
    const inner = container.querySelector('[data-slot=trace-collapsible-content-inner]')
    expect(inner?.className).toContain('group-data-open/trace-collapsible:pt-2')
    expect(inner?.className).toContain('transition-[padding]')
  })

  it('折叠体平级无导线（2026-11-16 用户定调，决定 18）：内层不得回潮 ml/border-l/pl-4 导线缩进 —— 折叠体与头条同级，分隔由消费方分割线承担；TraceLine 收回 select-none（消息流容器为正文放开 select-text，chrome 行不能再被拖选成片）', () => {
    const { container } = render(
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceTitle>头条</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <div>过程内容</div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    )
    const inner = container.querySelector('[data-slot=trace-collapsible-content-inner]')
    // 导线三件套（border-l 竖线 / pl-4 文字缩进）防"顺手恢复层级"
    expect(inner?.className).not.toContain('border-l')
    expect(inner?.className).not.toContain('pl-4')
    // 轨迹行 chrome 收回选中（放开区里的行头不蓝选）
    const line = container.querySelector('[data-slot=trace-line]')
    expect(line?.className).toContain('select-none')
  })

  it('点击开合路径不受影响：展开可见、再收起回 hidden（动画走 CSS 过渡，jsdom 不参与）', async () => {
    render(
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceTitle>头条</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <div>过程内容</div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    )
    await userEvent.click(screen.getByText('头条'))
    expect(screen.getByText('过程内容')).toBeVisible()
    await userEvent.click(screen.getByText('头条'))
    expect(screen.getByText('过程内容')).not.toBeVisible()
  })
})
