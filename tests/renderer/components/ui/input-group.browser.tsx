/** 用真实 CSS 验证图标按钮的方形尺寸和居中，避免 jsdom 的零布局掩盖最小高度冲突。 */
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { IconArrowUp, IconPlus } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupButton } from '@/components/ui/input-group'
import { AttachmentMenu } from '@/features/home/AttachmentMenu'
import '@/globals.css'

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
      document.querySelector<HTMLButtonElement>('[aria-label="添加附件"]')!.click()
      await frame()
      await frame()
      assert(document.querySelectorAll('[role="menuitem"]').length === 2, '附件菜单未打开')
      setReport('通过：三档字号下按钮为正方形、图标居中，附件菜单可打开。')
    }
    void run().catch((error: unknown) => setReport(`失败：${error instanceof Error ? error.message : String(error)}`))
  }, [])
  return <>
    <output id="report" className="block p-4">{report}</output>
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
