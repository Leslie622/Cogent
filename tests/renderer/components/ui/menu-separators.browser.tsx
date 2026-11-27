/** 真实菜单的像素验收面；保留动画与浮层定位，截图前等待它们完成。 */
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { IconInfoCircle, IconSettings, IconTerminal2, IconWorld } from '@tabler/icons-react'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'
import { ButtonGroupSeparator } from '@/components/ui/button-group'
import '@/globals.css'

const root = createRoot(document.getElementById('root')!)
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

async function show(size: 'default' | 'lg', fontSize: number, dark: boolean, offset: number) {
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.style.setProperty('--ui-font-size', `${fontSize}px`)
  flushSync(() => root.render(
    <div style={{ position: 'absolute', left: 40, top: 350 + offset }}>
      <DropdownMenu open>
        <DropdownMenuTrigger>设置</DropdownMenuTrigger>
        <DropdownMenuContent size={size} side="right" align="end" className="w-auto min-w-36">
          <DropdownMenuItem><IconSettings className="size-[17px]" />设置</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem><IconTerminal2 className="size-[17px]" />运行时控制台</DropdownMenuItem>
          <DropdownMenuItem><IconWorld className="size-[17px]" />内嵌页面</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem><IconInfoCircle className="size-[17px]" />关于</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>,
  ))
  await document.fonts.ready
  await frame()
  await frame()
  await Promise.all(document.getAnimations().map((animation) => animation.finished))
  await frame()
  return [...document.querySelectorAll<HTMLElement>('[data-slot=dropdown-menu-separator]')].map((line) => {
    const { x, y, width, height } = line.getBoundingClientRect()
    return { x, y, width, height }
  })
}

/** 覆盖同一取整问题的通用横线、竖线与按钮组消费点，位置刻意落在分数坐标。 */
async function showSeparators(kind: 'horizontal' | 'vertical' | 'button-group-horizontal' | 'button-group-vertical', fontSize: number, dark: boolean, offset: number) {
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.style.setProperty('--ui-font-size', `${fontSize}px`)
  const vertical = kind.endsWith('vertical')
  const Line = kind.startsWith('button-group') ? ButtonGroupSeparator : Separator
  flushSync(() => root.render(
    <div style={{ position: 'absolute', left: 40 + (vertical ? offset : 0), top: 50 + (vertical ? 0 : offset), width: 300, height: 240, display: 'flex', flexDirection: vertical ? 'row' : 'column' }}>
      <Line orientation={vertical ? 'vertical' : 'horizontal'} />
      <div style={{ flexShrink: 0, width: vertical ? fontSize * 8.1 : undefined, height: vertical ? undefined : fontSize * 8.1 }} />
      <Line orientation={vertical ? 'vertical' : 'horizontal'} />
    </div>,
  ))
  await document.fonts.ready
  await frame()
  await frame()
  return [...document.querySelectorAll<HTMLElement>('[data-slot=separator], [data-slot=button-group-separator]')].map((line) => {
    const { x, y, width, height } = line.getBoundingClientRect()
    return { x, y, width, height }
  })
}

declare global {
  interface Window { menuSeparatorHarness: { show: typeof show; showSeparators: typeof showSeparators } }
}
window.menuSeparatorHarness = { show, showSeparators }
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount())
