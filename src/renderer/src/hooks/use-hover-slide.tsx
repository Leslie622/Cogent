/** 悬停滑动层：同一容器内带 data-hover-slide 的"行"之间，单层胶囊随指针（pointer）、焦点
 *  （focus，Base UI 菜单 / Select 的行 —— 悬停和方向键都是移焦点）或高亮属性（highlight：cmdk 的
 *  data-selected、Combobox 的 data-highlighted —— 行拿不到 DOM 焦点，只能看属性）平滑滑行。
 *  只加滑动、不改高亮 ——
 *  进入行时读该行自己的悬停绘制（底色 + 圆角）涂到胶囊上，行自身底色在胶囊覆着期间由
 *  globals.css 的 [data-hover-slide][data-pill-over] 置透明；行的文字变色、阴影等其余悬停
 *  表现留在行上。关闭时不渲染胶囊、不挂监听、不留属性，与未装配时一致。
 *
 *  开关：默认读外观偏好「开启滑动动画」（appearance.hoverSlide），调用点可用 enabled 显式
 *  覆盖（目前无此需要）。
 *
 *  悬停不改变底色的行不接管（2026-11-28 验收：滑到 active 的路由钮时它的底色先被掐掉、
 *  再由胶囊滑回来，等于凭空多了一次 hover）：行被悬停时的底色与不被悬停时相同，说明悬停
 *  本就不给底色（active 钮、只变文字色的钮、子弹层已开的触发器都是），胶囊当它是缝隙 ——
 *  原地淡出、不停上去。静息底色无法从被悬停的元素身上直接读，克隆一个不带悬停态的同级
 *  副本来读。
 *
 *  装配协议：容器挂 containerRef 与 containerClassName（relative isolate：定位基准 + 独立
 *  层叠上下文 —— 胶囊 z-index:-1 才垫在行内容之下而不沉到祖先背景之下），{slide.pill}
 *  放首子位，行只加 data-hover-slide、原有 hover 类不动。并列的多个悬停行才接（列表、
 *  按钮组、标签条、浮层行）；单控件不接。
 *
 *  只适用于实色悬停底色：渐变 / 图片底、画在伪元素上的悬停底读不到（视作悬停不改底色，
 *  行保持原样）。动画走 left / top / width / height 与背景色而不是 translate / opacity：
 *  合成层会把其上的文字降级成灰度抗锯齿（探针实测头部「文件」二字的次像素彩边消失），
 *  主线程动画每次滑动的布局 + 重算样式合计不足 10ms。 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppearanceStore } from '@/stores/appearance'

const ROW_SELECTOR = '[data-hover-slide]'
/** 装配生效时挂在容器上的标记：行归最近的那个容器（输入区工具行的右簇嵌在左簇容器里，
 *  左簇的胶囊不得把右簇的行当成自己的） */
const OWNER_ATTR = 'data-hover-slide-container'
const LEAVE_DELAY_MS = 100

export type HoverSlideMode = 'pointer' | 'focus' | 'highlight'

/** 高亮属性驱动所监听的属性；值为 false 视作未高亮（aria-selected="false" 常驻在未选项上） */
const HIGHLIGHT_ATTRS = ['data-highlighted', 'data-selected', 'aria-selected'] as const

/** 容器里此刻带高亮属性的那一行 */
function highlightedRow(container: HTMLElement): HTMLElement | null {
  const selector = HIGHLIGHT_ATTRS.map((attr) => `[${attr}]`).join(',')
  for (const el of container.querySelectorAll<HTMLElement>(selector)) {
    if (!HIGHLIGHT_ATTRS.some((attr) => el.hasAttribute(attr) && el.getAttribute(attr) !== 'false')) continue
    const row = el.closest<HTMLElement>(ROW_SELECTOR)
    if (row && ownedBy(row, container)) return row
  }
  return null
}

/** 行是否归本容器（而非嵌在里面的另一个滑动容器） */
function ownedBy(row: HTMLElement, container: HTMLElement): boolean {
  return row.closest(`[${OWNER_ATTR}]`) === container
}

