/**
 * 提问面板（交互座 4c-2）—— ask_user 挂起时呈现问题并收作答。
 * 形态对齐 zcode AskUserQuestion（2026-11-16 用户验收定调）：单题向导式
 * 而非多问竖排 —— 头部 = header 胶囊 + 问题正文 + ‹n/m› 切换器；选项带
 * 数字序号；末行「其他」自由输入（有序号，输入优先于选项）；底部
 * 「忽略」（= 跳过当前题：清草稿推进，跳过不进 answers 契约，引擎按
 * 空串跳过处理）+「继续」/末题「提交」（整卡一次提交，answers 按问题序）。
 * 作答草稿跨切换保留（组件本地态）；已知边界：切会话往返组件重建即清空。
 * 收题模型（2026-11-16 定调：点击即确定，不强制二段确认）——**单选：点
 * 选项 / 键盘选中 = 落草稿并自动推进（末题即整卡提交）**，点已选中项 =
 * 取消留本题重选；多选：点击 = 勾选切换（点一下不能就走），「继续」钮
 * 或输入框外收题；「其他」：输入框内 Enter = 以输入收题推进（空文本无
 * 动作，走「忽略」或直接「继续」= 跳过）。
 * 键盘模型与 PlanPanel 同构（zcode GUI 同款提示「Tab / 上下键选择，回车
 * 或空格选中」）：↑↓/Tab 循环高亮（含「其他」行），Enter/空格与点击
 * 同语义；高亮在「其他」行 Enter = 聚焦输入框；输入框内 ↑↓ 交还列表。
 */
import { useEffect, useRef, useState } from 'react'
import { IconChevronLeft, IconChevronRight, IconCircleCheckFilled, IconInfoCircle } from '@tabler/icons-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useChatStore, type PendingQuestion } from '@/stores/chat'

/** 选项序号：右对齐等宽数字，选中/作答态变深（zcode 同款灰序号） */
function IndexMark({ index, active }: { index: number; active?: boolean }) {
  return (
    <span className={cn('w-5 shrink-0 text-right text-xs tabular-nums', active ? 'text-foreground' : 'text-muted-foreground')}>
      {index}.
    </span>
  )
}

