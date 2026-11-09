/**
 * 主要区（区域代号见 AGENTS.md）：会话三段式 flex-col ——
 *   ① 头部：会话标题（chat store 真数据）+ [更多 + 标签页区折叠开关]（折叠开关
 *      命令/状态由 HomeMain 经 props 下发，与 AppHeader 同一手法）
 *   ② 对话流：MessageScroller（@shadcn/react）—— 吸底/滚到底部悬浮钮现成；
 *      用户消息 = 灰气泡右挂（时间戳 + 复制/编辑），助手消息 = 平铺左对齐 +
 *      思考流（Reasoning，模型开了思考时先思考后正文）；
 *      消息源是 useChatStore（引擎事件流驱动，流式占位 id='streaming' 由 store 维护）。
 *      对话正文是"正文类内容"，按 AGENTS.md 方针 5 在内容容器上 select-text 放开选中
 *   ③ 输入框：shadcn AI 组件（components/ui/input-group）—— Enter 发送
 *      （Shift+Enter 换行；中文输入法组词中不误发，判 isComposing）、
 *      流式中发送钮变停止钮（agent.abort）、模型下拉只列"配好 key 且未被禁用"
 *      的模型（useableModels 过滤，配置入口 = 设置页模型设置）
 * 对话索引（左侧刻度轨道）与消息流联动；项目回显走 project store（真数据）。
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  IconArrowUp,
  IconCheck,
  IconChevronDown,
  IconCopy,
  IconDeviceDesktop,
  IconDots,
  IconLayoutSidebarRightCollapse,
  IconLayoutSidebarRightExpand,
  IconPencil,
  IconPlus,
  IconShieldExclamation,
  IconSquare,
} from '@tabler/icons-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { ProviderLogo } from '@/components/ProviderLogo'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Slider } from '@/components/ui/slider'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/components/ui/input-group'
import { Message, MessageContent, MessageFooter } from '@/components/ui/message'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Reasoning } from '@/components/ui/reasoning'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from '@/components/ui/message-scroller'
import { useHomeStore, type HomeSession } from '@/stores/home'
import { useChatStore } from '@/stores/chat'
import { useProjectStore } from '@/stores/project'
import { ProjectPicker } from './ProjectPicker'
import { providerDisplayName, usableModels, useEngineStore } from '@/stores/engine'
import type { ModelSummary, ThinkingLevel } from '@/env.d'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'

/** 白底行/钮 hover：黑 5% 软叠（全局配方，同 content-sidebar 行） */
const HOVER = 'hover:bg-accent-foreground/5 hover:text-foreground'

/** 消息时间戳：HH:MM（气泡下小字） */
function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** 消息的最小渲染形状（chat store 的 ChatMessage，props 单向传入） */
type MessageLike = {
  id: string
  role: 'user' | 'assistant'
  content: string
  thinking?: string
  timestamp: number
}

/** 头部：会话标题 + [更多 / 标签页区折叠开关]（标题来自 chat store 的活动会话） */
function ChatHeader({
  title,
  tabsCollapsed,
  onToggleTabs,
}: {
  title: string
  tabsCollapsed: boolean
  onToggleTabs: () => void
}) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 pr-2 pl-4">
      <span className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</span>
      <Button variant="ghost" size="icon-sm" className={cn(HOVER, 'text-muted-foreground')} aria-label="更多">
        <IconDots className="size-4" />
      </Button>
      {/* 标签页区折叠开关：系列图标两态，同 AppHeader 的 content-sidebar 开关 */}
      <Button
        variant="ghost"
        size="icon-sm"
        className={cn(HOVER, 'text-muted-foreground')}
        aria-label={tabsCollapsed ? '展开标签页区' : '折叠标签页区'}
        onClick={onToggleTabs}
      >
        {tabsCollapsed ? (
          <IconLayoutSidebarRightExpand className="size-[19px]" />
        ) : (
          <IconLayoutSidebarRightCollapse className="size-[19px]" />
        )}
      </Button>
    </header>
  )
}

