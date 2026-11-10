/**
 * 主要区（区域代号见 AGENTS.md）会话本体：三段式 flex-col ——
 *   ① 头部：会话标题（chat store 真数据）+ [更多 + 标签页区折叠开关]（折叠开关
 *      命令/状态由 HomeMain 经 props 下发，与 AppHeader 同一手法）
 *   ② 对话流：MessageScroller（@shadcn/react）—— 吸底/滚到底部悬浮钮现成；
 *      用户消息 = 灰气泡右挂（时间戳 + 复制/编辑），助手消息 = 平铺左对齐 +
 *      思考流（Reasoning，模型开了思考时先思考后正文）；
 *      消息源是 useChatStore（引擎事件流驱动，流式占位 id='streaming' 由 store 维护）。
 *      对话正文是"正文类内容"，按 AGENTS.md 方针 5 在内容容器上 select-text 放开选中
 *   ③ 输入框：shadcn AI 组件（components/ui/input-group）—— Enter 发送
 *      （Shift+Enter 换行；中文输入法组词中不误发，判 isComposing）、
 *      流式中发送钮变停止钮（agent.abort）
 * 输入卡工具行的三个自成一域单元已拆至同目录单文件：对话索引轨道
 * （ConversationIndex，消息流左侧刻度列）、模型下拉（ModelMenu，内嵌思考力度
 * 滑杆 ThinkingSlider）、上下文指示器（ContextIndicator，导出 formatTokens 供
 * 本文件 UsageLine 复用）；MessageLike 是这组会话视图件共享的消息渲染形状，
 * 定义在本文件、经 props 单向下发。项目回显走 project store（真数据）。
 */
import { memo, useState } from 'react'
import {
  IconArrowUp,
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
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/components/ui/input-group'
import { Message, MessageContent, MessageFooter } from '@/components/ui/message'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Markdown } from '@/components/ui/markdown'
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
import { selectLastError, selectRunning, selectTruncated, useChatStore } from '@/stores/chat'
import { useProjectStore } from '@/stores/project'
import { ProjectPicker } from './ProjectPicker'
import { findActiveModel, useEngineStore } from '@/stores/engine'
import type { MessageUsage } from '@/env.d'
import { ConversationIndex } from './ConversationIndex'
import { ModelMenu } from './ModelMenu'
import { ContextIndicator, formatTokens } from './ContextIndicator'

/** 白底行/钮 hover：黑 5% 软叠（全局配方，同 content-sidebar 行） */
const HOVER = 'hover:bg-accent-foreground/5 hover:text-foreground'

