/** 正文业务结束与视觉收尾分开：真实Streamdown节点保留，动画Promise由测试控制。 */
import { act, fireEvent, render } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { code } from '@streamdown/code'
import { cjk } from '@streamdown/cjk'
import { Streamdown, type StreamdownProps } from 'streamdown'
import { Markdown } from './markdown'

const received = vi.hoisted(() => [] as Array<Pick<StreamdownProps, 'isAnimating' | 'mode'>>)
vi.mock('streamdown', async (importOriginal) => {
  const original = await importOriginal<typeof import('streamdown')>()
  return {
    ...original,
    Streamdown: (props: StreamdownProps) => {
      received.push({ isAnimating: props.isAnimating, mode: props.mode })
      return <original.Streamdown {...props} />
    },
  }
})

class RevealTransition {
  transitionProperty: string
  effect: { target: Element }
  playState: AnimationPlayState = 'running'
  finished: Promise<Animation>
  resolve!: (animation: Animation) => void
  reject!: (error: Error) => void

  constructor(target: Element, property = 'opacity') {
    this.transitionProperty = property
    this.effect = { target }
    this.finished = new Promise<Animation>((resolve, reject) => { this.resolve = resolve; this.reject = reject })
  }
  finish() { this.playState = 'finished'; this.resolve(this as unknown as Animation) }
  cancel() { this.playState = 'idle'; this.reject(new DOMException('Transition cancelled', 'AbortError')) }
}