/** 单条消息：用户 = 灰气泡右挂 + 时间戳/复制/编辑；助手 = 平铺纯文本 */
function MessageRow({ message }: { message: MessageLike }) {
  if (message.role === 'user') {
    return (
      <Message align="end">
        <MessageContent>
          <Bubble variant="muted" align="end">
            <BubbleContent>{message.content}</BubbleContent>
          </Bubble>
          <MessageFooter className="gap-1 px-0">
            <span className="text-[11px] text-muted-foreground">{formatTime(message.timestamp)}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-6 text-muted-foreground hover:bg-accent-foreground/5 hover:text-foreground"
              aria-label="复制"
              onClick={() => void navigator.clipboard.writeText(message.content)}
            >
              <IconCopy className="size-3.5" />
            </Button>
            {/* 编辑：重发用户消息属后续件（依赖消息级编辑协议），先占位 */}
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-6 text-muted-foreground hover:bg-accent-foreground/5 hover:text-foreground"
              aria-label="编辑"
            >
              <IconPencil className="size-3.5" />
            </Button>
          </MessageFooter>
        </MessageContent>
      </Message>
    )
  }
  return (
    <Message align="start">
      <MessageContent className="gap-1 px-0.5">
        {/* 思考流：流式占位且正文未开始 = 还在思考阶段（自动展开）；正文一来自动收起。
            交错思考（commentary）的精确信号属 content blocks 件，当前模型思考都先于正文 */}
        {message.thinking && (
          <Reasoning
            text={message.thinking}
            running={message.id === 'streaming' && message.content.length === 0}
          />
        )}
        <p className="text-sm leading-relaxed whitespace-pre-wrap text-foreground">{message.content}</p>
      </MessageContent>
    </Message>
  )
}

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
function ConversationIndex({ messages }: { messages: MessageLike[] }) {
  const { scrollToMessage } = useMessageScroller()
  // 刻度 = 每轮的提问（user 消息）；turnIds 供激活判定时从全部消息条目里筛提问
  const turns = useMemo(() => messages.filter((m) => m.role === 'user'), [messages])
  const turnIds = useMemo(() => new Set(turns.map((m) => m.id)), [turns])
  const [activeId, setActiveId] = useState<string | null>(null)
  // hover 的刻度序号：进刻度置值、轨道整体移出清空（刻度间移动不闪断）
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)

  useEffect(() => {
    const vp = document.querySelector<HTMLElement>('[data-slot=message-scroller-viewport]')
    if (!vp) return
    const measure = () => {
      const items = [
        ...vp.querySelectorAll<HTMLElement>('[data-slot=message-scroller-item]'),
      ]
      if (items.length === 0) return
      // 吸底特判：滚到底用户看的是结尾（scrollHeight 是真实口径，不受裁剪影响）
      if (vp.scrollTop + vp.clientHeight >= vp.scrollHeight - 8) {
        setActiveId(turns[turns.length - 1]?.id ?? null)
        return
      }
      // 常规：顶边压着的最后一条提问 = 当前轮（回复消息归属其前面的提问轮，
      // 不参与判定，只按顺序扫、命中提问才更新 —— 不能见非提问条目就 break）
      let current: string | null = turns[0]?.id ?? null
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
  }, [messages, turns, turnIds])

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

/** 无活动会话时的稳定空回退：选择器里写 `?? []` 字面量，zustand v5 严格相等下
    快照每次都是新数组 → useSyncExternalStore 强制重渲染死循环（挂载即白屏） */
const EMPTY_MESSAGES: MessageLike[] = []

/** 对话流：消息源 = chat store 活动会话（引擎事件流驱动，含流式占位）。
    截断/失败提示条挂在消息末尾（stopReason=length 是正常结束的附属信息，不是错误） */
function ChatMessages() {
  const messages = useChatStore(
    (s) => s.messagesBySession[s.activeSessionId ?? ''] ?? EMPTY_MESSAGES
  )
  const truncated = useChatStore((s) => s.truncated)
  const lastError = useChatStore((s) => s.lastError)

  return (
    <MessageScroller className="min-h-0 flex-1">
      <MessageScrollerViewport>
        {/* select-text：对话正文是正文类内容（AGENTS.md 方针 5 的首个放开点）。
            内边距给索引轨道留固定 gutter：pl-16 = 轨道(左 12px + 刻度最宽 24px)
            + 28px 呼吸间隙（此前 pl-11 只剩 8px，刻度紧贴文字，用户反馈太近）
            —— 面板窄时（列宽顶到 max-w-3xl）文字也不会贴轨道/边缘 */}
        <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-6 py-6 pr-6 pl-16 select-text">
          {messages.map((message) => (
            // 不标 scrollAnchor：官方语义是"回合起始行"专用（追加时钉到视口顶、
            // 上条留探头）——全标会让发送的消息被钉到顶且流式不跟随；要的是
            // ChatGPT 式吸底（配合外层 autoScroll），索引刻度定位用 scrollToMessage
            // 按 messageId 查表，不依赖锚点
            <MessageScrollerItem key={message.id} messageId={message.id}>
              <MessageRow message={message} />
            </MessageScrollerItem>
          ))}
          {truncated && (
            <div className="text-center text-xs text-warning">回复被输出长度上限截断</div>
          )}
          {lastError && <div className="text-center text-xs text-destructive">{lastError}</div>}
        </MessageScrollerContent>
      </MessageScrollerViewport>
      <ConversationIndex messages={messages} />
      {/* 非底部时浮现的"滚到底部"圆钮，message-scroller 现成 */}
      <MessageScrollerButton />
    </MessageScroller>
  )
}

/** 思考力度选项（off = 关闭，跟随引擎默认；其余透传给 agent.submit） */
const THINKING_OPTIONS: ReadonlyArray<{ id: 'off' | ThinkingLevel; label: string }> = [
  { id: 'off', label: '关闭' },
  { id: 'minimal', label: '最低' },
  { id: 'low', label: '低' },
  { id: 'medium', label: '中' },
  { id: 'high', label: '高' },
  { id: 'xhigh', label: '极高' },
  { id: 'max', label: '最大' },
]

/** 思考力度色彩坡道（低 → 高）：灰蓝(关) → 天蓝 → 主题蓝 → 靛 → 紫 → 品红。
 *  档位越高颜色越"热"、光晕越强 —— 力度感可视化的全部素材都从这条坡道取 */
const THINKING_RAMP: ReadonlyArray<readonly [number, number, number]> = [
  [148, 163, 184],
  [56, 189, 248],
  [53, 155, 244],
  [99, 102, 241],
  [168, 85, 247],
  [217, 70, 239],
]

/** 坡道取色：t∈[0,1] 在相邻锚点间线性插值，返回 rgb 三元组 */
function rampColor(t: number): readonly [number, number, number] {
  const scaled = t * (THINKING_RAMP.length - 1)
  const i = Math.min(THINKING_RAMP.length - 2, Math.floor(scaled))
  const f = scaled - i
  const [r1, g1, b1] = THINKING_RAMP[i]
  const [r2, g2, b2] = THINKING_RAMP[i + 1]
  return [
    Math.round(r1 + (r2 - r1) * f),
    Math.round(g1 + (g2 - g1) * f),
    Math.round(b1 + (b2 - b1) * f),
  ]
}

/** 血流粒子的一颗细胞。各参数独立随机（生成处），无任何属性绑定 ——
 *  层序（数组序=叠放序）、相位、纵深、粒径、亮度、tile 宽（=速度）之间
 *  不相关：亮细胞可能被暗细胞压住、小细胞可能比大细胞快 */
interface FlowCell {
  /** 水平 tile 宽（px）：粒子每循环平移一个 tile 宽 → tile 宽即该粒速度 */
  tile: number
  /** 细胞在 tile 内的横向相位（px，圆心） */
  phase: number
  /** 纵深位置（px，圆心；轨道高 20px） */
  y: number
  /** 顺流向拉长的椭圆半径（rx > ry） */
  rx: number
  ry: number
  /** 亮度（0.35–1，乘进细胞各色 stop 的透明度） */
  alpha: number
  /** 是否带白色核心（血球高光），随机对半 */
  core: boolean
}

/** 一颗细胞的背景层字符串：白核（可选）+ 档位色晕，色随 --think-to 走 */
function cellLayer(c: FlowCell): string {
  const halo = `color-mix(in srgb, var(--think-to) ${Math.round(c.alpha * 100)}%, transparent)`
  const head = `radial-gradient(${c.rx.toFixed(1)}px ${c.ry.toFixed(1)}px at ${c.phase.toFixed(1)}px ${c.y.toFixed(1)}px,`
  return c.core
    ? `${head} rgb(255 255 255 / ${c.alpha.toFixed(2)}) 42%, ${halo} 62%, transparent 72%)`
    : `${head} ${halo} 55%, transparent 75%)`
}

/** 随机生成一批细胞（7~9 颗）。菜单每次打开 ThinkingSlider 重新挂载 →
 *  每次打开都是新的一批 */
function randomCells(): FlowCell[] {
  return Array.from({ length: 7 + Math.floor(Math.random() * 3) }, () => {
    const rx = 2 + Math.random() * 2.6
    const tile = 24 + Math.random() * 44
    return {
      tile,
      phase: rx + Math.random() * Math.max(1, tile - 2 * rx),
      y: 4.5 + Math.random() * 11,
      rx,
      ry: rx * (0.65 + Math.random() * 0.2),
      alpha: 0.35 + Math.random() * 0.65,
      core: Math.random() < 0.5,
    }
  })
}

/** 思考力度的视觉呈现：按档位在可用档中的相对位置（而非绝对档名）取坡道色 ——
 *  模型只支持部分档位时，可用档仍铺满整条坡道，"力度递进"不失真。
 *  滑杆（渐变端点/光晕 CSS 变量）与标签文字色共用，保证两处一致。 */
function thinkingVisuals(
  value: 'off' | ThinkingLevel,
  supportedLevels?: ReadonlyArray<'off' | ThinkingLevel>
) {
  const options =
    supportedLevels === undefined
      ? THINKING_OPTIONS
      : THINKING_OPTIONS.filter((option) => supportedLevels.includes(option.id))
  const index = Math.max(0, options.findIndex((option) => option.id === value))
  // 单档滑杆无从谈"进度"，取坡道起点（最冷静的灰蓝）
  const t = options.length > 1 ? index / (options.length - 1) : 0
  const from = rampColor(t * 0.55)
  const to = rampColor(t)
  return {
    options,
    index,
    t,
    label: THINKING_OPTIONS.find((option) => option.id === value)?.label,
    text: `rgb(${to.join(' ')})`,
    /* 注入滑杆根元素的 CSS 变量：--think-from/to 已在 globals.css 注册为
       可插值颜色（配合 transition 平滑变色）；--think-r/g/b 通道 + 透明度
       组出拇指光晕色（think-pulse 关键帧逐帧驱动 --think-glow-alpha 呼吸）；
       --think-pulse-anim 整段下发 animation 简写（off 档 none 关停）。
       血流粒子不走路里 —— 由下方 effect 用 JS 随机生成 + WAAPI 驱动 */
    vars: {
      '--think-from': `rgb(${from.join(' ')})`,
      '--think-to': `rgb(${to.join(' ')})`,
      '--think-r': to[0],
      '--think-g': to[1],
      '--think-b': to[2],
      '--think-glow-alpha': (0.15 + 0.35 * t).toFixed(3),
      '--think-glow-min': (0.15 + 0.35 * t).toFixed(3),
      '--think-glow-max': Math.min(0.95, 0.55 + 0.4 * t).toFixed(3),
      '--think-glow-blur': `${8 + 12 * t}px`,
      '--think-pulse-anim':
        t === 0 ? 'none' : `think-pulse ${(2.6 - 1.2 * t).toFixed(2)}s ease-in-out infinite`,
    } as CSSProperties,
  }
}

/**
 * 思考力度滑杆（对标参考稿：渐变轨道 + 白色圆滑块，7 档吸附，键盘 ←→ 可调）。
 * 嵌在菜单里：非 MenuItem，点击不会关闭菜单。
 * 只呈现当前模型实际支持的档位，避免把不可选的能力展示成噪音。
 * 档位升高时填充条内的"血流粒子"（JS 挂载时随机生成、WAAPI 流动，每次
 * 打开菜单换一批、全参数独立随机）流速加快、拇指光晕呼吸增强、轨道底色
 * 染上档位色；off 档粒子隐去、动效全关。
 */
function ThinkingSlider({
  value,
  supportedLevels,
  onChange,
}: {
  value: 'off' | ThinkingLevel
  /** 当前模型支持的档（含 off）；缺省 = 全档可用（无模型/旧数据兼容） */
  supportedLevels?: ReadonlyArray<'off' | ThinkingLevel>
  onChange: (level: 'off' | ThinkingLevel) => void
}) {
  const { options, index, t, vars } = thinkingVisuals(value, supportedLevels)
  const wrapRef = useRef<HTMLDivElement>(null)
  const animRef = useRef<Animation | null>(null)

  /* 血流粒子：挂载时随机一批（依赖 []，拖档中途不重抽），粒子层 + 血管
     底色以内联 background-* 叠到填充条上（覆写 .think-cells 类的纯血管），
     WAAPI 从 0 平移到各自 tile 宽 —— 每颗一个速度，无缝循环。off 档不铺
     粒子（回落到类的纯血管渐变）。WAAPI 不受 CSS animation 属性控制，
     motion-reduce 在此自查：只铺粒子不流动 */
  const cells = useMemo(randomCells, [])
  const enabled = t > 0
  useEffect(() => {
    const range = wrapRef.current?.querySelector<HTMLElement>('[data-slot="slider-range"]')
    if (!range || !enabled) return
    const vessel = 'linear-gradient(90deg, var(--think-from), var(--think-to))'
    range.style.backgroundImage = `${cells.map(cellLayer).join(',')},${vessel}`
    range.style.backgroundSize = `${cells.map((c) => `${c.tile.toFixed(1)}px 100%`).join(',')},100% 100%`
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const anim = range.animate(
      [
        { backgroundPosition: `${cells.map(() => '0 0').join(',')},0 0` },
        { backgroundPosition: `${cells.map((c) => `${c.tile.toFixed(1)}px 0`).join(',')},0 0` },
      ],
      { duration: 2000, iterations: Infinity, easing: 'linear' }
    )
    animRef.current = anim
    return () => {
      animRef.current = null
      anim.cancel()
      range.style.backgroundImage = ''
      range.style.backgroundSize = ''
    }
  }, [enabled, cells])

  /* 调速只动 playbackRate（基准 2s/周期，1.1x → 3.3x ≈ 1.8s → 0.6s）：
     不重建动画，拖档时粒子相位连续、不归零跳变 */
  useEffect(() => {
    if (animRef.current) animRef.current.playbackRate = 1.1 + 2.2 * t
  }, [t])

  return (
    <div ref={wrapRef} className="px-3 pb-3 pt-1">
      {/* 用项目的 shadcn Slider 封装；它内部完整保留 Base UI 的 Control，
          因此点击、拖拽和键盘操作都落在同一个可访问控件上。 */}
      <Slider
        value={[index]}
        min={0}
        max={options.length - 1}
        step={1}
        marks={options.map((_, i) => i)}
        filledThrough={index}
        thumbAriaLabel="思考力度"
        getThumbAriaValueText={() => options[index].label}
        onValueChange={(next) => {
          onChange(options[next[0]].id)
        }}
        style={vars}
        fillClassName="think-cells"
        className={cn(
          'py-2',
          /* 档位色平滑过渡：--think-from/to 已注册为颜色（globals.css），
             渐变才能逐帧插值而非跳色 */
          '[transition-property:--think-from,--think-to] duration-200',
          /* 光晕呼吸：关键帧在根元素上驱动 --think-glow-alpha（alpha 继承到
             拇指的 box-shadow），off 档变量为 none 即静止 */
          '[animation:var(--think-pulse-anim)] motion-reduce:[animation:none]',
          /* 轨道底色混入档位色（未填充段也随力度微微"升温"） */
          '[&_[data-slot=slider-track]]:h-5 [&_[data-slot=slider-track]]:bg-[color-mix(in_srgb,var(--think-to)_14%,#e5e7eb)] [&_[data-slot=slider-track]]:transition-colors [&_[data-slot=slider-track]]:duration-200 [&_[data-slot=slider-track]]:shadow-[inset_0_1px_1px_rgb(15_23_42/0.06)]',
          /* 填充条宽度过渡：随拇指滑过去（离散跳档不杀过渡，理由同拇指）；
             粒子层与流动动画在上方 effect 里以内联样式 + WAAPI 挂载 */
          '[&_[data-slot=slider-range]]:transition-[width] [&_[data-slot=slider-range]]:duration-150',
          /* 定位点：激活/熄灭带 300ms 颜色+缩放过渡 —— 拖动时点亮沿档位
             逐个泛起（涟漪般尾随拇指），替代硬切换。注意 Tailwind v4 的
             scale-* 走独立 scale 属性（不是 transform），过渡清单必须点名
             scale；基态显式 scale-100（两端都有具体值，1 → 1.25 插值最稳） */
          '[&_[data-slot=slider-track]>span]:scale-100 [&_[data-slot=slider-track]>span]:bg-[#aeb3ba] [&_[data-slot=slider-track]>span]:transition-[background-color,scale] [&_[data-slot=slider-track]>span]:duration-300 [&_[data-slot=slider-track]>span]:ease-out [&_[data-slot=slider-track]>span[data-active]]:scale-125 [&_[data-slot=slider-track]>span[data-active]]:bg-white/55',
          /* 拇指必须是轨道之上的不透明层；此前未显式设层级，端点的轨道色会
             从圆点下方透出来，视觉上像圆点没有盖住条。光晕色由通道变量 +
             呼吸中的 --think-glow-alpha 现场组出（think-pulse 驱动）。 */
          '[&_[data-slot=slider-thumb]]:z-10 [&_[data-slot=slider-thumb]]:size-6 [&_[data-slot=slider-thumb]]:border [&_[data-slot=slider-thumb]]:border-border [&_[data-slot=slider-thumb]]:bg-white',
          '[&_[data-slot=slider-thumb]]:shadow-[0_1px_4px_rgb(15_23_42/0.18),0_0_var(--think-glow-blur)_rgb(var(--think-r)_var(--think-g)_var(--think-b)/var(--think-glow-alpha))] [&_[data-slot=slider-thumb]]:hover:scale-105 [&_[data-slot=slider-thumb]]:active:scale-95',
          '[&_[data-slot=slider-thumb]]:focus-visible:ring-2 [&_[data-slot=slider-thumb]]:focus-visible:ring-[#3498f4] [&_[data-slot=slider-thumb]]:focus-visible:ring-offset-2'
        )}
      />
    </div>
  )
}

/** 模型菜单（对标参考稿三段联动）：厂商子列表（只列有可用模型的 = 配了 key 且
 * 未禁用，点击切换下方模型段，活动模型所在厂商打勾）→ 模型段（所选厂商的清单，
 * 点击提交为活动模型）→ 思考力度（会话级 thinkingLevel，随 agent.submit 下发）
 * → 管理模型（设置页模型分区）。数据源全部是 engine store，与设置页联动。
 * 所选厂商状态放在面板组件里：base-ui 关闭即卸载内容，每次打开重置 */
function ModelMenu() {
  const models = useEngineStore((s) => s.models)
  const keyConfigured = useEngineStore((s) => s.keyConfigured)
  const customProviders = useEngineStore((s) => s.customProviders)
  const activeModelId = useEngineStore((s) => s.activeModelId)
  const setActiveModel = useEngineStore((s) => s.setActiveModel)

  const usable = useMemo(() => usableModels(models, keyConfigured), [models, keyConfigured])
  const active = usable.find((m) => m.id === activeModelId)

  // 回落：submit 下发的模型必须在可用集里，否则引擎侧按未知/无 key 报错
  useEffect(() => {
    if (usable.length > 0 && !usable.some((m) => m.id === activeModelId)) {
      setActiveModel(usable[0].id)
    }
  }, [usable, activeModelId, setActiveModel])

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="gap-1.5 px-2 text-[13px] text-muted-foreground has-[>svg]:px-2 hover:bg-accent-foreground/5 hover:text-foreground"
            aria-label="选择模型"
          />
        }
      >
        {/* 对标参考稿：触发钮 = 品牌标 + 当前模型名 + 箭头 */}
        {active ? (
          <>
            <ProviderLogo providerId={active.provider} name={providerDisplayName(active.provider, customProviders)} size={16} />
            {active.name}
          </>
        ) : usable.length > 0 ? (
          '选择模型'
        ) : (
          '配置模型'
        )}
        <IconChevronDown className="size-3" />
      </DropdownMenuTrigger>
      {/* w-auto 覆写原语的 w-(--anchor-width)（锚点是小圆钮，菜单会被压窄裁行） */}
      <DropdownMenuContent align="end" className="w-auto min-w-52 max-w-80">
        <ModelMenuPanel />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** 菜单面板（厂商子列表钻入 / 思考力度滑杆），随菜单关闭卸载 → 所选厂商每次
    打开重置为活动模型所在厂商 */
function ModelMenuPanel() {
  const models = useEngineStore((s) => s.models)
  const keyConfigured = useEngineStore((s) => s.keyConfigured)
  const customProviders = useEngineStore((s) => s.customProviders)
  const activeModelId = useEngineStore((s) => s.activeModelId)
  const setActiveModel = useEngineStore((s) => s.setActiveModel)
  const thinkingLevel = useEngineStore((s) => s.thinkingLevel)
  const setThinkingLevel = useEngineStore((s) => s.setThinkingLevel)
  const setView = useUiStore((s) => s.setView)
  const setSection = useSettingsStore((s) => s.setSection)

  const groups = useMemo(() => {
    const map = new Map<string, ModelSummary[]>()
    for (const model of usableModels(models, keyConfigured)) {
      const list = map.get(model.provider)
      if (list) list.push(model)
      else map.set(model.provider, [model])
    }
    return [...map.entries()]
  }, [models, keyConfigured])

  const active = groups.flatMap(([, list]) => list).find((m) => m.id === activeModelId)
  const activeProviderId = active?.provider ?? groups.at(0)?.[0] ?? null
  const activeProviderEntry = groups.find(([p]) => p === activeProviderId)
  const activeProviderName = activeProviderEntry
    ? providerDisplayName(activeProviderEntry[0], customProviders)
    : '配置模型'

  return (
    <>
      {/* 厂商行：钻入厂商子列表（配了 key 的厂商 + 管理模型）。点选厂商 = 活动模型
          切到该厂商的第一个模型，模型列表随之更新 */}
      <DropdownMenuSub>
        <DropdownMenuSubTrigger className="gap-2">
          {activeProviderEntry && (
            <ProviderLogo providerId={activeProviderEntry[0]} name={activeProviderName} size={16} />
          )}
          <span className="min-w-0 flex-1 truncate">{activeProviderName}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {groups.map(([providerId, list]) => (
            <DropdownMenuItem key={providerId} onClick={() => setActiveModel(list[0].id)}>
              <ProviderLogo providerId={providerId} name={providerDisplayName(providerId, customProviders)} size={16} />
              <span className="min-w-0 flex-1 truncate">{providerDisplayName(providerId, customProviders)}</span>
              {activeProviderId === providerId && <IconCheck className="ml-auto size-3.5" />}
            </DropdownMenuItem>
          ))}
          {groups.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuItem
            onClick={() => {
              setView('settings')
              setSection('models')
            }}
          >
            管理模型
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
      {/* 模型行：钻入选当前厂商的模型（厂商先行，模型列表跟着厂商走） */}
      <DropdownMenuSub>
        <DropdownMenuSubTrigger className="gap-2">
          <span className="min-w-0 flex-1 truncate">
            {active?.name ?? (groups.length > 0 ? '选择模型' : '配置模型')}
          </span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {(activeProviderEntry?.[1] ?? []).map((model) => (
            <DropdownMenuItem key={model.id} onClick={() => setActiveModel(model.id)}>
              <span className="min-w-0 flex-1 truncate">{model.name}</span>
              {model.id === activeModelId && <IconCheck className="ml-auto size-3.5" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
      {/* 思考力度：会话级 thinkingLevel，渐变滑杆（对标参考稿）。
          标签值文字色与滑杆填充同取坡道色（实色，无透明度文字） */}
      <DropdownMenuGroup>
        <DropdownMenuLabel className="flex items-center justify-between">
          思考力度
          <span
            className="text-xs font-normal transition-colors duration-200"
            style={{ color: thinkingVisuals(thinkingLevel, active?.thinkingLevels).text }}
          >
            {thinkingVisuals(thinkingLevel, active?.thinkingLevels).label}
          </span>
        </DropdownMenuLabel>
        {/* supportedLevels 依当前活动模型（pi 目录判定的真实可用档）；
            无模型信息时不传 → 滑杆走全档兼容口径 */}
        <ThinkingSlider
          value={thinkingLevel}
          supportedLevels={active?.thinkingLevels}
          onChange={(level) => setThinkingLevel(level)}
        />
      </DropdownMenuGroup>
    </>
  )
}

/**
 * 底部输入区：输入卡上方灰条（项目会话信息区，新聊天限定）+
 * 输入卡（24px 圆角白卡 + 极浅 1px 边，聚焦无反馈）：Enter 发送（isComposing
 * 挡输入法误发）、流式中发送钮变停止钮（agent.abort）、底部工具行 = 裸 +
 * 附件 / 完全访问 / 模型下拉（ModelMenu）/ 发送。
 */
function ChatComposer({ session }: { session: HomeSession }) {
  const [value, setValue] = useState('')
  const running = useChatStore((s) => s.running)
  const submit = useChatStore((s) => s.submit)
  const abort = useChatStore((s) => s.abort)
  const activeModelId = useEngineStore((s) => s.activeModelId)
  const thinkingLevel = useEngineStore((s) => s.thinkingLevel)
  const projects = useProjectStore((s) => s.projects)
  const sessions = useChatStore((s) => s.sessions)
  const { scrollToEnd } = useMessageScroller()

  // 信息区回显：发起时带 projectId → 项目卡（project store）；已有会话按
  // projectId 反查项目。目录胶囊 = 主根（cwds[0]）basename，悬停 title 看全路径；
  // 多根项目其余目录收在工作区面板（后续件），信息区只露主根不挤占。git 分支
  // 胶囊暂缺——分支属会话级动态信息（引擎协议无通道），工作区面板 后续件补
  const projectId =
    session.kind === 'new'
      ? session.projectId
      : sessions.find((s) => s.id === session.chatId)?.projectId
  const project = projectId ? projects.find((p) => p.id === projectId) : undefined
  const primaryCwd =
    project?.cwds[0] ??
    (session.kind === 'chat' ? sessions.find((s) => s.id === session.chatId)?.cwd : undefined)
  const cwdBasename =
    primaryCwd !== undefined ? (primaryCwd.split(/[\\/]/).filter(Boolean).at(-1) ?? primaryCwd) : undefined

  const send = () => {
    const text = value.trim()
    if (!text || running) return
    setValue('')
    void submit(text, activeModelId, thinkingLevel)
    // 发首条消息即脱离"新聊天进行中"视图态（信息区消失，对齐 ChatGPT：
    // 提交后进入正常对话态）；此时 chat store 的 activeSessionId 已是接收
    // 消息的会话（startNew 建好的或复用的空会话），kind:'chat' 指向它
    const activeId = useChatStore.getState().activeSessionId
    if (activeId !== null) {
      useHomeStore.setState({ session: { kind: 'chat', chatId: activeId } })
    }
    // 发送即回到底部并恢复跟随（对齐主流产品）：翻历史/索引跳转过也吸底；
    // 消息追加后库的 handleContentChange 在 following-bottom 态继续吸底
    scrollToEnd()
  }

  return (
    <div className="shrink-0 px-4 pb-4">
      <div className="mx-auto w-full max-w-3xl">
        {/* 灰舌头（项目会话信息区）：见函数头注释 —— 新聊天限定。
            项目归属 = 只显项目卡（名称 + 悬停见全部根路径）——项目必含目录，
            再出目录卡是重复信息（用户实测：项目叫 Cogent、目录 basename 也叫
            Cogent 时出现两个"Cogent"）；目录卡只在"无项目但会话直接绑了
            目录"时兜底显示 */}
        {session.kind === 'new' && (
          <div className="mx-5 flex h-9 items-center gap-6 rounded-t-xl bg-muted px-4">
            {project || projectId === undefined ? (
              /* ProjectPicker 同时负责项目清单和会话物化。不能在这里仅改视图态，
                  因为 projectId 只能在 session.create 时绑定，否则首条消息会串归属。 */
              <ProjectPicker
                projectId={projectId}
                onProjectId={(nextProjectId) => {
                  useHomeStore.setState({ session: { kind: 'new', projectId: nextProjectId } })
                }}
              />
            ) : primaryCwd ? (
              <Button
                variant="ghost"
                size="xs"
                className="gap-1.5 px-1 font-normal text-[13px] text-foreground hover:bg-accent-foreground/5"
                title={primaryCwd}
              >
                <IconDeviceDesktop className="size-4 text-muted-foreground" />
                {cwdBasename}
              </Button>
            ) : null}
          </div>
        )}

        {/* has-* 反制两条：①组件给带 textarea 的组默认 rounded-2xl，压回
            rounded-3xl；②聚焦态 border-ring + ring-3 光晕，参考稿聚焦无变化
            —— 都同变体覆写（tailwind-merge 按变体组去重） */}
        <InputGroup className="rounded-3xl border-foreground/10 bg-background has-[>textarea]:rounded-3xl has-[[data-slot=input-group-control]:focus-visible]:border-foreground/10 has-[[data-slot=input-group-control]:focus-visible]:ring-0">
          <InputGroupTextarea
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              // Enter 发送 / Shift+Enter 换行；中文输入法组词期间不误发
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                send()
              }
            }}
            placeholder="随心输入"
            className="max-h-52 px-4 pt-5 pb-2 placeholder:text-placeholder"
          />
          <InputGroupAddon align="block-end" className="gap-2 p-2">
            {/* + 号：icon-xs 的 size-6 定宽改成 h-6 w-auto + px-2（与右侧文字钮
                同为 8px 水平内距，行内对齐） */}
            <InputGroupButton
              size="icon-xs"
              className="h-6 w-auto rounded-xl px-2 text-muted-foreground has-[>svg]:px-2 hover:bg-accent-foreground/5 hover:text-foreground"
              aria-label="添加附件"
            >
              <IconPlus className="size-4" />
            </InputGroupButton>
            {/* 权限提示（空位）：安全警示盾牌 + warning 琥珀；样式与右侧模型
                选择器同款 ghost（无常驻胶囊底，hover 走全局黑 5% 软叠、
                Button 默认 rounded-md 圆角），点击应出权限面板属后续件 */}
            <Button
              variant="ghost"
              size="xs"
              className="ml-2 gap-1.5 px-2 text-[13px] text-warning has-[>svg]:px-2 hover:bg-accent-foreground/5 hover:text-warning"
              aria-label="权限设置"
            >
              <IconShieldExclamation className="size-3.5" />
              完全访问
            </Button>
            <div className="ml-auto flex items-center gap-3">
              <ModelMenu />
              {/* 发送/停止双态：流式中变方块停止钮（abort 后 store 由 run.* 事件复位）。
                  发送 28px 石墨灰圆 + 白箭头（视觉 diff 定稿：低饱和石墨灰、比
                  36px 小一档），空输入置灰 */}
              {running ? (
                <Button
                  size="icon-sm"
                  className="size-7 rounded-full bg-foreground/85 hover:bg-foreground"
                  aria-label="停止"
                  onClick={() => void abort()}
                >
                  <IconSquare className="size-3 fill-current" />
                </Button>
              ) : (
                <Button
                  size="icon-sm"
                  className="size-7 rounded-full bg-foreground/85 hover:bg-foreground"
                  aria-label="发送"
                  disabled={!value.trim()}
                  onClick={send}
                >
                  <IconArrowUp className="size-3.5" />
                </Button>
              )}
            </div>
          </InputGroupAddon>
        </InputGroup>
      </div>
    </div>
  )
}

export function HomeChat({
  tabsCollapsed,
  onToggleTabs,
}: {
  tabsCollapsed: boolean
  onToggleTabs: () => void
}) {
  const session = useHomeStore((s) => s.session)
  const title = useChatStore(
    (s) => s.sessions.find((x) => x.id === s.activeSessionId)?.title ?? '新聊天'
  )
  return (
    <div className="flex h-full min-w-0 flex-col">
      <ChatHeader title={title} tabsCollapsed={tabsCollapsed} onToggleTabs={onToggleTabs} />
      {/* autoScroll = 吸底跟随流式输出（库的官方开关，默认关）：在底部时回复增长
          即跟随，滚走自动释放（不拽人），滚回底部或点悬浮钮恢复跟随。
          Provider 包到 Composer 外层：发送是"回到底部"的用户意图（主流产品语义），
          Composer 发送时调 scrollToEnd 恢复跟随，翻历史/锚点定位后发送照样吸底 */}
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <ChatMessages />
        <ChatComposer session={session} />
      </MessageScrollerProvider>
    </div>
  )
}
