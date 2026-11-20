/**
 * showErrorToast 测试 —— 钉错误 toast 的呈现契约（配置在 components/ui/sonner）：
 * 标题「出错了」、详情进 description、5s 自动消失、右侧 action 槽带关闭钮
 * （点击由 sonner 自动 dismiss，无需手动dismiss）。
 */
import { describe, expect, it, vi } from 'vitest'
import { showErrorToast } from '@/components/ui/sonner'

// 类型化 mock（hoisted：vi.mock 工厂提升到 import 前，普通 const 引用不到）
const { toastError } = vi.hoisted(() => ({
  toastError: vi.fn<(title: string, options: unknown) => string | number>()
}))
vi.mock('sonner', () => ({ toast: { error: toastError } }))

describe('showErrorToast', () => {
  it('错误详情进 description，5s 自动消失，带 action 关闭钮', () => {
    showErrorToast('连接失败')
    expect(toastError).toHaveBeenCalledTimes(1)
    // 逐字段断言（嵌套 objectContaining 返回 any，过不了 no-unsafe-assignment）
    const [title, options] = toastError.mock.calls[0]
    expect(title).toBe('出错了')
    const opts = options as {
      description: string
      duration: number
      style: Record<string, string>
      action: { label: unknown; onClick: () => void }
    }
    expect(opts.description).toBe('连接失败')
    expect(opts.duration).toBe(5000)
    expect(opts.style['--width']).toBe('560px')
    expect(opts.action.onClick).toBeInstanceOf(Function)
    // label 是 JSX 图标元素（渲染细节，只钉存在）
    expect(opts.action.label).not.toBeNull()
  })
})