function PendingQuestionCard({ pending, autoFocus }: { pending: PendingQuestion; autoFocus: boolean }) {
  const respondQuestion = useChatStore((s) => s.respondQuestion)
  const questions = pending.questions
  const [current, setCurrent] = useState(0)
  // 每问作答态：选项选择（单选 = 至多一枚；多选 = 数组）+ 自由输入
  const [selections, setSelections] = useState<string[][]>(questions.map(() => []))
  const [others, setOthers] = useState<string[]>(questions.map(() => ''))
  // 键盘高亮行（含「其他」行；-1 = 无）；hover 与键盘共用同一高亮（PlanPanel 同构）
  const [highlighted, setHighlighted] = useState(-1)
  // 面板出现即聚焦卡容器（PlanPanel 同规：替换了输入框，焦点不能漂移）
  const cardRef = useRef<HTMLDivElement | null>(null)
  const otherInputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (autoFocus) cardRef.current?.focus()
  }, [autoFocus])

  const question = questions[current]
  const isLast = current === questions.length - 1
  /** 单题视图只看当前题；末行「其他」与选项共用序号空间（zcode 同构） */
  const rowCount = question.options.length + 1
  const otherRow = question.options.length
  const otherText = others[current] ?? ''
  const selected = selections[current] ?? []

  const toggle = (label: string): void => {
    setSelections((prev) =>
      prev.map((sel, i) => {
        if (i !== current) return sel
        if (question.multiSelect === true) {
          return sel.includes(label) ? sel.filter((l) => l !== label) : [...sel, label]
        }
        // 单选：点击已选项 = 取消（改答的自由）
        return sel.includes(label) ? [] : [label]
      })
    )
  }

  /**
   * 收题推进：显式传入当前题答案（点击即确定路径下 state 未落，submit
   * 不能读旧 state）；无参 = 以现有草稿收题（「继续」钮 / 多选收题）。
   * 非末题翻页（answer 同步落草稿，翻回可见），末题整卡提交（当前题用
   * override、其余题读草稿 —— answers 按问题序，未答传空串 = 跳过）。
   */
  const advance = (answer?: string | string[]): void => {
    // 数组答案（单选点击）落 selections 草稿（翻回可见）；「其他」文本
    // 的 others 草稿 onChange 已落，无需再写
    if (answer !== undefined && typeof answer !== 'string') {
      setSelections((prev) => prev.map((sel, i) => (i === current ? answer : sel)))
    }
    if (!isLast) {
      setCurrent(current + 1)
      setHighlighted(-1)
      return
    }
    const answers = questions.map((q, i) => {
      if (i === current && answer !== undefined) return answer
      const other = others[i]?.trim() ?? ''
      if (other !== '') return other
      const sel = selections[i] ?? []
      // 单选取末位选中（覆盖式点击的最终态）；多选整组
      return q.multiSelect === true ? sel : (sel.at(-1) ?? '')
    })
    void respondQuestion(pending.requestId, answers)
  }

  /** 单选点击即确定：未选中 → 落草稿并收题推进；点已选中项 = 取消重选 */
  const chooseOption = (label: string): void => {
    if (question.multiSelect === true) {
      toggle(label)
      return
    }
    if (selected.includes(label)) {
      setSelections((prev) => prev.map((sel, i) => (i === current ? [] : sel)))
      return
    }
    setSelections((prev) => prev.map((sel, i) => (i === current ? [label] : sel)))
    advance(label)
  }

  /** 键盘模型（PlanPanel 同构 + 空格选中）：行空间含「其他」行（Enter 进输入） */
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey)) {
      event.preventDefault()
      setHighlighted((h) => (h + 1) % rowCount)
    } else if (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey)) {
      event.preventDefault()
      setHighlighted((h) => (h <= 0 ? rowCount - 1 : h - 1))
    } else if ((event.key === 'Enter' || event.key === ' ') && highlighted >= 0) {
      // 仅在有高亮行时拦截：「其他」输入框内敲空格会冒泡到卡体，
      // 无条件 preventDefault 会吞掉字符输入（输入框 onFocus 已清高亮）
      event.preventDefault()
      if (highlighted === otherRow) {
        otherInputRef.current?.focus()
      } else {
        chooseOption(question.options[highlighted].label)
      }
    }
  }

  /**
   * 忽略 = 跳过当前题：清该题草稿后收题（advance 无参）——非末题翻页、
   * 末题整卡提交（该题草稿已清 → 空串 = 引擎按跳过处理）。
   * 每题都可忽略，末题忽略后卡随整卡提交收掉（不留"点了没反应"态）。
   */
  const skip = (): void => {
    setSelections((prev) => prev.map((sel, i) => (i === current ? [] : sel)))
    setOthers((prev) => prev.map((o, i) => (i === current ? '' : o)))
    // 末题提交读 state 是 skip 前的旧快照（set 异步未落）——显式传空串
    // override 当前题，忽略才真生效；非末题路径 answer 不被消费
    advance('')
  }

  return (
    <div ref={cardRef} tabIndex={-1} onKeyDown={onKeyDown} className="rounded-2xl border border-border bg-background p-4 outline-none">
      {/* 头部：header 胶囊 + 问题正文；右侧问题切换器（单问题不渲染） */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2 text-sm font-medium text-foreground">
          {question.header !== undefined && question.header !== '' && (
            <span className="shrink-0 rounded-md border border-border px-1.5 py-px text-xs font-normal text-muted-foreground">
              {question.header}
            </span>
          )}
          <span className="truncate">{question.question}</span>
        </div>
        {questions.length > 1 && (
          <div className="flex shrink-0 items-center gap-0.5 text-xs tabular-nums text-muted-foreground">
            <button
              type="button"
              aria-label="上一问"
              disabled={current === 0}
              className="rounded-md p-1.5 transition-colors hover:bg-muted/75 disabled:text-muted-foreground/40 disabled:hover:bg-transparent"
              onClick={() => setCurrent(current - 1)}
            >
              <IconChevronLeft className="size-4" aria-hidden="true" />
            </button>
            <span>
              {current + 1}/{questions.length}
            </span>
            <button
              type="button"
              aria-label="下一问"
              disabled={isLast}
              className="rounded-md p-1.5 transition-colors hover:bg-muted/75 disabled:text-muted-foreground/40 disabled:hover:bg-transparent"
              onClick={() => setCurrent(current + 1)}
            >
              <IconChevronRight className="size-4" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
      <div className="mt-2 flex flex-col gap-1">
        {question.options.map((option, i) => {
          const isSelected = selected.includes(option.label)
          return (
            <button
              key={option.label}
              type="button"
              className={cn(
                'flex min-h-9 items-center gap-2 rounded-lg px-2.5 py-1 text-left text-sm transition-colors',
                isSelected ? 'bg-muted' : i === highlighted ? 'bg-muted/75' : 'hover:bg-muted/75'
              )}
              onClick={() => chooseOption(option.label)}
              onMouseEnter={() => setHighlighted(i)}
              onMouseLeave={() => setHighlighted(-1)}
            >
              <IndexMark index={i + 1} active={isSelected} />
              {question.multiSelect === true && (
                <IconCircleCheckFilled
                  className={cn('size-4 shrink-0', isSelected ? 'text-foreground' : 'text-muted-foreground/40')}
                  aria-hidden="true"
                />
              )}
              <span className="shrink-0 text-foreground">{option.label}</span>
              {option.description !== undefined && (
                <span className="truncate text-xs text-muted-foreground">{option.description}</span>
              )}
            </button>
          )
        })}
        {/* 「其他」自由输入：面板自带（模型侧禁止自带 Other 选项）；序号与
            选项同列；输入非空时覆盖选项选择（提交时优先取非空输入）。
            输入框内 ↑↓ 交还列表（PlanPanel 附言条同款：焦点拉回卡体不丢） */}
        <div
          className={cn(
            'flex min-h-9 items-center gap-2 rounded-lg px-2.5 py-1 transition-colors',
            otherRow === highlighted ? 'bg-muted/75' : 'hover:bg-muted/75'
          )}
          onMouseEnter={() => setHighlighted(otherRow)}
          onMouseLeave={() => setHighlighted(-1)}
        >
          <IndexMark index={rowCount} active={otherText.trim() !== ''} />
          <Input
            ref={otherInputRef}
            value={otherText}
            onChange={(event) => setOthers((prev) => prev.map((o, i) => (i === current ? event.target.value : o)))}
            onFocus={() => setHighlighted(-1)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                // 「其他」收题：非空输入 Enter = 以输入答案推进/提交；
                // 空文本无动作（跳过走「忽略」，或「继续」以空草稿收题）
                const text = otherText.trim()
                if (text !== '') {
                  event.preventDefault()
                  event.stopPropagation()
                  advance(text)
                }
              } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                event.stopPropagation()
                setHighlighted((h) =>
                  event.key === 'ArrowDown' ? (h + 1) % rowCount : h <= 0 ? rowCount - 1 : h - 1
                )
                cardRef.current?.focus()
              }
            }}
            placeholder="输入你的回答..."
            className="h-8 rounded-lg border-0 bg-transparent px-0 text-xs placeholder:text-muted-foreground focus-visible:ring-0"
          />
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <IconInfoCircle className="size-3.5" />
          使用 Tab / 上下键选择，回车或空格选中
        </span>
        <span className="flex items-center gap-2">
          <Button size="sm" variant="outline" className="h-8 rounded-lg px-3" onClick={skip}>
            忽略
          </Button>
          <Button
            size="sm"
            className="h-8 rounded-lg bg-foreground px-4 text-background hover:bg-foreground/85 active:bg-foreground/70"
            onClick={() => advance()}
          >
            {isLast ? '提交' : '继续'}
          </Button>
        </span>
      </div>
    </div>
  )
}

/** 面板本体：与 ApprovalPanel 同位（输入区替换层内部按序叠放） */
export function QuestionPanel() {
  const pending = useChatStore(
    (s) => s.bySession[s.activeSessionId ?? '']?.pendingQuestions ?? undefined
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
