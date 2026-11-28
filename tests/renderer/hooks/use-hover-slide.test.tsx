/** 悬停滑动层：关闭时不渲染不监听；进入行时读行自己的底色与圆角、落位、接管；同行重入不重读；
 *  悬停不改底色的行（active 钮）不接管，当缝隙处理；focus 驱动（浮层行）；外观开关。 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useHoverSlide } from '@/hooks/use-hover-slide'
import { useAppearanceStore } from '@/stores/appearance'

/** 容器带 2px 边框：落位以内边距盒为基准，应扣掉边框宽。jsdom 没有悬停态：行被悬停时的底色
 *  由 data-hover-bg 经 getComputedStyle 桩给出；hook 读静息底色的克隆副本带 position:absolute
 *  内联，仍走真实计算值（内联 backgroundColor）。真实悬停下的读数由 Electron 探针验证。
 *  highlightOnly：只有带高亮属性的行才读 data-hover-bg（高亮驱动的行组里未高亮行是静息态）。 */
function Harness({ enabled = true }: { enabled?: boolean }) {
  const slide = useHoverSlide({ enabled })
  return (
    <nav ref={slide.containerRef} data-testid="list" className={slide.containerClassName}>
      {slide.pill}
      <button
        type="button"
        data-hover-slide
        data-hover-bg="rgba(255, 255, 255, 0.36)"
        style={{ backgroundColor: 'rgba(0, 0, 0, 0)', borderRadius: '10px', transition: 'color 150ms' }}
      >
        甲
      </button>
      <button
        type="button"
        data-hover-slide
        data-hover-bg="rgba(255, 0, 0, 0.5)"
        style={{ backgroundColor: 'rgba(0, 0, 0, 0)', borderRadius: '6px' }}
      >
        <span>乙</span>
      </button>
      {/* active 钮：悬停底色 = 静息底色 */}
      <button
        type="button"
        data-hover-slide
        data-hover-bg="rgba(255, 255, 255, 0.58)"
        style={{ backgroundColor: 'rgba(255, 255, 255, 0.58)', borderRadius: '10px' }}
      >
        丙
      </button>
    </nav>
  )
}

const realGetComputedStyle = window.getComputedStyle.bind(window)
function stubHoverBackground({ highlightOnly = false } = {}) {
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => {
    const style = realGetComputedStyle(el)
    const hover = (el as HTMLElement).dataset.hoverBg
    const highlighted =
      (el.hasAttribute('data-highlighted') || el.hasAttribute('data-selected') || el.getAttribute('aria-selected') === 'true')
    if (hover === undefined || (el as HTMLElement).style.position === 'absolute' || (highlightOnly && !highlighted)) return style
    return new Proxy(style, {
      get: (target, key) => (key === 'backgroundColor' ? hover : (Reflect.get(target, key, target) as unknown)),
    })
  })
}

function mockRect(el: Element, rect: { left: number; top: number; width: number; height: number }) {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    x: rect.left,
    y: rect.top,
    left: rect.left,
    top: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    width: rect.width,
    height: rect.height,
    toJSON: () => ({}),
  })
}

/** ref 回调形式的视口盒子桩（ref 在 commit 阶段早于 effect 执行） */
function mockRectRef(rect: { left: number; top: number; width: number; height: number }) {
  return (el: HTMLElement | null) => {
    if (el) mockRect(el, rect)
  }
}

/** 模拟已布局的 DOM：jsdom 无布局，offsetLeft / Top / Width / Height / offsetParent 在 ref 回调
 *  （commit 阶段，早于父级 effect）里定义，挂载时的补同步才量得到。offsetParent 取上一级元素：
 *  行 → 分组 → 容器，走通逐级累加。 */
function laidOut(top: number, height: number, left = 0, width = 100) {
  return (el: HTMLElement | null) => {
    if (!el) return
    Object.defineProperty(el, 'offsetTop', { value: top, configurable: true })
    Object.defineProperty(el, 'offsetHeight', { value: height, configurable: true })
    Object.defineProperty(el, 'offsetLeft', { value: left, configurable: true })
    Object.defineProperty(el, 'offsetWidth', { value: width, configurable: true })
    Object.defineProperty(el, 'offsetParent', { get: () => el.parentElement, configurable: true })
  }
}

