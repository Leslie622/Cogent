/**
 * 方案审批面板（交互座 4c-3）—— submit_plan 挂起时呈现方案并收裁决。
 * ApprovalPanel 母版：占输入区位置、竖排选项、键盘 ↑↓/Enter、附言输入。
 * 选项：批准（= 关计划开关，权限档不动 —— 正交开关 v3 起无切档下拉，
 * 原档自动恢复）/ 拒绝（附言 = 修改意见，开关保持开等修订重提）。
 */
import { useEffect, useRef, useState } from 'react'
import { IconInfoCircle, IconMap } from '@tabler/icons-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useChatStore, type PendingPlan } from '@/stores/chat'

function PendingPlanCard({ pending, autoFocus }: { pending: PendingPlan; autoFocus: boolean }) {
  const respondPlan = useChatStore((s) => s.respondPlan)
  const [selected, setSelected] = useState(0)
  const [note, setNote] = useState('')
  const cardRef = useRef<HTMLDivElement>(null)

  const options: Array<{ label: string; desc: string; run: () => void }> = [
    {
      label: '批准',
      desc: '退出计划模式，按当前权限档开始执行',
      run: () => void respondPlan(pending.requestId, true)
    },
    { label: '拒绝', desc: '这次先不执行', run: () => void respondPlan(pending.requestId, false) }
  ]

  const execute = (index: number): void => {
    options[index]?.run()
  }

  // 附言提交 = 拒绝 + 修改意见（空附言不动作 —— 同 ApprovalPanel）
  const denyWithNote = (): void => {
    const text = note.trim()
    if (text === '') return
    void respondPlan(pending.requestId, false, { message: text })
    setNote('')
  }

  useEffect(() => {
    if (autoFocus) cardRef.current?.focus()
  }, [autoFocus])

  const onKeyDown = (event: React.KeyboardEvent): void => {
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

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="rounded-2xl border border-border bg-background p-4 outline-none"
    >
      <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        <IconMap className="size-4 text-muted-foreground" />
        实现计划待审批
      </div>
      {/* 方案预览：滚动限高（长方案不撑爆面板；全文模型侧有，面板预览够用） */}
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-xl bg-muted/40 p-3 text-[13px] leading-relaxed text-foreground">
        {pending.plan}
      </pre>
      <div className="mt-3 flex flex-col gap-1">
        {options.map((option, i) => (
          <button
            key={option.label}
            type="button"
            onClick={() => execute(i)}
            onMouseEnter={() => setSelected(i)}
            onMouseLeave={() => setSelected(-1)}
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
      {/* 附言 = 拒绝的修改意见（回灌模型修订重提） */}
      <Input
        value={note}
        onChange={(event) => setNote(event.target.value)}
        onFocus={() => setSelected(-1)}
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
        placeholder="拒绝时的修改意见（模型会按此修订）…"
        className="mt-2.5 h-9 rounded-lg border-0 bg-muted/60 px-3 text-[13px] placeholder:text-muted-foreground focus-visible:ring-0"
      />
      <div className="mt-3 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <IconInfoCircle className="size-3.5" />
          使用 ↑↓ 选择，回车确认
        </span>
        {/* 无选中（selected = -1）置灰 —— 同 ApprovalPanel（2026-11-16 定调） */}
        <Button
          size="sm"
          disabled={selected === -1}
          className="h-8 rounded-lg bg-foreground px-4 text-background hover:bg-foreground/85 active:bg-foreground/70"
          onClick={() => execute(selected)}
        >
          确认
        </Button>
      </div>
    </div>
  )
}

/** 面板本体：与 ApprovalPanel/QuestionPanel 同位（输入区替换层） */
export function PlanPanel() {
  const pending = useChatStore((s) => s.bySession[s.activeSessionId ?? '']?.pendingPlans ?? undefined)
  if (pending === undefined || pending.length === 0) return null
  return (
    <div className="shrink-0 px-4 pb-4">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
        {pending.map((p, i) => (
          <PendingPlanCard key={p.requestId} pending={p} autoFocus={i === 0} />
        ))}
      </div>
    </div>
  )
}