const rowsOf = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>(ROW_SELECTOR)].filter((row) => ownedBy(row, container))

/** 行是否带高亮属性（见 HIGHLIGHT_ATTRS） */
function isHighlighted(el: Element): boolean {
  return HIGHLIGHT_ATTRS.some((attr) => el.hasAttribute(attr) && el.getAttribute(attr) !== 'false')
}

/** 行不被悬停、不高亮时的底色。高亮驱动时优先读同容器里未高亮的另一行：类名驱动的高亮
 *  （命令建议面板按 selectedIndex 换 bg-* 类，属性只是语义）克隆副本会连高亮类一起带走，
 *  读出来与高亮底色相同；同组行除高亮外类名一致，未高亮的那行就是静息态（行正在褪色时
 *  取过渡终值）。没有这样的行（单行列表）退回副本。副本绝对定位、隐藏，不参与布局也不出帧，
 *  同一步任务内移除；不在指针之下、也不持有焦点，行自身的 :hover / :focus 规则不命中；
 *  祖先上的 :hover（group-*）两边都有，比较时自然抵消。 */
function restingBackground(row: HTMLElement, container: HTMLElement, mode: HoverSlideMode): string {
  if (mode === 'highlight') {
    for (const other of rowsOf(container)) {
      if (other !== row && !isHighlighted(other) && !other.hasAttribute('data-pill-over')) return targetBackground(other)
    }
  }
  const probe = row.cloneNode(false) as HTMLElement
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  // 副本会连高亮属性一起克隆（data-selected / data-highlighted），摘掉才是静息态
  for (const attr of HIGHLIGHT_ATTRS) probe.removeAttribute(attr)
  row.before(probe)
  const background = getComputedStyle(probe).backgroundColor
  probe.remove()
  return background
}

/** 行此刻的底色终值（悬停 / 高亮 / 选中态落到行上之后）。读计算值前不能关掉行的过渡：指针刚移入那一刻 :hover 样式还没提交，关掉再
 *  强制重算会把文字色等所有悬停变化一起瞬间提交，进入方向就没有过渡了（2026-11-28 验收：移入
 *  没过渡、移出才有）；而只要有过渡在跑，getComputedStyle 读到的就是过渡起点（透明）而不是悬停值，
 *  内联改时长对运行中的过渡也无效（规范如此，实测亦然）。做法：照常强制重算让悬停样式按行自己的
 *  过渡起步，再从 background-color 那条 CSSTransition 的关键帧里取终值（Chromium 对运行中的过渡
 *  返回 from / to 两帧）；没有过渡在跑（时长为 0、行不过渡底色、或已经跑完）时计算值本身就是终值。 */
function targetBackground(row: HTMLElement): string {
  const computed = getComputedStyle(row)
  for (const animation of row.getAnimations()) {
    if (!(animation instanceof CSSTransition) || animation.transitionProperty !== 'background-color') continue
    const effect = animation.effect
    if (!(effect instanceof KeyframeEffect)) continue
    const frames = effect.getKeyframes()
    const value = frames[frames.length - 1]?.backgroundColor
    if (typeof value === 'string') return value
  }
  return computed.backgroundColor
}

/** 行相对容器内边距盒的布局位置（offsetLeft / Top 逐级累加到容器，容器须在其 offsetParent
 *  链上；不在时退回行自身偏移）。布局量不受 transform 影响 —— 浮层开场有 100ms zoom-in，
 *  首项在动画中被聚焦时 getBoundingClientRect 量到的是缩放中的视口盒子。 */
function layoutBox(row: HTMLElement, container: HTMLElement) {
  let x = 0
  let y = 0
  let el: HTMLElement | null = row
  while (el !== null && el !== container) {
    x += el.offsetLeft
    y += el.offsetTop
    el = el.offsetParent as HTMLElement | null
  }
  // 宽高取计算值（123.6px 这样的分数used值）：offsetWidth 取整后会比行窄零点几像素
  const size = (computed: string, fallback: number) => Number.parseFloat(computed) || fallback
  const { width, height } = getComputedStyle(row)
  if (el !== container) return { x: row.offsetLeft, y: row.offsetTop, w: size(width, row.offsetWidth), h: size(height, row.offsetHeight) }
  return { x: x - container.clientLeft, y: y - container.clientTop, w: size(width, row.offsetWidth), h: size(height, row.offsetHeight) }
}

