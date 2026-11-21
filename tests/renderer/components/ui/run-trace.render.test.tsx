/** 终态详情默认收起；手动开合归本实例，不随状态词或父层重渲染被覆盖。 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { RunTrace, type RunPhase } from '@/components/ui/run-trace'

const phases: Array<[RunPhase, string]> = [
  ['done', '用时 1.00 秒'],
  ['stopped', '已停止'],
  ['failed', '出错了'],
]

describe('RunTrace 终态详情开合', () => {
  it.each(phases)('%s 默认收起，头条仍可见', (phase, label) => {
    render(<RunTrace phase={phase} durationMs={1_000}><div>过程详情</div></RunTrace>)
    expect(screen.getByRole('button', { name: label })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('过程详情')).not.toBeVisible()
  })

  it('停止后仍可手动展开再收起，过程节点保持同一个实例', async () => {
    render(<RunTrace phase="stopped"><div data-testid="process">过程详情</div></RunTrace>)
    const trigger = screen.getByRole('button', { name: '已停止' })
    const process = screen.getByTestId('process')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(process).toBeVisible()
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await waitFor(() => expect(process).not.toBeVisible())
    expect(screen.getByTestId('process')).toBe(process)
  })

  it('手动选择在父层重渲染与终态词变化后保留', () => {
    const view = render(<RunTrace phase="done"><div>过程详情</div></RunTrace>)
    fireEvent.click(screen.getByRole('button', { name: '用时' }))
    view.rerender(<RunTrace phase="stopped"><div>过程详情更新</div></RunTrace>)
    expect(screen.getByRole('button', { name: '已停止' })).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByRole('button', { name: '已停止' }))
    view.rerender(<RunTrace phase="failed"><div>过程详情更新</div></RunTrace>)
    expect(screen.getByRole('button', { name: '出错了' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('无详情只显示头条，不生成无效开合入口', () => {
    const { container } = render(<RunTrace phase="stopped" />)
    expect(screen.getByText('已停止')).toBeVisible()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(container.querySelector('[data-slot="trace-collapsible-content"]')).toBeNull()
  })

  it('同实例从无详情变为有详情仍默认收起', () => {
    const view = render(<RunTrace phase="stopped" />)
    view.rerender(<RunTrace phase="stopped"><div>稍后到达的详情</div></RunTrace>)
    expect(screen.getByRole('button', { name: '已停止' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('稍后到达的详情')).not.toBeVisible()
  })
})
