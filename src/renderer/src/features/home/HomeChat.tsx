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
import { useEffect, useMemo, useState } from 'react'
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

/**
 * 思考力度滑杆（对标参考稿：渐变轨道 + 白色圆滑块，7 档吸附，键盘 ←→ 可调）。
 * 嵌在菜单里：非 MenuItem，点击不会关闭菜单。
 * 只呈现当前模型实际支持的档位，避免把不可选的能力展示成噪音。
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
  const options =
    supportedLevels === undefined
      ? THINKING_OPTIONS
      : THINKING_OPTIONS.filter((option) => supportedLevels.includes(option.id))
  const selectedIndex = options.findIndex((option) => option.id === value)

  return (
    <div className="px-3 pb-3 pt-1">
      {/* 用项目的 shadcn Slider 封装；它内部完整保留 Base UI 的 Control，
          因此点击、拖拽和键盘操作都落在同一个可访问控件上。 */}
      <Slider
        value={[selectedIndex]}
        min={0}
        max={options.length - 1}
        step={1}
        marks={options.map((_, index) => index)}
        filledThrough={selectedIndex}
        thumbAriaLabel="思考力度"
        getThumbAriaValueText={() => options[selectedIndex].label}
        onValueChange={(next) => {
          onChange(options[next[0]].id)
        }}
        className={cn(
          'py-2',
          '[&_[data-slot=slider-track]]:h-5 [&_[data-slot=slider-track]]:bg-[#e5e7eb] [&_[data-slot=slider-track]]:shadow-[inset_0_1px_1px_rgb(15_23_42/0.06)]',
          '[&_[data-slot=slider-range]]:bg-[linear-gradient(90deg,#359bf4,#56adf6)]',
          '[&_[data-slot=slider-track]>span]:bg-[#aeb3ba] [&_[data-slot=slider-track]>span[data-active]]:bg-white/55',
          /* 拇指必须是轨道之上的不透明层；此前未显式设层级，端点的轨道色会
             从圆点下方透出来，视觉上像圆点没有盖住条。 */
          '[&_[data-slot=slider-thumb]]:z-10 [&_[data-slot=slider-thumb]]:size-6 [&_[data-slot=slider-thumb]]:border [&_[data-slot=slider-thumb]]:border-border [&_[data-slot=slider-thumb]]:bg-white',
          '[&_[data-slot=slider-thumb]]:shadow-[0_1px_4px_rgb(15_23_42/0.18)] [&_[data-slot=slider-thumb]]:hover:scale-105 [&_[data-slot=slider-thumb]]:active:scale-95',
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
      {/* 思考力度：会话级 thinkingLevel，渐变滑杆（对标参考稿） */}
      <DropdownMenuGroup>
        <DropdownMenuLabel className="flex items-center justify-between">
          思考力度
          <span className="text-xs font-normal text-muted-foreground">
            {THINKING_OPTIONS.find((option) => option.id === thinkingLevel)?.label}
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
