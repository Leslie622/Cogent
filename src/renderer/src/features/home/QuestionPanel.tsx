/**
 * 提问面板（交互座 4c-2）—— ask_user 挂起时呈现问题并收作答。
 * ApprovalPanel 同款母版：占输入区位置（HomeChat 条件挂载）、逐问题块、
 * 底部确认钮。作答模型：单选 = 点选项即选中本问（再点取消）；多选 = 勾选
   多项；「其他」自由输入 = 常驻输入条，输入即覆盖该问的选项选择；
 * 整卡一次提交（answers 按问题序；未答的问传空串 = 引擎按跳过处理）。
 */
import { useState } from 'react'
import { IconCircleCheckFilled, IconInfoCircle } from '@tabler/icons-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useChatStore, type PendingQuestion } from '@/stores/chat'

/** 单个问题的作答块：标题 + 选项钮 + 「其他」输入 */
function QuestionCard({
  question,
  selected,
  onSelect,
  other,
  onOther
}: {
  question: PendingQuestion['questions'][number]
  selected: string[]
  onSelect: (label: string) => void
  other: string
  onOther: (text: string) => void
}) {
  return (
    <div className="rounded-xl bg-muted/40 p-3">
      <div className="text-sm font-medium text-foreground">
        {question.header !== undefined && question.header !== '' && (
          <span className="mr-1.5 text-muted-foreground">{question.header}：</span>
        )}
        {question.question}
      </div>
      <div className="mt-2 flex flex-col gap-1">
        {question.options.map((option) => {
          const isSelected = selected.includes(option.label)
          return (
            <button
              key={option.label}
              type="button"
              className={cn(
                'flex min-h-9 items-center gap-2 rounded-lg px-2.5 py-1 text-left text-sm transition-colors',
                isSelected ? 'bg-muted' : 'hover:bg-muted/60'
              )}
              onClick={() => onSelect(option.label)}
            >
              {question.multiSelect === true && (
                <IconCircleCheckFilled
                  className={cn('size-4 shrink-0', isSelected ? 'text-foreground' : 'text-muted-foreground/40')}
                  aria-hidden="true"
                />
              )}
              <span className="shrink-0 text-foreground">{option.label}</span>
              {option.description !== undefined && (
                <span className="truncate text-[13px] text-muted-foreground">{option.description}</span>
              )}
            </button>
          )
        })}
      </div>
      {/* 「其他」自由输入：面板自带（模型侧禁止自带 Other 选项）；输入内容
          覆盖选项选择（提交时优先取非空输入） */}
      <Input
        value={other}
        onChange={(event) => onOther(event.target.value)}
        placeholder="其他（自由输入）"
        className="mt-2 h-8 rounded-lg border-0 bg-background px-2.5 text-[13px] placeholder:text-muted-foreground focus-visible:ring-0"
      />
    </div>
  )
}

function PendingQuestionCard({ pending, autoFocus }: { pending: PendingQuestion; autoFocus: boolean }) {
  const respondQuestion = useChatStore((s) => s.respondQuestion)
  // 每问作答态：选项选择（单选 = 至多一枚；多选 = 数组）+ 自由输入
  const [selections, setSelections] = useState<string[][]>(pending.questions.map(() => []))
  const [others, setOthers] = useState<string[]>(pending.questions.map(() => ''))
  const cardRef = autoFocus ? { current: null as HTMLDivElement | null } : undefined

  const toggle = (index: number, label: string): void => {
    setSelections((prev) =>
      prev.map((sel, i) => {
        if (i !== index) return sel
        if (pending.questions[i].multiSelect === true) {
          return sel.includes(label) ? sel.filter((l) => l !== label) : [...sel, label]
        }
        // 单选：点击已选项 = 取消（改答其他问题的自由）
        return sel.includes(label) ? [] : [label]
      })
    )
  }

  const submit = (): void => {
    const answers = pending.questions.map((q, i) => {
      const other = others[i]?.trim() ?? ''
      if (other !== '') return other
      const sel = selections[i] ?? []
      // 单选取末位选中（覆盖式点击的最终态）；多选整组
      return q.multiSelect === true ? sel : (sel.at(-1) ?? '')
    })
    void respondQuestion(pending.requestId, answers)
  }

  return (
    <div ref={cardRef} className="rounded-2xl border border-border bg-background p-4">
      <div className="text-sm font-medium text-foreground">需要你的输入</div>
      <div className="mt-2 flex flex-col gap-2">
        {pending.questions.map((q, i) => (
          <QuestionCard
            key={q.question}
            question={q}
            selected={selections[i] ?? []}
            onSelect={(label) => toggle(i, label)}
            other={others[i] ?? ''}
            onOther={(text) => setOthers((prev) => prev.map((o, j) => (j === i ? text : o)))}
          />
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <IconInfoCircle className="size-3.5" />
          可留空跳过；「其他」输入优先于选项
        </span>
        <Button
          size="sm"
          className="h-8 rounded-lg bg-foreground px-4 text-background hover:bg-foreground/85 active:bg-foreground/70"
          onClick={submit}
        >
          提交回答
        </Button>
      </div>
    </div>
  )
}

/** 面板本体：与 ApprovalPanel 同位（输入区替换层内部按序叠放） */
export function QuestionPanel() {
  const pending = useChatStore(
    (s) => s.pendingQuestionsBySession[s.activeSessionId ?? ''] ?? undefined
  )
  if (pending === undefined || pending.length === 0) return null
  return (
    <div className="shrink-0 px-4 pb-4">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
        {pending.map((p, i) => (
          <PendingQuestionCard key={p.requestId} pending={p} autoFocus={i === 0} />
        ))}
      </div>
    </div>
  )
}
