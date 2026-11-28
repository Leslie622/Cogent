/** 浮层行滑动胶囊的共用件（DropdownMenu / ContextMenu / Select / Combobox / Command 同用）。
 *  开关是外观偏好「开启滑动动画」，不逐浮层设：开 = 面板内包一层行容器 + 胶囊，行加
 *  data-hover-slide、原高亮类不动（胶囊读它自己的底色）；关 = 什么都不渲染、不留属性，行按
 *  原样自画。驱动按浮层的高亮机制选：菜单与 Select 的悬停和方向键都是移焦点（focus）；Combobox
 *  与 cmdk 的行拿不到 DOM 焦点，高亮落在 data-highlighted / data-selected 属性上（highlight）。 */
import * as React from "react"
import { useHoverSlide, type HoverSlideMode } from '@/hooks/use-hover-slide'
import { useAppearanceStore } from '@/stores/appearance'

export function useMenuSlideEnabled(): boolean {
  return useAppearanceStore((state) => state.hoverSlide)
}

/** 滑动开启时给 Root 的附加设置。Base UI 菜单项在指针离开某行、且去向不是另一行时（压到分割线、
 *  留白）会清空高亮并把焦点移回面板 —— floating-ui-react/hooks/useListNavigation.js 的
 *  item onPointerLeave + resetOnPointerLeave（menu/root/MenuRoot.js 默认 true）。行 1 →
 *  分割线 → 行 2 因此成了淡出再淡入，滑不过分割线（2026-11-28 验收实录）。关掉它即原生
 *  菜单语义：高亮留在最后一行直到下一行接手，指针移出菜单也保留（同键盘导航）。
 *  resetOnPointerLeave 是 MenuRootInternal 的内部 prop（公开类型未收，filter-dropdown 在
 *  用），公开 MenuRoot 原样透传未知 props，这里用展开绕过类型；Base UI 若移除它只会
 *  退回"滑不过分割线"，permission-menu.render.test 的 pointerout 用例是回归断言。 */
export const MENU_SLIDE_ROOT_PROPS: Record<string, unknown> = { resetOnPointerLeave: false }

/** 滑动开启时面板内的行容器。必须随 Popup 挂载 —— Content 本体在菜单未开时就已挂载，
 *  hook 的监听挂在那一层拿不到 DOM。胶囊居首、行在后，垫在行内容之下。 */
export function MenuSlideRows({
  children,
  mode = 'focus',
}: {
  children: React.ReactNode
  mode?: HoverSlideMode
}) {
  const slide = useHoverSlide({ mode })
  return (
    <div ref={slide.containerRef} className={slide.containerClassName}>
      {slide.pill}
      {children}
    </div>
  )
}
