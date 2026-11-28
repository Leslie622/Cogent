/** 外壳分栏宽度（会话侧栏 / 右侧工作区）的写入与消费端登记；过渡类名见 globals.css「外壳分栏宽度」。
 *
 *  各消费端读同一个数来对齐：开合（状态提交后的布局效应）与拖拽（rAF 直写）都经 writeShellPane
 *  一次写全，同一帧起同一条过渡，不需要镜像宽度。
 *
 *  写什么、写在哪，是按 Chromium 的实测定的（Electron 40.9.3 / Chromium 144，2026-11-28）：
 *  - 变量挂在祖先上继承、在祖先上插值：每帧整棵子树重算样式（1.4 万元素每帧约 8ms，开合全程掉帧）。
 *  - 在元素上内联写入自定义属性（注册为不继承也一样）：每写一次，这个元素的整棵子树重算一遍
 *    （300 行会话侧栏的裁剪窗 28ms/次），拖拽逐帧写就是逐帧卡。
 *  - 内联写普通 width / padding：零次样式重算，只触发布局；变量自身的 CSS 过渡逐帧只重算元素自己。
 *  所以消费端一律内联写普通属性（宽度随分栏宽线性变化，同一条过渡即同步）；只有必须用 max()
 *  公式的应用头部中块保留变量，它的子树只有二十几个元素。 */
import { useLayoutEffect } from 'react'

export const SIDEBAR_PANE = 'sidebar'
export const WORKSPACE_PANE = 'workspace'
export type ShellPane = typeof SIDEBAR_PANE | typeof WORKSPACE_PANE

/** 各分栏最近一次写入的宽度：晚挂的消费端照它补写 */
const widths = new Map<ShellPane, number>()

/** 写全一条分栏的消费端。元素上的标记：
 *  data-shell-pane        所属分栏
 *  data-shell-pane-prop   写哪条内联样式，缺省 width；只有应用头部中块写变量 --shell-workspace-w（让位公式带 max()）
 *  data-shell-pane-offset 在分栏宽上加的常量（应用头部左块 = 图标栏 + 两道 1px 边）
 *  data-shell-pane-preserve 内层只跟随非零宽，收起时保宽，不参与过渡
 *  resizing 表示容器尺寸变化，消费端即时跟随；下一次开合写入恢复过渡 */
export function writeShellPane(name: ShellPane, px: number, resizing = false) {
  widths.set(name, px)
  for (const element of document.querySelectorAll<HTMLElement>(`[data-shell-pane='${name}']`)) {
    // 内层在收起时保宽；它不播放宽度过渡，只由外层裁剪。容器尺寸变化则即时跟随，
    // 不能逐帧重新启动开合过渡，否则面板与内容会相互追赶。
    const preserve = element.hasAttribute('data-shell-pane-preserve')
    if (preserve && px === 0) continue
    if (!preserve) element.toggleAttribute('data-shell-pane-resizing', resizing)
    const offset = Number(element.dataset.shellPaneOffset ?? 0)
    const length = `${Math.max(0, px + offset)}px`
    // 属性名逐个写成字面量：字号检查要求 style.setProperty 的属性名可静态判定，这里只会是长度
    if (element.dataset.shellPaneProp === '--shell-workspace-w') element.style.setProperty('--shell-workspace-w', length)
    else element.style.width = length
  }
}

/** 消费端组件调用：挂载后补写一次当前宽度 —— 晚于上一次写入才挂上的元素（懒加载的工作区面板）
 *  不至于停在 0。写入的是各处已有的数，不会起过渡。 */
export function useShellPane(name: ShellPane) {
  useLayoutEffect(() => { writeShellPane(name, widths.get(name) ?? 0) }, [name])
}
