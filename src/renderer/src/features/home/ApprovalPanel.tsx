/**
 * 审批确认面板（审批交互升级 D1/D2；2026-11-11 布局定稿 = 完全模仿用户参考
 * 图的竖排选项列表形态）—— 待审批时**替换输入区**（run 挂起中本就发不出
 * 消息，留着能打字的框是误导；HomeChat 条件切换，输入草稿提升父层持防丢）。
 *
 * 卡片结构（参考图逐行对位）：
 *   「需要权限」小标题 → 参数行（铅笔 + 等待确认 + 文件图标 + 文件名 + 路径
 *   灰字）→ **竖排全宽选项列表**（序号 + 主文案 + 说明灰字；允许 / 始终允许
 *   此工作区（无绑定根会话不显，D3）/ 完全访问 / 拒绝）→ 附言输入框
 *   （「告诉模型接下来应该怎么做…」，Enter = 拒绝并附言）→ 底部行（ⓘ 快捷
 *   键提示 + 深色「确认」主钮）。
 *
 * 键盘模型（参考图的终端式选择 GUI 化）：↑↓/Tab 在选项间移动**选中态**
 * （React state，浅灰底高亮，非 DOM 焦点轮转），Enter/确认钮 = 执行选中项；
 * 面板出现即聚焦卡容器（替换了输入框，键盘焦点必须落在裁决入口）。点击
 * 选项行 = 直接执行（GUI 直觉）；附言框聚焦时 ↑↓ 移动选中并交还焦点。
 */
import { useEffect, useRef, useState } from 'react'
import { IconFileText, IconInfoCircle, IconPencil } from '@tabler/icons-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useChatStore } from '@/stores/chat'

/** 选项定义：序号自动按下标生成（无根会话去掉「始终允许」后顺移） */
interface ApprovalOption {
  label: string
  desc: string
  /** 附言与 setPermission 由面板逻辑处理，这里只挂 respond 语义 */
  run: (respond: (approved: boolean, options?: { message?: string; always?: 'workspace' }) => void) => void
}

/**
 * 从引擎摘要（write(path, content…)）提取目标路径再拆 文件名/目录：参数行
 * 参考图形态是「文件名深色 + 路径灰」。write 参数序 path 在前，取首个逗号前
 * 片段；解析不出（历史怪形状）整条原样显示，不防御性兜底成空白。
 */
function splitPath(summary: string): { fileName: string; dir: string } {
  const inner = summary.slice(summary.indexOf('(') + 1, summary.lastIndexOf(')'))
  const raw = inner.split(', ')[0]?.trim() ?? ''
  if (raw === '') return { fileName: summary, dir: '' }
  const parts = raw.split(/[\\/]/).filter(Boolean)
  const fileName = parts.at(-1) ?? raw
  const dir = parts.length > 1 ? `${parts.slice(0, -1).join('/')}/` : ''
  return { fileName, dir }
}

