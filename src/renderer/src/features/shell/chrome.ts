/** 应用头部（玻璃外壳面）上的通用样式常量。头部是单行三区块，对话头与标签头从内容区搬进来后
 *  与原有控件同处一条拖拽区、同一张外壳底色，故单独成模块供 AppHeader / ChatHeader / WorkspaceTabs
 *  共用，避免 shell 与 home、workspace 互相引用。 */
import type { CSSProperties } from 'react'

/** 头部整行是窗口拖拽区（WebkitAppRegion: drag），可交互的控件必须逐个标回 no-drag：
 *  拖拽区内的元素收不到指针事件 —— 按钮点不动，依赖 hover 的信息卡与提示也不触发。 */
export const NO_DRAG = { WebkitAppRegion: 'no-drag' } as CSSProperties

/** 玻璃外壳面上的 ghost hover 覆盖：用半透明柔白光替代黑灰叠层，在彩色磨砂底上更通透。 */
export const CHROME_HOVER = 'hover:bg-(--chrome-hover) hover:text-foreground'
