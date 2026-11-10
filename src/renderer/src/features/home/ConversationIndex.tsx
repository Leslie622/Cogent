/**
 * 对话索引轨道（content-main 首页会话视图 → 对话流 MessageScroller 左侧的
 * 绝对定位刻度列）：架构位置 = ChatMessages 内的覆盖层；职责边界 = 轮级索引
 * 的呈现 + 激活轮判定（自读视口几何）+ 点击经 message-scroller 的
 * scrollToMessage 定位 —— 消息由 HomeChat 单向传入，本件不读 store、不持
 * 会话数据；激活态是纯视口派生量（不落 store）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from 'cn'
import { useMessageScroller } from '@/components/ui/message-scroller'
import type { MessageLike } from './HomeChat'

/**
 * 对话索引轨道（参考稿动画）：短横线刻度一列，宽度/颜色 transition ——
 * 索引粒度 = 一轮问答（一问一答一个刻度，锚在该轮提问消息上）：刻度语义是
 * "第几轮对话"而非"第几条消息"，回复不单独占刻度。① 静止态：当前轮的刻度
 * 伸长加深；② hover 阶梯（用户对标 ChatGPT）：悬停刻度最长、两侧按距离依次
 * 变短（24/17/14/10px），颜色同步减淡 —— 宽度差即"指针位置感"。items-start
 * 让加长向右伸，同参考稿。点击刻度经 message-scroller 的 scrollToMessage
 * 平滑居中定位（库的强项，直接用）。
 * 激活轮自算而不用库的 visibility/scrollable 快照：快照要等真实滚动才提交
 * （挂载默认吸底后是空），且 content-visibility 裁剪的占位高度会让 scrollable
 * 的"还能滚"判断在真到底时仍为真 —— 自算只有两条稳定规则：视口顶边压着的
 * 最后一条提问消息所在轮为当前；按真实 scrollHeight 口径已吸底时点亮末轮。
 */
export function ConversationIndex({ messages }: { messages: MessageLike[] }) {
  const { scrollToMessage } = useMessageScroller()
  // 刻度 = 每轮的提问（user 消息）；turnIds 供激活判定时从全部消息条目里筛提问。
  // turns 随 messages 每 delta 换引用（流式），但轮集合只在新增提问时真变 ——
  // turnIds 以 id 串（值相等）为 memo 键稳住 Set 引用，下方 effect 依赖
  // [turnIds] 才能做到"轮数变化才重跑"，而非每个 token 都重跑
  const turns = useMemo(() => messages.filter((m) => m.role === 'user'), [messages])
  const turnKey = turns.map((m) => m.id).join('\n')
  const turnIds = useMemo(() => new Set(turnKey.split('\n')), [turnKey])
  const [activeId, setActiveId] = useState<string | null>(null)
  // hover 的刻度序号：进刻度置值、轨道整体移出清空（刻度间移动不闪断）
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  // turns 只进 ref 不进 effect 依赖：流式期间依赖 turns/messages 会让滚动
  // 监听被每个 delta 反复拆装 + 刻度全量重测（getBoundingClientRect 风暴）；
  // effect 只在轮集合变化时重建，measure 经 ref 读最新 turns
  const turnsRef = useRef(turns)
  turnsRef.current = turns

  useEffect(() => {
    const vp = document.querySelector<HTMLElement>('[data-slot=message-scroller-viewport]')
    if (!vp) return
    const measure = () => {
      const latest = turnsRef.current
      const items = [
        ...vp.querySelectorAll<HTMLElement>('[data-slot=message-scroller-item]'),
      ]
      if (items.length === 0) return
      // 吸底特判：滚到底用户看的是结尾（scrollHeight 是真实口径，不受裁剪影响）
      if (vp.scrollTop + vp.clientHeight >= vp.scrollHeight - 8) {
        setActiveId(latest[latest.length - 1]?.id ?? null)
        return
      }
      // 常规：顶边压着的最后一条提问 = 当前轮（回复消息归属其前面的提问轮，
      // 不参与判定，只按顺序扫、命中提问才更新 —— 不能见非提问条目就 break）
      let current: string | null = latest[0]?.id ?? null
      const viewportTop = vp.getBoundingClientRect().top
      for (const item of items) {
        const id = item.dataset.messageId
        if (!id || !turnIds.has(id)) continue
        if (item.getBoundingClientRect().top <= viewportTop + 0.5) current = id
      }
      setActiveId(current)
    }
    measure() // 挂载即量一次（默认吸底态也有激活刻度）
    vp.addEventListener('scroll', measure, { passive: true })
    return () => vp.removeEventListener('scroll', measure)
  }, [turnIds])

  return (
    <div
      className="absolute top-1/2 left-3 flex -translate-y-1/2 flex-col items-start gap-[7px]"
      onMouseLeave={() => setHoverIndex(null)}
    >
      {turns.map((message, index) => {
        const active = message.id === activeId
        // 阶梯剖面：距悬停刻度 0/1/2/≥3 → 宽 24/17/14/10、色 70/50/40/25 透明度
        const dist = hoverIndex === null ? null : Math.abs(index - hoverIndex)
        const [width, shade] =
          dist === null
            ? active
              ? ['w-5', 'bg-foreground/70']
              : ['w-2.5', 'bg-foreground/25']
            : dist === 0
              ? ['w-6', 'bg-foreground/70']
              : dist === 1
                ? ['w-[17px]', 'bg-foreground/50']
                : dist === 2
                  ? ['w-3.5', 'bg-foreground/40']
                  : ['w-2.5', 'bg-foreground/25']
        return (
          <button
            key={message.id}
            type="button"
            title={message.content.slice(0, 20)}
            aria-label={`定位消息：${message.content.slice(0, 12)}`}
            onMouseEnter={() => setHoverIndex(index)}
            onClick={() => scrollToMessage(message.id, { align: 'center', behavior: 'smooth' })}
            className={cn('h-[3px] rounded-full transition-all duration-200', width, shade)}
          />
        )
      })}
    </div>
  )
}