export function useHoverSlide({
  enabled,
  mode = 'pointer',
}: { enabled?: boolean; mode?: HoverSlideMode } = {}) {
  const globalEnabled = useAppearanceStore((state) => state.hoverSlide)
  const on = enabled ?? globalEnabled
  // 容器用回调 ref 记进 state：浮层（Popover / Select 面板）是打开时才挂载的，挂在常驻父组件上的 hook
  // 若只在首次 effect 读 ref，会错过后来才出现的容器。参数按 HTMLElement：div / nav 的 ref 都能接。
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const containerRef = useCallback((node: HTMLElement | null) => setContainer(node), [])
  const pillRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!container || !on) return
    const pill = pillRef.current
    if (!pill) return
    container.setAttribute(OWNER_ATTR, '')

    /** 胶囊当前停的行、其中底色被接管的行（两者相同，除非还没停到任何行）、被判为缝隙的行 */
    let currentRow: HTMLElement | null = null
    let activeRow: HTMLElement | null = null
    let rejectedRow: HTMLElement | null = null
    let visible = false
    let hideTimer: number | undefined
    let scrollRaf: number | undefined
    const pointer = { x: 0, y: 0, inside: false }
    let lastBox: { row: HTMLElement; x: number; y: number; w: number; h: number } | null = null

    const clearHideTimer = () => {
      if (hideTimer !== undefined) {
        window.clearTimeout(hideTimer)
        hideTimer = undefined
      }
    }

    const hideImmediate = () => {
      clearHideTimer()
      visible = false
      lastBox = null
      currentRow = null
      rejectedRow = null
      pill.dataset.visible = 'false'
      activeRow?.removeAttribute('data-pill-over')
      activeRow = null
    }

    const scheduleHide = () => {
      if (hideTimer !== undefined) return
      hideTimer = window.setTimeout(() => {
        hideTimer = undefined
        hideImmediate()
      }, LEAVE_DELAY_MS)
    }

    /** 行此刻的底色终值与圆角 */
    const readPaint = (row: HTMLElement) => ({
      background: targetBackground(row),
      radius: getComputedStyle(row).borderRadius,
    })

    /** 停到一行上：接管它的悬停底色；悬停不改底色的行返回 false（调用方当缝隙处理）。
     *  悬停样式按行自己的过渡照常起步（文字色等进入方向有过渡），底色终值见 targetBackground；
     *  随后挂压制属性 —— 行那条底色过渡在同一步任务内改向透明，起点仍是透明，不会被画出来，
     *  胶囊是底色的唯一绘制者。不改行的任何内联样式。 */
    const adoptRow = (row: HTMLElement): boolean => {
      const paint = readPaint(row)
      if (paint.background === restingBackground(row, container, mode)) return false
      activeRow?.removeAttribute('data-pill-over')
      activeRow = row
      row.setAttribute('data-pill-over', '')
      pill.style.setProperty('--pill-bg', paint.background)
      pill.style.borderRadius = paint.radius
      return true
    }

    /** 被接管的那行类名变了：胶囊改读行此刻的绘制。审批 / 计划 / 提问面板的行在 mouseEnter 里落
     *  选中态（hover:bg-muted/60 换成更深的 bg-muted），React 提交晚于指针事件，进入时读到的还是
     *  hover 类的浅色。先摘压制属性再读（压着的时候行底色是透明），读完压回去，同一步任务内
     *  不出帧。行不再自绘底色（如选中态被挪到别行、自身又不在指针下）时保持原样，交给离开逻辑。 */
    const repaintRow = () => {
      const row = activeRow
      if (row === null) return
      row.removeAttribute('data-pill-over')
      const paint = readPaint(row)
      row.setAttribute('data-pill-over', '')
      if (paint.background === 'rgba(0, 0, 0, 0)') return
      pill.style.setProperty('--pill-bg', paint.background)
      pill.style.borderRadius = paint.radius
    }
    const onClassChange = (records: MutationRecord[]) => {
      if (activeRow !== null && records.some((record) => record.target === activeRow)) repaintRow()
    }
    const classObserver = new MutationObserver(onClassChange)
    classObserver.observe(container, { subtree: true, attributes: true, attributeFilter: ['class'] })

    /** 行相对容器内边距盒的位置与尺寸；宽高为 0（窄屏下隐藏的行等）视为不可见 */
    const measure = (row: HTMLElement) => {
      // 高亮驱动同样走布局量：cmdk / Combobox / 命令面板把高亮行滚进视口、浮层开场缩放，
      // 视口盒子量到的是滚动中 / 缩放中的位置；布局量不随滚动与 transform 变
      if (mode === 'focus' || mode === 'highlight') {
        const box = layoutBox(row, container)
        return box.w > 0 && box.h > 0 ? box : null
      }
      const containerRect = container.getBoundingClientRect()
      const rowRect = row.getBoundingClientRect()
      // 绝对定位以容器内边距盒为基准，getBoundingClientRect 是边框盒，补上容器边框宽
      if (rowRect.width <= 0 || rowRect.height <= 0 || containerRect.width <= 0) return null
      return {
        x: rowRect.left - containerRect.left - container.clientLeft,
        y: rowRect.top - containerRect.top - container.clientTop,
        w: rowRect.width,
        h: rowRect.height,
      }
    }

    const moveToRow = (row: HTMLElement) => {
      clearHideTimer()
      // 已判为缝隙的行：指针在其内移动时不再重复判定
      if (row === rejectedRow) {
        scheduleHide()
        return
      }
      if (row.closest('[inert]')) {
        scheduleHide()
        return
      }
      const box = measure(row)
      if (box === null) return
      const last = lastBox
      // 容差 0.02px：行在展开动画尾巴 / 字体就绪后会挪零点几像素，宽容差会让胶囊停在旧位置上
      const unchanged =
        last !== null &&
        last.row === row &&
        Math.abs(last.x - box.x) < 0.02 &&
        Math.abs(last.y - box.y) < 0.02 &&
        Math.abs(last.w - box.w) < 0.02 &&
        Math.abs(last.h - box.h) < 0.02
      const place = () => {
        pill.style.setProperty('--pill-x', `${box.x}px`)
        pill.style.setProperty('--pill-y', `${box.y}px`)
        pill.style.setProperty('--pill-w', `${box.w}px`)
        pill.style.setProperty('--pill-h', `${box.h}px`)
        lastBox = { row, ...box }
      }

      if (row !== currentRow) {
        // 首次进入：先跳过位置 / 尺寸 / 圆角过渡落位（否则从容器左上角飞入），再淡入
        const firstEntry = !visible
        if (firstEntry) {
          pill.style.transition = 'none'
          pill.dataset.visible = 'false'
        }
        if (!adoptRow(row)) {
          // 当缝隙处理：胶囊留在上一行，过宽限期原地淡出；快速掠过时直接滑到下一行
          rejectedRow = row
          if (firstEntry) {
            pill.style.transition = ''
          }
          scheduleHide()
          return
        }
        rejectedRow = null
        currentRow = row
        if (firstEntry) {
          visible = true
          place()
          void pill.offsetWidth
          pill.style.transition = ''
          pill.dataset.visible = 'true'
          return
        }
      }

      if (!visible) return
      if (!unchanged) place()
    }

    const resolveRow = (target: EventTarget | null): HTMLElement | null => {
      if (!(target instanceof Element)) return null
      const row = target.closest<HTMLElement>(ROW_SELECTOR)
      return row && ownedBy(row, container) ? row : null
    }

    if (mode === 'highlight') {
      // 换行时旧属性摘除、新属性落下在同一次提交里：回调只看"此刻谁带高亮属性"
      const sync = () => {
        const row = highlightedRow(container)
        if (row) moveToRow(row)
        else if (currentRow !== null) scheduleHide()
      }
      const observer = new MutationObserver(sync)
      observer.observe(container, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: [...HIGHLIGHT_ATTRS],
      })
      sync()
      return () => {
        observer.disconnect()
        classObserver.disconnect()
        hideImmediate()
        container.removeAttribute(OWNER_ATTR)
      }
    }

    if (mode === 'focus') {
      const onFocusIn = (event: FocusEvent) => {
        const row = resolveRow(event.target)
        if (row) moveToRow(row)
        else hideImmediate()
      }
      // relatedTarget 为 null = 窗口失焦或焦点去向未知：不动（回来时行仍持有焦点，
      // 却不会再派发 focusin，藏了就找不回）
      const onFocusOut = (event: FocusEvent) => {
        const next = event.relatedTarget
        if (next instanceof Node && !container.contains(next)) hideImmediate()
      }
      container.addEventListener('focusin', onFocusIn)
      container.addEventListener('focusout', onFocusOut)
      // Base UI 在子级 effect 里落焦点，可能早于本监听挂载：按当前焦点补一次同步
      const focused = resolveRow(document.activeElement)
      if (focused) moveToRow(focused)
      return () => {
        classObserver.disconnect()
        hideImmediate()
        container.removeAttribute(OWNER_ATTR)
        container.removeEventListener('focusin', onFocusIn)
        container.removeEventListener('focusout', onFocusOut)
      }
    }

    const onPointerOver = (event: PointerEvent) => {
      pointer.x = event.clientX
      pointer.y = event.clientY
      pointer.inside = true
      const row = resolveRow(event.target)
      if (row) moveToRow(row)
      else scheduleHide()
    }

    const onPointerMove = (event: PointerEvent) => {
      pointer.x = event.clientX
      pointer.y = event.clientY
      pointer.inside = true
      const row = resolveRow(event.target)
      if (row) moveToRow(row)
      else if (visible) scheduleHide()
    }

    const onPointerLeave = () => {
      pointer.inside = false
      hideImmediate()
    }

    // 滚轮滚动时指针不动，按最后坐标同步胶囊到当前命中的行。行组里面的列表会滚（捕获阶段接住
    // 不冒泡的 scroll），行组的父级滚动容器会滚（内容侧栏）—— 两处都听。
    const scroller = container.parentElement
    const onScroll = () => {
      if (!pointer.inside || scrollRaf !== undefined) return
      scrollRaf = window.requestAnimationFrame(() => {
        scrollRaf = undefined
        if (!pointer.inside) return
        const hit = document.elementFromPoint(pointer.x, pointer.y)
        const row = resolveRow(hit)
        if (row) moveToRow(row)
        else scheduleHide()
      })
    }

    container.addEventListener('pointerover', onPointerOver)
    container.addEventListener('pointermove', onPointerMove)
    container.addEventListener('pointerleave', onPointerLeave)
    container.addEventListener('scroll', onScroll, { passive: true, capture: true })
    scroller?.addEventListener('scroll', onScroll, { passive: true })

    return () => {
      clearHideTimer()
      if (scrollRaf !== undefined) window.cancelAnimationFrame(scrollRaf)
      classObserver.disconnect()
      hideImmediate()
      container.removeAttribute(OWNER_ATTR)
      container.removeEventListener('pointerover', onPointerOver)
      container.removeEventListener('pointermove', onPointerMove)
      container.removeEventListener('pointerleave', onPointerLeave)
      container.removeEventListener('scroll', onScroll, { capture: true })
      scroller?.removeEventListener('scroll', onScroll)
    }
  }, [container, on, mode])

  return {
    containerRef,
    /** 关时为空串：容器的类名与未装配时一致（relative / isolate 只在胶囊在场时需要） */
    containerClassName: on ? 'relative isolate' : '',
    /** 放进行容器首子位；关闭时为 null，DOM 与未装配时一致 */
    pill: on ? (
      <div ref={pillRef} aria-hidden="true" className="hover-slide-pill" data-visible="false" />
    ) : null,
  }
}
