/** 真实浏览器验收面：只用内存样本，不连接模型或真实会话。 */
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { EditorView } from '@codemirror/view'
import { unfoldAll } from '@codemirror/language'
import { ConsoleDetail } from '@/features/console/ConsoleDetail'
import { ConsoleTimeline } from '@/features/console/ConsoleTimeline'
import { useConsoleStore } from '@/stores/console'
import { Button } from '@/components/ui/button'
import '@/globals.css'

const content = '{\n  "id": 9007199254740993,\n  "messages": ' + JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `内容 ${i}\\n` + '正文很长，检验自动换行和水平溢出。'.repeat(20) })), null, 2) + ',\n  "usage": { "input": 10000, "output": 234 }\n}'
const answer = Array.from({ length: 400 }, (_, i) => `回复第 ${i} 行`).join('\n') + '\n`![图片](图片.png)`\n`[未随附](未随附.txt)`'
const stream = Array.from({ length: 2000 }, (_, i) => JSON.stringify({ choices: [{ delta: { content: i === 1999 ? '末尾唯一命中' : `分片 ${i}` } }] })).join('\n')
useConsoleStore.setState({ sessionId: 'fixture', selectedSeq: 2,
  entries: [
    { seq: 1, run: 1, ts: 1700000000123, kind: 'run.started', title: 'run #1 · “你好”', hasDetail: false },
    { seq: 2, run: 1, ts: 1700000000123, kind: 'api.request', title: 'POST deepseek · deepseek-flash', hasDetail: true, overview: [{ label: 'Provider', value: 'deepseek' }, { label: '模型', value: 'deepseek-flash' }] },
    { seq: 3, run: 1, ts: 1700000000123, kind: 'turn.completed', title: 'turn 1 · stop', hasDetail: true, overview: Array.from({ length: 12 }, (_, i) => ({ label: `概览 ${i}`, value: String(i) })) },
    { seq: 4, run: 1, ts: 1700000000123, kind: 'run.completed', title: 'run 完成', hasDetail: false },
    { seq: 5, run: 1, ts: 1700000000123, kind: 'system.prompt', title: '系统提示词 · 490 字符', hasDetail: true, overview: [{ label: '长度', value: '490 字符' }] },
    { seq: 6, run: 2, ts: 1700000000123, kind: 'api.stream', title: 'SSE 分片 ×2000', hasDetail: true },
  ],
  details: {
    2: { seq: 2, blocks: [{ name: '请求体（厂商原生 JSON，含 system/messages/tools）', format: 'json', content }] },
    3: { seq: 3, blocks: [{ name: 'assistant 消息（pi 归一化终态）', format: 'json', content: JSON.stringify({ role: 'assistant', content: [{ type: 'thinking', thinking: '独立思考' }, { type: 'text', text: answer }] }, null, 2) }] },
    6: { seq: 6, blocks: [{ name: '原始分片（归一化前，一行一条）', format: 'text', content: stream }] },
    5: { seq: 5, blocks: [{ name: '提示词全文', format: 'text', content: 'You are Cogent, a helpful desktop agent.\n\n# 工作区\n你在用户的本地工作区中工作：C:\\Users\\u\\Desktop\\测试项目\n用户消息里的相对路径（文件/目录）都应以这些目录解析；未指明时优先主根。\n\n# 环境\n- 平台：win32\n- 工作区：C:\\Users\\u\\Desktop\\测试项目\n\n# 工具\n你可以调用工具：read（读单个文件，大文件用 offset/limit 分段读）、find（按 glob 模式找文件）、grep（按正则全文搜，返回上下文行）、ls（列目录一层内容）、write（整文件写入，执行前可能需要用户批准）、edit（对已有文件做精确文本替换，执行前可能需要用户批准）、powershell（执行 shell 命令，工作目录为工作区主根，执行前可能需要用户批准）。先用 ls/find/grep 定位、再用 read 读内容；修改已有文件优先 edit，整文件新建或重写才用 write。\n相对路径相对工作区主根解析；读取的绝对路径不在工作区外的写入可能需要用户批准后执行。' }] },
  },
})

function App() {
  const [width, setWidth] = useState(440)
  const [report, setReport] = useState('')
  const verifyBottom = async () => {
    const pane = document.querySelector<HTMLElement>('[data-console-detail-scroll]')!
    const viewer = pane.querySelector<HTMLElement>('.cm-editor')!
    // 全展开会让虚拟文档由估高切到实测高度，等测量提交后再定位末行。
    for (let frame = 0; frame < 4; frame += 1) {
      const view = EditorView.findFromDOM(viewer)!
      view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.length, { y: 'end' }) })
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
    const code = viewer.querySelector<HTMLElement>('.cm-scroller')!
    const last = [...viewer.querySelectorAll<HTMLElement>('.cm-line')].at(-1)!
    const codeRect = code.getBoundingClientRect(), lastRect = last.getBoundingClientRect()
    const pass = last.textContent === '}' && lastRect.bottom <= codeRect.bottom && lastRect.top >= codeRect.top && code.scrollTop > 0
    setReport(`${pass ? '通过' : '失败'}：最后一行=${last.textContent}；块内滚动=${Math.round(code.scrollTop)}px；底部留白=${Math.round(codeRect.bottom - lastRect.bottom)}px`)
  }
  return <div className="select-text p-4">
    <p className="mb-2">浏览器回归样本：完整回复、分片搜索与块内滚动。</p>
    <div className="mb-2 flex gap-2">{[320, 440, 520, 720].map((size) => <Button key={size} variant="outline" onClick={() => setWidth(size)}>{size}px</Button>)}</div>
    <div className="mb-2 flex gap-2"><Button onClick={() => void verifyBottom()}>验证 JSON 底部</Button><output>{report}</output></div>
    <div className="flex gap-6">
      <div style={{ width: 360, height: 650 }}><ConsoleTimeline /></div>
      <div data-console-fixture-pane style={{ width, height: 650 }} className="border-l"><ConsoleDetail /></div>
    </div>
  </div>
}
createRoot(document.getElementById('root')!).render(<App />)