/** 消息时间戳：HH:MM（气泡下小字） */
function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** 模型耗时：不足 1s 以 ms 计，s 取一位小数去尾零（2400 → 2.4s） */
function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${parseFloat((ms / 1000).toFixed(1))}s`
}

/**
 * 成本 USD：四位小数去尾零（0.0031 → $0.0031）；不足 $0.0001 标下限而非抹成 $0。
 * 目录估价加 ≈ 前缀（端点不报账单，单价是汇率/分时快照，如 DeepSeek 分时半价未建模）；
 * 下限分支不加 —— "<" 本身已传达"不精确"，再叠 ≈ 是双重标记。
 */
function formatCost(usd: number, estimated?: boolean): string {
  if (usd < 0.0001) return '<$0.0001'
  return `${estimated ? '≈' : ''}$${parseFloat(usd.toFixed(4))}`
}

/** 消息的最小渲染形状（chat store 的 ChatMessage，props 单向传入；会话视图
    各件 —— ConversationIndex 等 —— 共享，故导出） */
export type MessageLike = {
  id: string
  role: 'user' | 'assistant'
  content: string
  thinking?: string
  usage?: MessageUsage
  durationMs?: number
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

/**
 * assistant 消息元信息行（shadcn message 的 footer 位）：输入/输出 token +
 * 缓存读/写 + 成本 + 模型耗时。数据无则整行不渲染 —— 流式占位没有 usage，
 * 统计行随 run.completed 在回答完成时出现。零值省略：无缓存命中的回答不显示
 * 缓存项、无定价模型不显示成本（"没发生"与"值为 0"在此同义，常显一排 0 是噪音）。
 */
function UsageLine({ usage, durationMs }: { usage?: MessageUsage; durationMs?: number }) {
  const parts: string[] = []
  if (usage) {
    parts.push(`↑ ${formatTokens(usage.input)}`, `↓ ${formatTokens(usage.output)}`)
    if (usage.cacheRead > 0) parts.push(`缓存读 ${formatTokens(usage.cacheRead)}`)
    if (usage.cacheWrite > 0) parts.push(`缓存写 ${formatTokens(usage.cacheWrite)}`)
    const cost = usage.totalCost
    if (cost !== undefined && cost > 0) parts.push(formatCost(cost, !usage.totalCostFromProvider))
  }
  if (durationMs !== undefined) parts.push(formatDuration(durationMs))
  if (parts.length === 0) return null
  return <div className="text-[11px] text-muted-foreground tabular-nums">{parts.join(' · ')}</div>
}

/** 单条消息：用户 = 灰气泡右挂 + 时间戳/复制/编辑（纯文本，主流一致）；助手 =
 *  平铺 Markdown 正文（Streamdown）+ 用量统计行。memo：chat store 每 delta 全量
 *  setState 换数组，但历史消息对象引用稳定 —— memo 后逐 token 的重解析只落在
 *  流式占位这一条上（那条由 Streamdown 块级 memo 兜底），历史消息零重渲染 */
const MessageRow = memo(function MessageRow({ message }: { message: MessageLike }) {
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
        {/* 正文 Markdown 渲染（路线空位 4 前半）：流式占位消息传 streaming，
            未闭合的代码围栏在流式中即按代码块渲染（remend 修复） */}
        <Markdown content={message.content} streaming={message.id === 'streaming'} />
        <UsageLine usage={message.usage} durationMs={message.durationMs} />
      </MessageContent>
    </Message>
  )
})

/** 无活动会话时的稳定空回退：选择器里写 `?? []` 字面量，zustand v5 严格相等下
    快照每次都是新数组 → useSyncExternalStore 强制重渲染死循环（挂载即白屏） */
const EMPTY_MESSAGES: MessageLike[] = []

/** 对话流：消息源 = chat store 活动会话（引擎事件流驱动，含流式占位）。
    截断/失败提示条挂在消息末尾（stopReason=length 是正常结束的附属信息，不是错误） */
function ChatMessages() {
  const messages = useChatStore(
    (s) => s.messagesBySession[s.activeSessionId ?? ''] ?? EMPTY_MESSAGES
  )
  const truncated = useChatStore(selectTruncated)
  const lastError = useChatStore(selectLastError)

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

/**
 * 底部输入区：输入卡上方灰条（项目会话信息区，新聊天限定）+
 * 输入卡（24px 圆角白卡 + 极浅 1px 边，聚焦无反馈）：Enter 发送（isComposing
 * 挡输入法误发）、流式中发送钮变停止钮（agent.abort）、底部工具行 = 裸 +
 * 附件 / 完全访问 / 上下文指示器 / 模型下拉（ModelMenu）/ 发送。
 */
function ChatComposer({ session }: { session: HomeSession }) {
  const [value, setValue] = useState('')
  const running = useChatStore(selectRunning)
  const submit = useChatStore((s) => s.submit)
  const abort = useChatStore((s) => s.abort)
  const activeModelId = useEngineStore((s) => s.activeModelId)
  const thinkingLevel = useEngineStore((s) => s.thinkingLevel)
  // 活动模型的 provider：双键查找（findActiveModel）。id 单键两处撞车 —— 全集里
  // 撞未配 key 的收录家（azure 也收录 deepseek-v4-pro），可用集里撞同名可用家
  // （zai 目录与自定义网关都有 glm-5.3，都配了 key 时永远命中目录在前那份，
  // 自定义厂商"选不上"即此，2026-11-10）
  const activeProvider = useEngineStore((s) =>
    findActiveModel(s.models, s.keyConfigured, s.activeModelId, s.activeProviderId)?.provider
  )
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
    // submit 可能要先按需建会话（空列表着陆页直发，chat store 内物化）——必须
    // await 之后再读 activeSessionId 翻视图态，否则建会话未落定时读到 null，
    // 消息进了新会话而视图还停在新聊天（串视图）。清空输入放在受理成功之后：
    // submit 失败（引擎不可用）会 rethrow，此时输入框保留原文供改后重发
    void (async () => {
      try {
        await submit(text, activeModelId, thinkingLevel, activeProvider)
      } catch {
        return // 失败态已由 store 落（错误条 + 运行位复位），原文留在输入框
      }
      setValue('')
      // 发首条消息即脱离"新聊天进行中"视图态（信息区消失，对齐 ChatGPT：
      // 提交后进入正常对话态）；activeId 此刻必为 submit 物化/选中的会话
      const activeId = useChatStore.getState().activeSessionId
      if (activeId !== null) {
        useHomeStore.setState({ session: { kind: 'chat', chatId: activeId } })
      }
      // 发送即回到底部并恢复跟随（对齐主流产品）：翻历史/索引跳转过也吸底；
      // 消息追加后库的 handleContentChange 在 following-bottom 态继续吸底
      scrollToEnd()
    })()
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
              {/* 上下文指示器紧邻模型下拉：分母（contextWindow）跟着模型走 */}
              <ContextIndicator session={session} />
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
