/** 使用已安装Pierre真实File/Virtualizer复现隐藏后同一渲染范围被跳过；仅几何和观察器由测试控制。 */
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { preloadHighlighter, VirtualizedFile, Virtualizer } from '@pierre/diffs'
import TextPreview from '@/features/home/files/TextPreview'

vi.mock('@/stores/appearance', () => ({
  useIsDarkMode: () => false,
  useAppearanceStore: (selector: (s: { showLineNumbers: boolean; codeWrap: boolean }) => unknown) =>
    selector({ showLineNumbers: true, codeWrap: false }),
}))

class IntersectionObserverStub {
  static instances: IntersectionObserverStub[] = []
  readonly observed = new Set<Element>()
  constructor(readonly callback: IntersectionObserverCallback) { IntersectionObserverStub.instances.push(this) }
  observe(target: Element): void { this.observed.add(target) }
  unobserve(target: Element): void { this.observed.delete(target) }
  disconnect(): void { this.observed.clear() }
  emit(target: Element, isIntersecting: boolean): void {
    this.callback([{ target, isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
}

const contents = 'const first = 1\nconst second = 2\nconsole.log(second)\n'
const file = { name: 'sample.ts', contents }
const metrics = { lineHeight: 20, hunkLineCount: 50, diffHeaderHeight: 0, hunkSeparatorHeight: 0, fileGap: 0 }
const frames = new Map<number, FrameRequestCallback>()
let nextFrame = 0
function flushFrames(): void {
  for (let turn = 0; frames.size > 0 && turn < 20; turn++) {
    const pending = [...frames.values()]; frames.clear()
    pending.forEach(callback => callback(performance.now()))
  }
}

beforeAll(async () => {
  await preloadHighlighter({ themes: ['pierre-light', 'pierre-dark'], langs: ['typescript'], preferredHighlighter: 'shiki-wasm' })
})
beforeEach(() => {
  IntersectionObserverStub.instances = []
  vi.stubGlobal('IntersectionObserver', IntersectionObserverStub)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('CSSStyleSheet', class { replaceSync() {} })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, 0, 640, this.matches('[data-line]') ? 20 : this.tagName === 'DIFFS-CONTAINER' ? 80 : 400)
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400)
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(400)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(400)
})
afterEach(() => {
  cleanup(); flushFrames(); frames.clear()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

describe('真实Pierre可见性恢复', () => {
  it('上游负对照：隐藏删行后同范围render跳过，公开rerender才能重建', () => {
    const virtualizer = new Virtualizer()
    const instance = new VirtualizedFile({ disableFileHeader: true, overflow: 'wrap', theme: { light: 'pierre-light', dark: 'pierre-dark' }, themeType: 'light' }, virtualizer, metrics)
    const host = document.createElement('diffs-container')
    document.body.append(host)
    instance.render({ file, fileContainer: host })
    expect(host.shadowRoot!.querySelector('[data-line]')).not.toBeNull()
    instance.setVisibility(false)
    expect(host.shadowRoot!.querySelector('[data-line]')).toBeNull()
    expect(host.shadowRoot!.querySelector('[data-placeholder]')).not.toBeNull()
    instance.setVisibility(true)
    expect(instance.render({ file })).toBe(false)
    expect(host.shadowRoot!.querySelector('[data-line]')).toBeNull()
    instance.rerender()
    expect(host.shadowRoot!.textContent).toContain('const second = 2')
    instance.cleanUp(); virtualizer.cleanUp()
  })

  it('宿主激活先于IO恢复回调仍重建同一File的真实源码行', async () => {
    const view = render(<TextPreview text={contents} name="sample.ts" active location={{ line: 2, column: 3 }} />)
    act(flushFrames)
    const host = view.container.querySelector('diffs-container')!
    expect(host.shadowRoot!.textContent).toContain('const second = 2')
    const intersection = IntersectionObserverStub.instances.find(observer => observer.observed.has(host))!
    act(() => { intersection.emit(host, true); flushFrames() })
    for (let index = 0; index < 3; index++) {
      view.rerender(<TextPreview text={contents} name="sample.ts" active={false} location={{ line: 2, column: 3 }} />)
      act(() => { intersection.emit(host, false); flushFrames() })
      expect(host.shadowRoot!.querySelector('[data-line]')).toBeNull()
      view.rerender(<TextPreview text={contents} name="sample.ts" active location={{ line: 2, column: 3 }} />)
      act(flushFrames)
      expect(view.container.querySelector('diffs-container')).toBe(host)
      await waitFor(() => expect(host.shadowRoot!.textContent).toContain('const second = 2'))
      act(() => { intersection.emit(host, true); flushFrames() })
      expect(host.shadowRoot!.querySelectorAll('[data-line]').length).toBeGreaterThan(0)
    }
  })
})
