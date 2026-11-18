/** 真实浏览器验收面：只用内存样本，不连接模型或真实会话。 */
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { ConsoleDetail } from '@/features/console/ConsoleDetail'
import { ConsoleTimeline } from '@/features/console/ConsoleTimeline'
import { useConsoleStore } from '@/stores/console'
import { Button } from '@/components/ui/button'
import '@/globals.css'

const content = '{\n  "id": 9007199254740993,\n  "messages": ' + JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `内容 ${i}\\n` + '正文很长，检验自动换行和水平溢出。'.repeat(20) })), null, 2) + ',\n  "usage": { "input": 10000, "output": 234 }\n}'
useConsoleStore.setState({ sessionId: 'fixture', selectedSeq: 2,
  entries: [
    { seq: 1, run: 1, ts: 1700000000123, kind: 'run.started', title: 'run #1 · “你好”', hasDetail: false },
    { seq: 2, run: 1, ts: 1700000000123, kind: 'api.request', title: 'POST deepseek · deepseek-flash', hasDetail: true, overview: [{ label: 'Provider', value: 'deepseek' }, { label: '模型', value: 'deepseek-flash' }] },
    { seq: 3, run: 1, ts: 1700000000123, kind: 'turn.completed', title: 'turn 1 · stop', hasDetail: true, overview: Array.from({ length: 12 }, (_, i) => ({ label: `概览 ${i}`, value: String(i) })) },
    { seq: 4, run: 1, ts: 1700000000123, kind: 'run.completed', title: 'run 完成', hasDetail: false },
    { seq: 5, run: 1, ts: 1700000000123, kind: 'system.prompt', title: '系统提示词 · 490 字符', hasDetail: true, overview: [{ label: '长度', value: '490 字符' }] },
  ],
  details: {
    2: { seq: 2, blocks: [{ name: '请求体（厂商原生 JSON，含 system/messages/tools）', format: 'json', content }] },
    3: { seq: 3, blocks: [{ name: 'assistant 消息（pi 归一化终态）', format: 'json', content }, { name: '附加文本', format: 'text', content: '独立数据块\n第二行' }] },
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
      pane.scrollTop += viewer.getBoundingClientRect().bottom - pane.getBoundingClientRect().bottom + 24
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
    const code = viewer.querySelector<HTMLElement>('.cm-scroller')!
    const last = [...viewer.querySelectorAll<HTMLElement>('.cm-line')].at(-1)!
    const paneRect = pane.getBoundingClientRect(), lastRect = last.getBoundingClientRect()
    const pass = last.textContent === '}' && lastRect.bottom <= paneRect.bottom && lastRect.top >= paneRect.top && code.scrollHeight <= code.clientHeight + 1
    setReport(`${pass ? '通过' : '失败'}：最后一行=${last.textContent}；纵向滚动层=${code.scrollHeight <= code.clientHeight + 1 ? '仅详情页' : '仍有嵌套'}；底部留白=${Math.round(paneRect.bottom - lastRect.bottom)}px`)
  }
  return <div className="select-text p-4">
    <p className="mb-2">浏览器回归样本：Run 状态合并、层级折叠与底部滚动。</p>
    <div className="mb-2 flex gap-2">{[320, 440, 520, 720].map((size) => <Button key={size} variant="outline" onClick={() => setWidth(size)}>{size}px</Button>)}</div>
    <div className="mb-2 flex gap-2"><Button onClick={() => void verifyBottom()}>验证 JSON 底部</Button><output>{report}</output></div>
    <div className="flex gap-6">
      <div style={{ width: 360, height: 650 }}><ConsoleTimeline /></div>
      <div style={{ width, height: 650 }} className="border-l"><ConsoleDetail /></div>
    </div>
  </div>
}
createRoot(document.getElementById('root')!).render(<App />)