let animations: Animation[]
let hidden: boolean
const getAnimations = vi.fn(() => animations)
beforeEach(() => {
  animations = []
  hidden = false
  received.length = 0
  vi.stubGlobal('CSSTransition', RevealTransition)
  getAnimations.mockClear()
  vi.spyOn(Element.prototype, 'getAnimations').mockImplementation(getAnimations)
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

const spans = (container: HTMLElement): HTMLElement[] => Array.from(container.querySelectorAll('[data-reveal]'))
const animate = (target: Element, property = 'opacity') => {
  const transition = new RevealTransition(target, property)
  animations.push(transition as unknown as Animation)
  return transition
}
const finish = async (transition: RevealTransition) => {
  await act(async () => { transition.finish(); await Promise.resolve() })
}

describe('Markdown终态自然收尾', () => {
  it('终态立即关闭业务isAnimating，已有节点等真实过渡完成后才切static', async () => {
    const view = render(<StrictMode><Markdown content="拍板" streaming /></StrictMode>)
    const before = spans(view.container)
    const transition = animate(before[1])
    view.rerender(<StrictMode><Markdown content="拍板" /></StrictMode>)
    expect(received.at(-1)).toEqual({ mode: 'streaming', isAnimating: false })
    expect(getAnimations).toHaveBeenLastCalledWith({ subtree: true })
    expect(spans(view.container)[0]).toBe(before[0])
    expect(spans(view.container)[1]).toBe(before[1])
    await finish(transition)
    expect(received.at(-1)).toEqual({ mode: 'static', isAnimating: false })
    expect(spans(view.container)).toHaveLength(0)
    expect(view.container.querySelector('.md-body')!.textContent).toBe('拍板')
    expect(before.every((node) => !node.isConnected)).toBe(true)
  })

  it('终态同批补入尾字立即存在且不新增排期，旧节点继续等待已有动画', async () => {
    const view = render(<Markdown content="拍板" streaming />)
    const before = spans(view.container)
    const transition = animate(before[1])
    view.rerender(<Markdown content="拍板决策" />)
    expect(received.at(-1)).toEqual({ mode: 'streaming', isAnimating: false })
    expect(view.container.querySelector('.md-body')!.textContent).toBe('拍板决策')
    before.forEach((node, index) => expect(spans(view.container)[index]).toBe(node))
    expect(spans(view.container).every((node) => node.dataset.reveal === 'settled')).toBe(true)
    await finish(transition)
    expect(spans(view.container)).toHaveLength(0)
  })

  it('opacity与marker color都收口后才能回收，取消也完成等待，其他装饰不参与', async () => {
    const view = render(<Markdown content="- 条目" streaming />)
    const opacity = animate(spans(view.container)[0])
    const marker = animate(view.container.querySelector('[data-reveal-marker]')!, 'color')
    animate(view.container.querySelector('.md-body')!, 'opacity')
    animate(spans(view.container)[0], 'transform')
    animations.push({ playState: 'running' } as Animation)
    view.rerender(<Markdown content="- 条目" />)
    await finish(opacity)
    expect(spans(view.container).length).toBeGreaterThan(0)
    await act(async () => { marker.cancel(); await Promise.resolve() })
    expect(spans(view.container)).toHaveLength(0)
    expect(view.container.querySelector('li')!.textContent).toBe('条目')
  })

  it('代码行的淡入参与收尾等待：行元素保留到淡完，标记同步摘除（计划/代码与表格过渡）', async () => {
    const view = render(<Markdown content={'```ts\nconst a = 1\n'} streaming />)
    const line = view.container.querySelector("[data-streamdown='code-block-body'] code > span")!
    expect(line).not.toBeNull()
    const fade = animate(line)
    view.rerender(<Markdown content={'```ts\nconst a = 1\n'} />)
    // 纯代码消息没有 data-reveal；不等行淡入就会立即切 static 把淡入切断
    expect(received.at(-1)).toEqual({ mode: 'streaming', isAnimating: false })
    expect(view.container.querySelector("[data-slot='markdown-root']")).toHaveAttribute('data-md-streaming', 'true')
    expect(view.container.querySelector("[data-streamdown='code-block-body'] code > span")).toBe(line)
    await finish(fade)
    expect(received.at(-1)).toEqual({ mode: 'static', isAnimating: false })
    expect(view.container.querySelector('[data-md-streaming]')).toBeNull()
  })

  it('无真实过渡时直接静态收口，包含reduced-motion取消后的空列表', () => {
    const view = render(<Markdown content="拍板" streaming />)
    view.rerender(<Markdown content="拍板" />)
    expect(spans(view.container)).toHaveLength(0)
    expect(received.at(-1)).toEqual({ mode: 'static', isAnimating: false })
  })

  it.each(['finished', 'idle'] as const)('已经%s的过渡不再阻止回收', (state) => {
    const view = render(<Markdown content="拍板" streaming />)
    animate(spans(view.container)[0]).playState = state
    view.rerender(<Markdown content="拍板" />)
    expect(spans(view.container)).toHaveLength(0)
  })

  it('已隐藏页面不挂起视觉回收，也不读取动画列表', () => {
    const view = render(<Markdown content="拍板" streaming />)
    animate(spans(view.container)[0])
    hidden = true
    view.rerender(<Markdown content="拍板" />)
    expect(spans(view.container)).toHaveLength(0)
    expect(getAnimations).not.toHaveBeenCalled()
  })

  it('等待期间页面隐藏立即静态收口，旧Promise随后完成不再改变新树', async () => {
    const view = render(<Markdown content="拍板" streaming />)
    const transition = animate(spans(view.container)[0])
    view.rerender(<Markdown content="拍板" />)
    expect(spans(view.container).length).toBeGreaterThan(0)
    hidden = true
    fireEvent(document, new Event('visibilitychange'))
    expect(spans(view.container)).toHaveLength(0)
    await finish(transition)
    expect(received.at(-1)).toEqual({ mode: 'static', isAnimating: false })
  })

  it('等待期间重新开流，旧Promise完成不能切掉新流的Block树', async () => {
    const view = render(<Markdown content="拍板" streaming />)
    const transition = animate(spans(view.container)[0])
    view.rerender(<Markdown content="拍板" />)
    const retained = spans(view.container)
    view.rerender(<Markdown content="拍板决策" streaming />)
    expect(received.at(-1)).toEqual({ mode: 'streaming', isAnimating: true })
    await finish(transition)
    expect(received.at(-1)).toEqual({ mode: 'streaming', isAnimating: true })
    retained.forEach((node, index) => expect(spans(view.container)[index]).toBe(node))
    expect(view.container.querySelector('.md-body')!.textContent).toBe('拍板决策')
  })

  it('非前缀权威改写立即static，旧动画完成不能影响后续新流', async () => {
    const view = render(<Markdown content="原文" streaming />)
    const transition = animate(spans(view.container)[0])
    view.rerender(<Markdown content="原文" />)
    view.rerender(<Markdown content="新的正文" />)
    expect(spans(view.container)).toHaveLength(0)
    expect(view.container.querySelector('.md-body')!.textContent).toBe('新的正文')
    view.rerender(<Markdown content="新的正文追加" streaming />)
    await finish(transition)
    expect(received.at(-1)).toEqual({ mode: 'streaming', isAnimating: true })
    expect(spans(view.container).length).toBeGreaterThan(0)
  })

  it('卸载撤掉可见性监听，旧等待不影响另一个消息实例', async () => {
    const view = render(<Markdown content="原文" streaming />)
    const transition = animate(spans(view.container)[0])
    const remove = vi.spyOn(document, 'removeEventListener')
    view.rerender(<Markdown content="原文" />)
    view.unmount()
    expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    const next = render(<Markdown content="新消息" streaming />)
    const before = spans(next.container)
    await finish(transition)
    before.forEach((node, index) => expect(spans(next.container)[index]).toBe(node))
    expect(received.at(-1)).toEqual({ mode: 'streaming', isAnimating: true })
  })

  it.each([
    'before **open',
    'before `code',
    'before [label](https://example.com',
    'before\n\n```ts\nconst value = 1',
    'before\n\n脚注[^n]\n\n[^n]: 注释正文',
  ])('自然收口后恢复原生static最终语义：%s', async (source) => {
    const view = render(<Markdown content={source} streaming />)
    const transition = animate(spans(view.container)[0])
    view.rerender(<Markdown content={source} />)
    expect(spans(view.container).length).toBeGreaterThan(0)
    await finish(transition)
    expect(spans(view.container)).toHaveLength(0)
    const native = render(<Streamdown mode="static" plugins={{ code, cjk }} animated={false} lineNumbers={false} linkSafety={{ enabled: false }}>{source}</Streamdown>)
    const semantics = (container: HTMLElement) => Array.from(container.querySelectorAll('p,a,code,pre,li,[data-streamdown="strong"],[data-streamdown="inline-code"]'))
      .map((node) => [node.tagName, node.textContent, node.getAttribute('href')])
    expect(semantics(view.container)).toEqual(semantics(native.container))
    expect(view.container.querySelector('.md-body')!.textContent).toBe(native.container.firstElementChild!.textContent)
    native.unmount()
  })
})
