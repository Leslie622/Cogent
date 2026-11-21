/** 用真实 CSS 验证按钮尺寸与输入聚焦边界，避免 jsdom 的零布局和缺少样式掩盖问题。 */
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { IconArrowUp, IconFolder, IconPlus } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { AttachmentMenu } from '@/features/home/AttachmentMenu'
import '@/globals.css'

declare global { interface Window { verifyInputGroup?: () => Promise<void> } }

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function App() {
  const [report, setReport] = useState('运行中')
  useEffect(() => {
    const run = async () => {
      await document.fonts.ready
      for (const size of [11, 14, 16]) {
        document.documentElement.style.setProperty('--ui-font-size', `${size}px`)
        await frame()
        for (const [label, expected] of [['小图标', 24], ['添加附件', 28], ['发送', 28]] as const) {
          const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
          const rect = button.getBoundingClientRect()
          const icon = button.querySelector('svg')!.getBoundingClientRect()
          assert(rect.width === expected && rect.height === expected, `${label} 在字号 ${size} 下尺寸为 ${rect.width}×${rect.height}`)
          assert(Math.abs((icon.left + icon.right) - (rect.left + rect.right)) < 1, `${label} 图标水平偏移`)
          assert(Math.abs((icon.top + icon.bottom) - (rect.top + rect.bottom)) < 1, `${label} 图标垂直偏移`)
        }
      }
      for (const dark of [false, true]) {
        document.documentElement.classList.toggle('dark', dark)
        for (const [label, outlined] of [['普通输入', true], ['项目名称', false], ['原生搜索', false], ['组合输入', true], ['对话输入', false]] as const) {
          const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
          const restingShadow = getComputedStyle(input).boxShadow
          input.focus()
          await frame()
          // 隐藏窗口只核对聚焦后的终态，过渡本身由实际应用验收。
          for (const animation of document.getAnimations()) {
            if (animation.constructor.name === 'CSSTransition') animation.finish()
          }
          await frame()
          assert(document.activeElement === input && input.matches(':focus-visible'), `${label} 没有取得可见焦点：active=${document.activeElement?.getAttribute('aria-label')}，focus-visible=${input.matches(':focus-visible')}`)
          const target = input.closest('[data-slot="input-group"]') ?? input
          const style = getComputedStyle(target)
          const visible = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 && style.outlineColor !== 'rgba(0, 0, 0, 0)'
          assert(visible === outlined, `${label} 在${dark ? '深色' : '浅色'}下聚焦轮廓错误：${style.outline}`)
          if (label === '项目名称') {
            const shell = getComputedStyle(input.parentElement!)
            assert(parseFloat(style.borderWidth) === 0 && style.boxShadow === restingShadow, `项目名称聚焦时新增边框或阴影：${style.borderWidth} / ${style.boxShadow}`)
            assert(style.backgroundColor === 'rgba(0, 0, 0, 0)', '项目名称输入底色盖住外壳')
            assert(shell.outlineStyle === 'none' || shell.outlineColor === 'rgba(0, 0, 0, 0)', '项目名称外壳出现聚焦框')
          }
        }
      }
      document.querySelector<HTMLButtonElement>('[aria-label="添加附件"]')!.click()
      await frame()
      await frame()
      assert(document.querySelectorAll('[role="menuitem"]').length === 2, '附件菜单未打开')
      setReport('通过：三档字号下按钮为正方形、图标居中，明暗两套输入聚焦边界正确，附件菜单可打开。')
    }
    const verify = async () => {
      try { await run() }
      catch (error) { setReport(`失败：${error instanceof Error ? error.message : String(error)}`) }
    }
    window.verifyInputGroup = verify
    if (!new URLSearchParams(location.search).has('driver')) void verify()
  }, [])
  return <>
    <output id="report" className="block p-4">{report}</output>
    <Input aria-label="普通输入" defaultValue="保留聚焦框" />
    <div className="flex items-center gap-2 rounded-xl bg-muted/60 px-3">
      <IconFolder className="size-4 text-muted-foreground" />
      <Input variant="embedded" aria-label="项目名称" defaultValue="skill-test" />
    </div>
    <input aria-label="原生搜索" className="outline-none" />
    <InputGroup><InputGroupInput aria-label="组合输入" /></InputGroup>
    <InputGroup variant="composer"><InputGroupInput aria-label="对话输入" /></InputGroup>
    <InputGroup>
      <InputGroupAddon align="block-end">
        <InputGroupButton size="icon-xs" aria-label="小图标"><IconPlus /></InputGroupButton>
        <AttachmentMenu disabled={false} onAdd={() => {}} onError={() => {}} />
        <Button size="icon-sm" aria-label="发送"><IconArrowUp /></Button>
      </InputGroupAddon>
    </InputGroup>
  </>
}

createRoot(document.getElementById('root')!).render(<App />)
