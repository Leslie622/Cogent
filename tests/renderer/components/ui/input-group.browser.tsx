/** 用真实 CSS 验证按钮尺寸与输入聚焦边界，避免 jsdom 的零布局和缺少样式掩盖问题。 */
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { IconArrowUp, IconFolder, IconPlus } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { MessageScroller, MessageScrollerContent, MessageScrollerProvider, MessageScrollerViewport } from '@/components/ui/message-scroller'
import { AttachmentMenu } from '@/features/home/AttachmentMenu'
import { ApprovalPanel } from '@/features/home/ApprovalPanel'
import { QuestionPanel } from '@/features/home/QuestionPanel'
import { PlanPanel } from '@/features/home/PlanPanel'
import { emptyBucket, useChatStore } from '@/stores/chat'
import '@/globals.css'

declare global { interface Window { verifyInputGroup?: () => Promise<void> } }

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

async function focusAndSettle(element: HTMLElement): Promise<void> {
  element.focus()
  await frame()
  // 隐藏窗口只核对终态，避免尚未结束的颜色过渡掩盖描边。
  for (const animation of document.getAnimations()) {
    if (animation.constructor.name === 'CSSTransition') animation.finish()
  }
  await frame()
  assert(document.activeElement === element && element.matches(':focus-visible'), '控件没有取得可见焦点')
}

function hasOutline(element: Element): boolean {
  const style = getComputedStyle(element)
  return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 && style.outlineColor !== 'rgba(0, 0, 0, 0)'
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
          await focusAndSettle(input)
          const target = input.closest('[data-slot="input-group"]') ?? input
          const style = getComputedStyle(target)
          assert(hasOutline(target) === outlined, `${label} 在${dark ? '深色' : '浅色'}下聚焦轮廓错误：${style.outline}`)
          if (label === '项目名称') {
            const shell = getComputedStyle(input.parentElement!)
            assert(parseFloat(style.borderWidth) === 0 && style.boxShadow === restingShadow, `项目名称聚焦时新增边框或阴影：${style.borderWidth} / ${style.boxShadow}`)
            assert(style.backgroundColor === 'rgba(0, 0, 0, 0)', '项目名称输入底色盖住外壳')
            assert(shell.outlineStyle === 'none' || shell.outlineColor === 'rgba(0, 0, 0, 0)', '项目名称外壳出现聚焦框')
          }
        }
        // 挂载真实面板，避免只测 embedded 原语却漏掉调用处仍使用默认档。
        for (const placeholder of ['告诉模型接下来应该怎么做…', '输入你的回答...', '拒绝时的修改意见（模型会按此修订）…']) {
          const input = document.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!
          const card = input.closest<HTMLElement>('[tabindex="-1"]')!
          await focusAndSettle(card)
          assert(!hasOutline(card), `${placeholder} 所在卡片出现聚焦描边`)
          await focusAndSettle(input)
          assert(!hasOutline(input), `${placeholder} 出现聚焦描边`)
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
          await frame()
          assert(document.activeElement === card, `${placeholder} 上下键未交还卡片焦点`)
          const button = card.querySelector<HTMLButtonElement>('button:not(:disabled)')!
          await focusAndSettle(button)
          assert(hasOutline(button), `${placeholder} 所在卡片的按钮丢失焦点提示`)
        }
      }
      document.querySelector<HTMLButtonElement>('[aria-label="添加附件"]')!.click()
      await frame()
      await frame()
      assert(document.querySelectorAll('[role="menuitem"]').length === 2, '附件菜单未打开')
      setReport('通过：三档字号下按钮为正方形、图标居中，明暗两套输入聚焦边界正确；审批、询问、方案卡与内嵌输入无聚焦描边，键盘交接及按钮焦点提示正常；附件菜单可打开。')
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
    <MessageScrollerProvider>
      <div className="flex h-40 flex-col">
        <MessageScroller>
          <MessageScrollerViewport>
            <MessageScrollerContent>
              <div className="h-96 p-4">
                聊天滚动区焦点回归
                <Button aria-label="消息操作">消息操作</Button>
              </div>
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
      </div>
    </MessageScrollerProvider>
    <Input aria-label="普通输入" defaultValue="保留聚焦框" />
    <div className="flex items-center gap-2 rounded-xl bg-muted/60 px-3">
      <IconFolder className="size-4 text-muted-foreground" />
      <Input variant="embedded" aria-label="项目名称" defaultValue="skill-test" />
    </div>
    <input aria-label="原生搜索" className="outline-none" />
    <InputGroup><InputGroupInput aria-label="组合输入" /></InputGroup>
    <InputGroup variant="composer"><InputGroupInput aria-label="对话输入" /></InputGroup>
    <ApprovalPanel />
    <QuestionPanel />
    <PlanPanel />
    <InputGroup>
      <InputGroupAddon align="block-end">
        <InputGroupButton size="icon-xs" aria-label="小图标"><IconPlus /></InputGroupButton>
        <AttachmentMenu disabled={false} onAdd={() => {}} onError={() => {}} />
        <Button size="icon-sm" aria-label="发送"><IconArrowUp /></Button>
      </InputGroupAddon>
    </InputGroup>
  </>
}

useChatStore.setState({
  activeSessionId: 's-focus',
  bySession: {
    's-focus': {
      ...emptyBucket(),
      pendingApprovals: [{ requestId: 'a-focus', toolName: 'write_file', toolKind: 'write', summary: 'write(C:/tmp/demo.txt, content)' }],
      pendingQuestions: [{ requestId: 'q-focus', questions: [{ question: '选择一个选项', options: [{ label: '选项一' }, { label: '选项二' }] }] }],
      pendingPlans: [{ requestId: 'p-focus', plan: '验证方案卡焦点' }]
    }
  }
})

createRoot(document.getElementById('root')!).render(<App />)