declare global {
  interface Window { verifyConsoleReading: () => Promise<{ passed: boolean; checks: string[] }> }
}

const settle = async () => {
  for (let frame = 0; frame < 6; frame += 1) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

window.verifyConsoleReading = async () => {
  const checks: string[] = []
  const check = (condition: boolean, message: string) => {
    if (!condition) throw new Error(message)
    checks.push(message)
  }
  for (const width of [320, 440, 720]) {
    const widthButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === `${width}px`)!
    widthButton.click()
    await useConsoleStore.getState().selectEntry(4)
    await settle()
    const pane = document.querySelector<HTMLElement>('[data-console-detail-scroll]')!
    const answerElement = pane.querySelector<HTMLElement>('.cm-editor')!
    const answerView = EditorView.findFromDOM(answerElement)!
    check(answerView.state.doc.toString() === answer, `${width}px：完成入口展示正文原字符`)
    check(pane.querySelector<HTMLButtonElement>('button[aria-expanded="false"]') !== null, `${width}px：元信息与原始 JSON 可收起`)

    await useConsoleStore.getState().selectEntry(6)
    await settle()
    const streamPane = document.querySelector<HTMLElement>('[data-console-detail-scroll]')!
    const section = streamPane.querySelector<HTMLElement>('[data-slot="collapsible"]:last-child')!
    const searchButton = [...section.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '搜索')!
    searchButton.click()
    await settle()
    const editor = section.querySelector<HTMLElement>('.cm-editor')!
    const view = EditorView.findFromDOM(editor)!
    const scroll = editor.querySelector<HTMLElement>('.cm-scroller')!
    const input = editor.querySelector<HTMLInputElement>('input[name="search"]')!
    input.value = '末尾唯一命中'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    const outerTop = streamPane.scrollTop
    const searchTop = input.getBoundingClientRect().top
    editor.querySelector<HTMLButtonElement>('button[name="next"]')!.click()
    await settle()
    const panelRect = input.getBoundingClientRect(), paneRect = streamPane.getBoundingClientRect()
    check(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to) === '末尾唯一命中', `${width}px：搜索定位最后一片`)
    check(scroll.scrollTop > 0 && scroll.scrollHeight > scroll.clientHeight, `${width}px：长分片使用块内滚动`)
    check(Math.abs(streamPane.scrollTop - outerTop) <= 1 && Math.abs(panelRect.top - searchTop) <= 1, `${width}px：搜索不卷走搜索栏或移动外层详情`)
    check(panelRect.top >= paneRect.top && panelRect.bottom <= paneRect.bottom, `${width}px：搜索输入始终可见`)
    const matchRect = view.coordsAtPos(view.state.selection.main.to)!
    const scrollRect = scroll.getBoundingClientRect()
    check(matchRect.top >= scrollRect.top && matchRect.bottom <= Math.min(scrollRect.bottom, paneRect.bottom), `${width}px：末尾命中位于可见区内`)
    input.value = '分片 10'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    editor.querySelector<HTMLButtonElement>('button[name="next"]')!.click()
    await settle()
    check(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to) === '分片 10', `${width}px：末尾定位后继续搜索可用`)
    check(getComputedStyle(scroll).overscrollBehaviorY === 'contain', `${width}px：分片滚动边界独立`)

    const more = section.querySelector<HTMLButtonElement>('button[aria-label="原始分片更多选项"]')!
    more.click()
    await settle()
    const rawItem = [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find((item) => item.textContent === '原文')!
    rawItem.click()
    await settle()
    const raw = section.querySelector<HTMLElement>('pre')!
    raw.scrollTop = raw.scrollHeight
    check(raw.textContent === stream && raw.scrollTop > 0 && raw.clientHeight <= window.innerHeight * 0.6 + 1, `${width}px：原文保真且独立滚动`)
  }
  await useConsoleStore.getState().selectEntry(2)
  await settle()
  const pane = document.querySelector<HTMLElement>('[data-console-detail-scroll]')!
  const view = EditorView.findFromDOM(pane.querySelector<HTMLElement>('.cm-editor')!)!
  check(view.state.doc.toString().includes('9007199254740993'), '原始 JSON 大整数未被改写')
  unfoldAll(view)
  view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.length, { y: 'end' }) })
  await settle()
  const last = [...view.dom.querySelectorAll<HTMLElement>('.cm-line')].at(-1)!
  const lastRect = last.getBoundingClientRect(), codeRect = view.scrollDOM.getBoundingClientRect()
  check(last.textContent === '}' && lastRect.top >= codeRect.top && lastRect.bottom <= Math.min(codeRect.bottom, pane.getBoundingClientRect().bottom), '全部展开后 JSON 最后一行完整可见')
  return { passed: true, checks }
}