function PendingApprovalCard({
  requestId,
  summary,
  hasRoots,
  autoFocus
}: {
  requestId: string
  summary: string
  /** 有绑定根才显「始终允许此工作区」（D3：无根规则 = 全放主目录，过大） */
  hasRoots: boolean
  autoFocus: boolean
}) {
  const respondApproval = useChatStore((s) => s.respondApproval)
  const setPermission = useChatStore((s) => s.setPermission)
  const [selected, setSelected] = useState(0)
  const [note, setNote] = useState('')
  const cardRef = useRef<HTMLDivElement>(null)

  /** respondApproval 的本卡绑定形态（选项 run 的统一签名）：requestId 已闭包 */
  const respond = (approved: boolean, options?: { message?: string; always?: 'workspace' }) => {
    void respondApproval(requestId, approved, options)
  }

  const options: ApprovalOption[] = [
    { label: '允许', desc: '仅允许这一次', run: (r) => r(true) },
    ...(hasRoots
      ? [
          {
            label: '始终允许此工作区',
            desc: '此工作区后续写操作不再询问',
            run: (r: Parameters<ApprovalOption['run']>[0]) => r(true, { always: 'workspace' })
          }
        ]
      : []),
    {
      label: '完全访问',
      desc: '授予完全访问权限，后续不再确认',
      run: (r) => {
        r(true)
        const sessionId = useChatStore.getState().activeSessionId
        if (sessionId !== null) void setPermission(sessionId, 'auto')
      }
    },
    { label: '拒绝', desc: '这次先拒绝', run: (r) => r(false) }
  ]

  const execute = (index: number) => {
    options[index]?.run(respond)
  }

  // 附言提交 = 拒绝 + 附言（空附言不动作 —— 用户在空框上按 Enter 多半是想确认选中项）
  const denyWithNote = () => {
    const text = note.trim()
    if (text === '') return
    void respondApproval(requestId, false, { message: text })
    setNote('')
  }

  // 附言框聚焦 = 当前动作是写附言，选项高亮让位（-1 = 无选中；键盘 ↑↓ 或
  // hover 行会重新点亮）—— 否则灰底赖在旧选中项上，像还挂着待执行
  const clearSelection = () => setSelected(-1)

  // 出现即聚焦卡容器：面板替换了输入框，键盘焦点必须落到裁决入口（Enter =
  // 执行选中项），否则焦点漂在已卸载的输入框语义上
  useEffect(() => {
    if (autoFocus) cardRef.current?.focus()
  }, [autoFocus])

  // 键盘模型：↑↓/Tab 移动选中态（环绕），Enter 执行 —— 挂在卡容器（输入框的
  // Enter/↑↓ 在自己的 handler 处理并截停，不冒泡到这里）。selected = -1
  // （附言聚焦让位后）时 ↓ 落首项、↑ 落末项
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey)) {
      event.preventDefault()
      setSelected((s) => (s + 1) % options.length)
    } else if (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey)) {
      event.preventDefault()
      setSelected((s) => (s <= 0 ? options.length - 1 : s - 1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      execute(selected)
    }
  }

  const { fileName, dir } = splitPath(summary)

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="rounded-2xl border border-border bg-background p-4 outline-none"
    >
      {/* 标题行：参考图灰色小字「需要权限」 */}
      <div className="text-sm font-medium text-foreground">需要权限</div>
      {/* 参数行：铅笔 + 等待确认状态 + 文件图标 + 文件名（深）+ 路径（灰） */}
      <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[13px]">
        <IconPencil className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-muted-foreground">等待确认</span>
        <IconFileText className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium text-foreground">{fileName}</span>
        {dir !== '' && <span className="truncate text-muted-foreground">{dir}</span>}
      </div>
      {/* 选项列表：竖排全宽条状，序号 + 主文案 + 说明灰字；选中态浅灰底
          （键盘 ↑↓/鼠标 hover 点亮，hover 走 CSS —— 移开即消，选中走 state） */}
      <div className="mt-3 flex flex-col gap-1">
        {options.map((option, i) => (
          <button
            key={option.label}
            type="button"
            onClick={() => execute(i)}
            onMouseEnter={() => setSelected(i)}
            onMouseLeave={clearSelection}
            className={cn(
              'flex h-9 items-center gap-2 rounded-lg px-2.5 text-left text-sm text-foreground transition-colors',
              i === selected ? 'bg-muted' : 'hover:bg-muted/60'
            )}
          >
            <span className="w-4 shrink-0 text-[13px] tabular-nums text-muted-foreground">{i + 1}.</span>
            <span className="shrink-0">{option.label}</span>
            <span className="truncate text-[13px] text-muted-foreground">{option.desc}</span>
          </button>
        ))}
      </div>
      {/* 附言（「告诉模型接下来怎么做」）：浅灰无框输入条；Enter = 拒绝并附言
          （isComposing 挡输入法），↑↓ 交还列表选择；聚焦时选项高亮让位 */}
      <Input
        value={note}
        onChange={(event) => setNote(event.target.value)}
        onFocus={clearSelection}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            event.stopPropagation()
            denyWithNote()
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            event.stopPropagation()
            setSelected((s) =>
              event.key === 'ArrowDown' ? (s + 1) % options.length : s <= 0 ? options.length - 1 : s - 1
            )
            cardRef.current?.focus()
          }
        }}
        placeholder="告诉模型接下来应该怎么做…"
        className="mt-2.5 h-9 rounded-lg border-0 bg-muted/60 px-3 text-[13px] placeholder:text-muted-foreground focus-visible:ring-0"
      />
      {/* 底部行：ⓘ 快捷键提示（左）+ 确认主钮（右，深色石墨 = 发送钮同族） */}
      <div className="mt-3 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <IconInfoCircle className="size-3.5" />
          使用 ↑↓ 选择，回车确认
        </span>
        {/* 确认主钮：深色石墨（发送钮同族）。反馈阶梯要拉到可感知 —— 原语
            hover:/90 在近黑 foreground 上只差 10% 透明度，肉眼无感（首验
            「没 hover」的根因）；base-luma button 无 active 态，按压色阶自补 */}
        <Button
          size="sm"
          className="h-8 rounded-lg bg-foreground px-4 text-background hover:bg-foreground/85 active:bg-foreground/70"
          onClick={() => execute(selected)}
        >
          确认
        </Button>
      </div>
    </div>
  )
}

/** 面板本体：占输入区位置（HomeChat 条件切换已保证只在有待审批时挂载；此处
    再守一道空态），容器对齐 ChatComposer 的外框留白（px-4 pb-4 + 内容列宽） */
export function ApprovalPanel() {
  const pending = useChatStore(
    (s) => s.pendingApprovalsBySession[s.activeSessionId ?? ''] ?? undefined
  )
  const hasRoots = useChatStore((s) => {
    const session = s.sessions.find((x) => x.id === s.activeSessionId)
    return session !== undefined && (session.cwd !== undefined || session.projectId !== undefined)
  })
  if (pending === undefined || pending.length === 0) return null
  return (
    <div className="shrink-0 px-4 pb-4">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
        {pending.map((p, i) => (
          <PendingApprovalCard
            key={p.requestId}
            requestId={p.requestId}
            summary={p.summary}
            hasRoots={hasRoots}
            autoFocus={i === 0}
          />
        ))}
      </div>
    </div>
  )
}