/** focus 驱动载体（浮层行）：行外包分组，位置走布局量 —— 分组 20/4 + 行 12/8 逐级累加。
 *  首行在 ref 回调里先聚焦（commit 阶段，早于父级 effect），模拟 Base UI 早于监听挂载落焦点 */
function FocusHarness() {
  const slide = useHoverSlide({ mode: 'focus' })
  const firstRow = laidOut(12, 28, 8, 120)
  return (
    <nav ref={slide.containerRef} data-testid="list" className={slide.containerClassName}>
      {slide.pill}
      <div data-testid="group" ref={laidOut(20, 60, 4, 240)}>
        <button
          type="button"
          data-hover-slide
          data-hover-bg="rgba(255, 255, 255, 0.36)"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0)' }}
          ref={(el) => {
            firstRow(el)
            el?.focus()
          }}
        >
          甲
        </button>
        <button
          type="button"
          data-hover-slide
          data-hover-bg="rgba(255, 0, 0, 0.5)"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0)' }}
          ref={laidOut(40, 32, 8, 200)}
        >
          乙
        </button>
      </div>
    </nav>
  )
}

/** 高亮属性驱动载体（cmdk 的 data-selected、Combobox 的 data-highlighted）：行拿不到焦点。位置走
 *  布局量：列表盒 20/4 + 行 0/34 逐级累加（cmdk 会把高亮行滚进视口，视口盒子不可靠） */
function HighlightHarness() {
  const slide = useHoverSlide({ mode: 'highlight' })
  return (
    <div ref={slide.containerRef} data-testid="list" className={slide.containerClassName}>
      {slide.pill}
      <div role="listbox" ref={laidOut(20, 70, 4, 240)}>
        <button
          type="button"
          data-hover-slide
          data-hover-bg="oklch(0.97 0 0)"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0)' }}
          aria-selected="false"
          ref={laidOut(0, 32, 0, 240)}
        >
          甲
        </button>
        <button
          type="button"
          data-hover-slide
          data-hover-bg="oklch(0.97 0 0)"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0)' }}
          aria-selected="false"
          ref={laidOut(34, 32, 0, 240)}
        >
          乙
        </button>
      </div>
    </div>
  )
}

/** 嵌套容器（输入区工具行：外层插件条包着内层 composer-actions）：行归最近的容器 */
function NestedHarness() {
  const outer = useHoverSlide()
  const inner = useHoverSlide()
  return (
    <nav ref={outer.containerRef} data-testid="outer" className={outer.containerClassName}>
      {outer.pill}
      <button
        type="button"
        data-hover-slide
        data-hover-bg="rgba(255, 255, 255, 0.36)"
        style={{ backgroundColor: 'rgba(0, 0, 0, 0)' }}
        ref={mockRectRef({ left: 0, top: 0, width: 240, height: 32 })}
      >
        外甲
      </button>
      <div ref={inner.containerRef} data-testid="inner" className={inner.containerClassName}>
        {inner.pill}
        <button
          type="button"
          data-hover-slide
          data-hover-bg="rgba(255, 255, 255, 0.36)"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0)' }}
          ref={mockRectRef({ left: 0, top: 32, width: 240, height: 32 })}
        >
          内乙
        </button>
      </div>
    </nav>
  )
}

/** 不传 enabled：读外观「开启滑动动画」 */
function StoreHarness() {
  const slide = useHoverSlide()
  return (
    <nav ref={slide.containerRef} data-testid="list" className={slide.containerClassName}>
      {slide.pill}
      <button type="button" data-hover-slide data-hover-bg="rgba(255, 255, 255, 0.36)">
        甲
      </button>
    </nav>
  )
}

const pillOf = (list: HTMLElement) => {
  const pill = list.querySelector<HTMLElement>('.hover-slide-pill')
  if (pill === null) throw new Error('缺少滑动胶囊')
  return pill
}

