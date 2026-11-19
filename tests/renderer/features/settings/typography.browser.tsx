/** 真实布局矩阵：公共控件、内容隔离、三处代码消费和同源窗口同步。 */
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { BubbleContent } from '@/components/ui/bubble'
import { CodeBlock, CodeBlockContent } from '@/components/ui/code-block'
import { Markdown } from '@/components/ui/markdown'
import InspectCodeViewer from '@/components/InspectCodeViewer'
import { AppearanceSection } from '@/features/settings/AppearanceSection'
import { SettingsSidebar } from '@/features/settings/SettingsSidebar'
import { useChatTheme } from '@/features/home/ChatTheme'
import { bindAppearanceDom } from '@/lib/appearance-dom'
import { useAppearanceStore } from '@/stores/appearance'
import '@/globals.css'

const unbindAppearance = bindAppearanceDom()
const peer = new URLSearchParams(location.search).has('peer')
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
const code = 'const 中文 = "字号验证";\nconsole.log(中文);'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function App() {
  const vars = useChatTheme()
  const [raw, setRaw] = useState(false)
  const [report, setReport] = useState('运行中')
  useEffect(() => {
    document.body.dataset.ready = 'true'
    if (peer) return
    const run = async () => {
      await document.fonts.ready
      const other = document.createElement('iframe')
      other.title = '独立窗口模拟'
      other.src = `${location.pathname}?peer`
      other.style.display = 'none'
      const loaded = new Promise<void>(resolve => { other.onload = () => resolve() })
      document.body.append(other)
      await loaded
      const results: string[] = []
      const font = (selector: string) => parseFloat(getComputedStyle(document.querySelector(selector)!).fontSize)
      for (const dark of [false, true]) {
        useAppearanceStore.getState().setColorMode(dark ? 'dark' : 'light')
        for (const width of [400, 1100]) {
          document.querySelector<HTMLElement>('[data-specimens]')!.style.width = `${width}px`
          for (const size of [11, 14, 16]) {
            useAppearanceStore.getState().setUiFontSize(size)
            for (const codeSize of [8, 14, 24]) {
              useAppearanceStore.getState().setCodeFontSize(codeSize)
              await frame()
              await frame()
              assert(font('[data-tier=small]') === Math.max(10, size - 2), '小字阶错误')
              assert(font('[data-tier=body]') === size, '正文阶错误')
              assert(font('[data-tier=heading]') === size + 2, '标题阶错误')
              assert(font('[data-tier=title]') === size + 10, '页标题阶错误')
              assert(font('[data-content]') === 14 && font('.md-body') === 14, '界面字号串入内容')
              assert(font('[data-tool-code] pre') === codeSize, '工具输出未响应')
              assert(font('[data-inspect-code] .cm-content') === codeSize, '控制台未响应')
              assert(font('.md-body pre') === codeSize, 'Markdown 代码未响应')
              const settings = document.querySelector<HTMLElement>('[data-settings]')!
              assert(settings.scrollWidth <= settings.clientWidth + 1, '设置页窄布局横向溢出')
              for (const control of document.querySelectorAll<HTMLElement>('[data-controls] button, [data-controls] input, [data-controls] [data-slot=badge]')) {
                const style = getComputedStyle(control)
                const room = control.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
                assert(room + 1 >= parseFloat(style.lineHeight), `控件高度不足：${control.textContent}`)
              }
              const otherRoot = other.contentDocument!.documentElement
              for (let attempt = 0; attempt < 80 && (otherRoot.style.getPropertyValue('--ui-font-size') !== `${size}px` || otherRoot.style.getPropertyValue('--app-code-size') !== `${codeSize}px`); attempt++) {
                await new Promise<void>(resolve => setTimeout(resolve, 25))
              }
              assert(otherRoot.style.getPropertyValue('--ui-font-size') === `${size}px`, `其他窗口界面字号未更新：${otherRoot.getAttribute('style')}`)
              assert(otherRoot.style.getPropertyValue('--app-code-size') === `${codeSize}px`, '其他窗口代码字号未更新')
              results.push(`${dark ? '深' : '浅'} ${width}px / UI ${size}px / Code ${codeSize}px`)
            }
          }
        }
      }
      setRaw(true)
      await frame()
      await frame()
      assert(font('[data-inspect-code] pre') === 24, '原文视图未响应')
      useAppearanceStore.getState().setCodeFontSize(null)
      await frame()
      assert(font('[data-inspect-code] pre') === 14, '代码默认值未恢复')
      useAppearanceStore.getState().setUiFontSize(14)
      useAppearanceStore.getState().setColorMode('light')
      other.remove()
      setReport(`通过：${results.length} 组字号/宽度/明暗组合；内容隔离、跨窗口、原文和恢复默认通过。`)
    }
    void run().catch((error: unknown) => setReport(`失败：${error instanceof Error ? error.message : String(error)}`))
  }, [])
  if (peer) return <p className="text-sm">同源窗口</p>
  return <>
    <output id="report" className="block p-4">{report}</output>
    <div data-specimens className="p-4">
      <p data-tier="small" className="text-xs">说明与时间</p>
      <p data-tier="body" className="text-sm">列表与正文</p>
      <p data-tier="heading" className="text-base">分组标题</p>
      <p data-tier="title" className="text-2xl">页面标题</p>
      <div data-controls className="flex flex-wrap items-start gap-2">
        <Button>普通按钮</Button><Button size="xs">紧凑按钮</Button><Button size="sm">小按钮</Button>
        <Button size="console">控制台</Button><Badge size="sm">视觉</Badge><Input aria-label="测试输入" />
      </div>
      <BubbleContent data-content className="content-typography">用户内容，保持默认字号</BubbleContent>
      <div style={vars}><Markdown content={`正文示例\n\n\`\`\`js\n${code}\n\`\`\``} /></div>
      <div data-tool-code><CodeBlock><CodeBlockContent>{code}</CodeBlockContent></CodeBlock></div>
      <div data-inspect-code><InspectCodeViewer content={'{"正文": 123}'} format="json" label="代码验收" raw={raw} wrap render={(controls, body) => <>{controls}{body}</>} /></div>
      <div className="w-60"><SettingsSidebar /></div>
      <div data-settings><AppearanceSection /></div>
    </div>
  </>
}

const appRoot = createRoot(document.getElementById('root')!)
appRoot.render(<App />)
if (import.meta.hot) import.meta.hot.dispose(() => { unbindAppearance(); appRoot.unmount() })