describe('useHoverSlide', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    useAppearanceStore.setState({ hoverSlide: true })
  })

  it('关闭时不渲染胶囊、不挂监听、不留属性', () => {
    stubHoverBackground()
    render(<Harness enabled={false} />)
    const list = screen.getByTestId('list')
    const first = screen.getByRole('button', { name: '甲' })
    expect(list.querySelector('.hover-slide-pill')).toBeNull()
    fireEvent.pointerOver(first, { clientX: 10, clientY: 10 })
    expect(first).not.toHaveAttribute('data-pill-over')
  })

  it('进入行：读该行自己的底色与圆角涂到胶囊，落位扣掉容器边框，行的过渡原样还原', () => {
    stubHoverBackground()
    render(<Harness />)
    const list = screen.getByTestId('list')
    const first = screen.getByRole('button', { name: '甲' })
    mockRect(list, { left: 100, top: 50, width: 240, height: 96 })
    mockRect(first, { left: 102, top: 52, width: 100, height: 30 })
    vi.spyOn(list, 'clientLeft', 'get').mockReturnValue(2)
    vi.spyOn(list, 'clientTop', 'get').mockReturnValue(2)

    fireEvent.pointerOver(first, { clientX: 120, clientY: 60 })
    const pill = pillOf(list)
    expect(pill).toHaveAttribute('data-visible', 'true')
    expect(pill.style.getPropertyValue('--pill-x')).toBe('0px')
    expect(pill.style.getPropertyValue('--pill-y')).toBe('0px')
    expect(pill.style.getPropertyValue('--pill-w')).toBe('100px')
    expect(pill.style.getPropertyValue('--pill-h')).toBe('30px')
    expect(pill.style.getPropertyValue('--pill-bg')).toBe('rgba(255, 255, 255, 0.36)')
    expect(pill.style.borderRadius).toBe('10px')
    expect(first).toHaveAttribute('data-pill-over', '')
    // 读取时瞬时关掉的行过渡已还原
    expect(first.style.transition).toBe('color 150ms')
  })

  it('换行滑过去并换成新行的底色；同一行内重入不重读（否则会读到被压制的透明）', () => {
    stubHoverBackground()
    render(<Harness />)
    const list = screen.getByTestId('list')
    const first = screen.getByRole('button', { name: '甲' })
    const second = screen.getByRole('button', { name: '乙' })
    mockRect(list, { left: 100, top: 50, width: 240, height: 96 })
    mockRect(first, { left: 100, top: 52, width: 100, height: 30 })
    mockRect(second, { left: 100, top: 84, width: 120, height: 32 })

    fireEvent.pointerOver(first, { clientX: 120, clientY: 60 })
    const pill = pillOf(list)
    fireEvent.pointerOver(second, { clientX: 120, clientY: 100 })
    expect(pill.style.getPropertyValue('--pill-y')).toBe('34px')
    expect(pill.style.getPropertyValue('--pill-w')).toBe('120px')
    expect(pill.style.getPropertyValue('--pill-h')).toBe('32px')
    expect(pill.style.getPropertyValue('--pill-bg')).toBe('rgba(255, 0, 0, 0.5)')
    expect(pill.style.borderRadius).toBe('6px')
    expect(first).not.toHaveAttribute('data-pill-over')
    expect(second).toHaveAttribute('data-pill-over', '')

    // 指针从按钮空白挪到其中的图标 / 文字：仍是同一行，底色不得被重读成透明
    fireEvent.pointerOver(screen.getByText('乙'), { clientX: 122, clientY: 100 })
    expect(pill.style.getPropertyValue('--pill-bg')).toBe('rgba(255, 0, 0, 0.5)')
    expect(second).toHaveAttribute('data-pill-over', '')

    fireEvent.pointerLeave(list)
    expect(pill).toHaveAttribute('data-visible', 'false')
    expect(second).not.toHaveAttribute('data-pill-over')
  })

  it('滚动容器自身发生横向或纵向滚动时，胶囊仍对齐内容坐标', () => {
    stubHoverBackground()
    render(<Harness />)
    const list = screen.getByTestId('list')
    const row = screen.getByRole('button', { name: '甲' })
    mockRect(list, { left: 100, top: 50, width: 240, height: 96 })
    mockRect(row, { left: 122, top: 62, width: 100, height: 30 })
    vi.spyOn(list, 'clientLeft', 'get').mockReturnValue(2)
    vi.spyOn(list, 'clientTop', 'get').mockReturnValue(2)
    list.scrollLeft = 180
    list.scrollTop = 64
    fireEvent.pointerOver(row, { clientX: 130, clientY: 70 })
    expect(pillOf(list).style.getPropertyValue('--pill-x')).toBe('200px')
    expect(pillOf(list).style.getPropertyValue('--pill-y')).toBe('74px')
    // 同一行随滚动移动，内容坐标仍保持原位。
    list.scrollLeft = 190
    mockRect(row, { left: 112, top: 62, width: 100, height: 30 })
    fireEvent.pointerMove(row, { clientX: 130, clientY: 70 })
    expect(pillOf(list).style.getPropertyValue('--pill-x')).toBe('200px')
  })

  it('悬停不改底色的行（active 钮）不接管：直接落上去什么都不出；滑过去时胶囊留在原行、过宽限期原地淡出', () => {
    stubHoverBackground()
    render(<Harness />)
    const list = screen.getByTestId('list')
    const first = screen.getByRole('button', { name: '甲' })
    const active = screen.getByRole('button', { name: '丙' })
    mockRect(list, { left: 0, top: 0, width: 240, height: 96 })
    mockRect(first, { left: 0, top: 0, width: 240, height: 32 })
    mockRect(active, { left: 0, top: 64, width: 240, height: 32 })
    const pill = pillOf(list)

    fireEvent.pointerOver(active, { clientX: 120, clientY: 80 })
    expect(pill).toHaveAttribute('data-visible', 'false')
    expect(active).not.toHaveAttribute('data-pill-over')

    fireEvent.pointerOver(first, { clientX: 120, clientY: 16 })
    expect(pill).toHaveAttribute('data-visible', 'true')
    fireEvent.pointerOver(active, { clientX: 120, clientY: 80 })
    // 胶囊没有停到 active 行，active 行的底色也没被接管；宽限期内上一行仍由胶囊画着
    expect(pill.style.getPropertyValue('--pill-y')).toBe('0px')
    expect(active).not.toHaveAttribute('data-pill-over')
    expect(first).toHaveAttribute('data-pill-over', '')
    expect(pill).toHaveAttribute('data-visible', 'true')

    // 在它上面停留：过宽限期后原地淡出并释放上一行
    fireEvent.pointerMove(active, { clientX: 121, clientY: 80 })
    vi.advanceTimersByTime(110)
    expect(pill).toHaveAttribute('data-visible', 'false')
    expect(first).not.toHaveAttribute('data-pill-over')

    // 快速掠过它落到另一行：直接滑过去，不淡出
    const second = screen.getByRole('button', { name: '乙' })
    mockRect(second, { left: 0, top: 32, width: 240, height: 32 })
    fireEvent.pointerOver(first, { clientX: 120, clientY: 16 })
    fireEvent.pointerOver(active, { clientX: 120, clientY: 80 })
    fireEvent.pointerOver(second, { clientX: 120, clientY: 48 })
    expect(pill).toHaveAttribute('data-visible', 'true')
    expect(pill.style.getPropertyValue('--pill-y')).toBe('32px')
    expect(pill.style.getPropertyValue('--pill-bg')).toBe('rgba(255, 0, 0, 0.5)')
  })

  it('focus 驱动（浮层行）：挂载时按已有焦点补同步并走布局量落位，焦点换行滑行，离开容器才隐藏', () => {
    stubHoverBackground()
    render(<FocusHarness />)
    const list = screen.getByTestId('list')
    const pill = pillOf(list)
    const first = screen.getByRole('button', { name: '甲' })
    const second = screen.getByRole('button', { name: '乙' })
    expect(document.activeElement).toBe(first)
    expect(pill).toHaveAttribute('data-visible', 'true')
    expect(pill.style.getPropertyValue('--pill-x')).toBe('12px')
    expect(pill.style.getPropertyValue('--pill-y')).toBe('32px')
    expect(pill.style.getPropertyValue('--pill-w')).toBe('120px')
    expect(pill.style.getPropertyValue('--pill-h')).toBe('28px')
    expect(pill.style.getPropertyValue('--pill-bg')).toBe('rgba(255, 255, 255, 0.36)')

    fireEvent.focusIn(second)
    expect(pill.style.getPropertyValue('--pill-x')).toBe('12px')
    expect(pill.style.getPropertyValue('--pill-y')).toBe('60px')
    expect(pill.style.getPropertyValue('--pill-w')).toBe('200px')
    expect(pill.style.getPropertyValue('--pill-bg')).toBe('rgba(255, 0, 0, 0.5)')
    expect(first).not.toHaveAttribute('data-pill-over')
    expect(second).toHaveAttribute('data-pill-over', '')

    // relatedTarget 为 null 的失焦（窗口失焦）不动；焦点离开容器才隐藏
    fireEvent.focusOut(second)
    expect(pill).toHaveAttribute('data-visible', 'true')
    fireEvent.focusOut(second, { relatedTarget: document.body })
    expect(pill).toHaveAttribute('data-visible', 'false')
    expect(second).not.toHaveAttribute('data-pill-over')
  })

  it('嵌套容器：行归最近的容器，外层胶囊不接管内层的行；关时容器类名与标记都不留', () => {
    stubHoverBackground()
    render(<NestedHarness />)
    const outer = screen.getByTestId('outer')
    const inner = screen.getByTestId('inner')
    mockRect(outer, { left: 0, top: 0, width: 240, height: 64 })
    mockRect(inner, { left: 0, top: 32, width: 240, height: 32 })
    expect(outer).toHaveAttribute('data-hover-slide-container')
    expect(inner).toHaveAttribute('data-hover-slide-container')

    fireEvent.pointerOver(screen.getByRole('button', { name: '内乙' }), { clientX: 10, clientY: 40 })
    expect(pillOf(inner)).toHaveAttribute('data-visible', 'true')
    expect(screen.getByRole('button', { name: '内乙' })).toHaveAttribute('data-pill-over', '')
    // 同一事件冒泡到外层：内层的行不是外层的行，外层保持隐藏
    expect(pillOf(outer)).toHaveAttribute('data-visible', 'false')

    fireEvent.pointerOver(screen.getByRole('button', { name: '外甲' }), { clientX: 10, clientY: 10 })
    expect(pillOf(outer)).toHaveAttribute('data-visible', 'true')

    // 关掉开关：容器类名回到原样、标记摘除
    act(() => {
      useAppearanceStore.setState({ hoverSlide: false })
    })
    expect(outer).not.toHaveAttribute('data-hover-slide-container')
    expect(inner).not.toHaveAttribute('data-hover-slide-container')
    expect(outer).not.toHaveClass('relative', 'isolate')
    expect(outer.className).toBe('')
  })

  it('外观「开启滑动动画」关闭：不渲染胶囊、不挂监听、不留属性；打开后立即生效', () => {
    stubHoverBackground()
    useAppearanceStore.setState({ hoverSlide: false })
    const { container } = render(<StoreHarness />)
    const row = screen.getByRole('button', { name: '甲' })
    mockRect(screen.getByTestId('list'), { left: 0, top: 0, width: 240, height: 32 })
    mockRect(row, { left: 0, top: 0, width: 240, height: 32 })
    expect(container.querySelector('.hover-slide-pill')).toBeNull()
    fireEvent.pointerOver(row, { clientX: 10, clientY: 10 })
    expect(row).not.toHaveAttribute('data-pill-over')

    act(() => {
      useAppearanceStore.setState({ hoverSlide: true })
    })
    expect(container.querySelector('.hover-slide-pill')).not.toBeNull()
    fireEvent.pointerOver(row, { clientX: 10, clientY: 10 })
    expect(row).toHaveAttribute('data-pill-over', '')
  })

  it('被接管的行类名变了（选中态由 mouseEnter 落进行）：胶囊改读行此刻的底色；行不再自绘底色时保持原色', async () => {
    stubHoverBackground()
    render(<Harness />)
    const list = screen.getByTestId('list')
    const first = screen.getByRole('button', { name: '甲' })
    mockRect(list, { left: 0, top: 0, width: 240, height: 96 })
    mockRect(first, { left: 0, top: 0, width: 240, height: 32 })
    fireEvent.pointerOver(first, { clientX: 120, clientY: 16 })
    const pill = pillOf(list)
    expect(pill.style.getPropertyValue('--pill-bg')).toBe('rgba(255, 255, 255, 0.36)')

    // hover:bg-muted/60 → bg-muted：底色变了，胶囊跟上；压制属性读完即压回
    await act(async () => {
      first.setAttribute('data-hover-bg', 'oklch(0.97 0 0)')
      first.classList.add('bg-muted')
      await Promise.resolve()
    })
    expect(pill.style.getPropertyValue('--pill-bg')).toBe('oklch(0.97 0 0)')
    expect(first).toHaveAttribute('data-pill-over', '')

    // 行不再自绘底色（透明）：胶囊保持原色，交给离开逻辑
    await act(async () => {
      first.setAttribute('data-hover-bg', 'rgba(0, 0, 0, 0)')
      first.classList.remove('bg-muted')
      await Promise.resolve()
    })
    expect(pill.style.getPropertyValue('--pill-bg')).toBe('oklch(0.97 0 0)')
    expect(first).toHaveAttribute('data-pill-over', '')

    // 不是当前行的类名变化不触发重读
    const second = screen.getByRole('button', { name: '乙' })
    await act(async () => {
      second.classList.add('bg-muted')
      await Promise.resolve()
    })
    expect(pill.style.getPropertyValue('--pill-bg')).toBe('oklch(0.97 0 0)')
  })

  it('高亮属性驱动（cmdk / Combobox / 命令建议面板）：属性落在哪行胶囊就到哪行（布局量落位）；静息底色取未高亮的同组行；全部撤下才淡出', async () => {
    stubHoverBackground({ highlightOnly: true })
    render(<HighlightHarness />)
    const list = screen.getByTestId('list')
    const pill = pillOf(list)
    const first = screen.getByRole('button', { name: '甲' })
    const second = screen.getByRole('button', { name: '乙' })
    expect(pill).toHaveAttribute('data-visible', 'false')

    // aria-selected="false" 不算高亮
    await act(async () => {
      first.setAttribute('data-selected', 'true')
      await Promise.resolve()
    })
    expect(pill).toHaveAttribute('data-visible', 'true')
    expect(pill.style.getPropertyValue('--pill-x')).toBe('4px')
    expect(pill.style.getPropertyValue('--pill-y')).toBe('20px')
    expect(pill.style.getPropertyValue('--pill-h')).toBe('32px')
    // 静息底色读自未高亮的乙行（透明），高亮底色才读得出来
    expect(pill.style.getPropertyValue('--pill-bg')).toBe('oklch(0.97 0 0)')
    expect(first).toHaveAttribute('data-pill-over', '')

    // 换行：旧属性摘除、新属性落下（同一次提交）
    await act(async () => {
      first.removeAttribute('data-selected')
      second.setAttribute('data-highlighted', '')
      await Promise.resolve()
    })
    expect(pill.style.getPropertyValue('--pill-y')).toBe('54px')
    expect(first).not.toHaveAttribute('data-pill-over')
    expect(second).toHaveAttribute('data-pill-over', '')

    await act(async () => {
      second.removeAttribute('data-highlighted')
      await Promise.resolve()
    })
    vi.advanceTimersByTime(110)
    expect(pill).toHaveAttribute('data-visible', 'false')
    expect(second).not.toHaveAttribute('data-pill-over')
  })
})
