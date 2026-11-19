/**
 * 主要区（区域代号见 AGENTS.md）会话本体：三段式 flex-col ——
 *   ① 头部：会话标题（chat store 真数据）+ [更多 + 标签页区折叠开关]（折叠开关
 *      命令/状态由 HomeMain 经 props 下发，与 AppHeader 同一手法）
 *   ② 对话流：MessageScroller（@shadcn/react）—— 吸底/滚到底部悬浮钮现成；
 *      消息按回合分组渲染（TurnGroup，ZCode 式两态：过程直播 → 完成收进
 *      「已工作」轨迹，见 docs/模块/消息呈现.md）；消息源是 useChatStore
 *      （引擎事件流驱动，流式占位 id='streaming' 由 store 维护）。
 *      对话正文是"正文类内容"，按 AGENTS.md 方针 5 在内容容器上 select-text 放开选中
 *   ③ 输入框：shadcn AI 组件（components/ui/input-group）—— 发送组合键按
 *      设置页「发送快捷键」分流（缺省 Enter 发送、Shift+Enter 换行；中文
 *      输入法组词中不误发，判 isComposing）、
 *      流式中发送钮变停止钮（agent.abort）
 * 会话视图的自成一域单元已拆至同目录单文件：回合容器（TurnGroup，内含分组/
 * 切分/聚合，复用 MessageRow）、单条消息（MessageRow，导出 UsageLine/MessageLike）、
 * 对话索引轨道（ConversationIndex，消息流左侧刻度列）、模型下拉（ModelMenu，
 * 内嵌思考力度滑杆 ThinkingSlider）、上下文指示器（ContextIndicator）。
 * 项目回显走 project store（真数据）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  IconArrowUp,
  IconClock,
  IconDeviceDesktop,
  IconDots,
  IconFolder,
  IconLayoutSidebarRightCollapse,
  IconLayoutSidebarRightExpand,
  IconPlayerPlayFilled,
  IconSquare,
  IconStack2Filled,
} from '@tabler/icons-react'
import { cn } from 'cn'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupTextarea,
} from '@/components/ui/input-group'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from '@/components/ui/message-scroller'
import { RevealPacingContext } from '@/components/ui/markdown'
import { createStreamingRevealPacing } from '@/components/ui/stream-reveal'
import { useHomeStore, type HomeSession } from '@/stores/home'
import { bindChatDraft, chatDraftId, EMPTY_DRAFT, useAttachmentStore, type Draft } from '@/stores/attachments'
import { AttachmentRejections } from './AttachmentRejections'
import { AttachmentMenu } from './AttachmentMenu'
import { ATTACHMENT_LIMITS, formatAttachmentBytes } from '@shared/attachments'
import { AttachmentCards, isReferenceOnlyAttachment } from './AttachmentCards'
import { unwrapIpcError } from '@/lib/ipc'
import {
  EMPTY_MESSAGES,
  selectLastError,
  selectRunning,
  selectStopping,
  selectLastRunOutcome,
  selectCompacting,
  selectTruncated,
  useChatStore,
  type SessionBucket,
} from '@/stores/chat'
import type { ProjectSummary } from '@/env.d'
import { useProjectStore } from '@/stores/project'
import { ProjectPicker } from './ProjectPicker'
import { ApprovalPanel } from './ApprovalPanel'
import { PermissionMenu } from './PermissionMenu'
import { PlanToggle } from './PlanToggle'
import { TodoStrip } from './TodoStrip'
import { QuestionPanel } from './QuestionPanel'
import { PlanPanel } from './PlanPanel'
import { findActiveModel, useEngineStore, type SendShortcut } from '@/stores/engine'
import { ConversationIndex } from './ConversationIndex'
import { ModelMenu } from './ModelMenu'
import { ContextIndicator } from './ContextIndicator'
import { useChatTheme } from './ChatTheme'
import type { MessageLike } from './MessageRow'
import { groupTurns, TurnGroup, type TurnPhase } from './TurnGroup'

// ConversationIndex/ModelMenu 经本文件取消息渲染形状 —— 再导出保持既有导入路径
export type { MessageLike } from './MessageRow'

/** 白底行/钮 hover：黑 5% 软叠（全局配方，同 content-sidebar 行） */
const HOVER = 'hover:bg-accent-foreground/5 hover:text-foreground'
const EMPTY_TURN_OUTCOMES: SessionBucket['turnOutcomes'] = {}

/** 相对时间文案（信息卡「最近活动」行用）：刚刚 / N 分钟前 / N 小时前 /
    N 天前，更久落本地日期 —— 会话 updatedAt 随消息推进（chat store），
    项目级无现成字段，由调用方以同项目会话的 max(updatedAt) 下发 */
function relativeTime(ms: number): string {
  const delta = Date.now() - ms
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`
  if (delta < 30 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`
  return new Date(ms).toLocaleDateString()
}

/** 头部：会话标题 + [更多 / 标签页区折叠开关]（标题来自 chat store 的活动会话）。
    项目会话 hover 标题区（图标+标题整体）出信息卡（zcode 同款，2026-11-16
    定调替代先前的项目名 tooltip）：标题全文（头部行截断，卡里看全）+ 项目
    名称/主根路径 + 最近活动；git 分支行暂缺 —— 引擎协议与壳桥均无分支通道
    （UI布局.md 已记录），留工作区面板后续件。触发区是非交互 span 不包 Button */
function ChatHeader({
  title,
  project,
  lastActiveAt,
  tabsCollapsed,
  tabsToggleDisabled,
  onToggleTabs,
}: {
  title: string
  /** 项目会话的归属项目；undefined = 非项目会话不显图标不出卡 */
  project?: ProjectSummary
  /** 同项目各会话的最近更新时间（毫秒）；无记录不显活动行 */
  lastActiveAt?: number
  tabsCollapsed: boolean
  tabsToggleDisabled?: boolean
  onToggleTabs: () => void
}) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 pr-2 pl-4">
      {project !== undefined ? (
        <HoverCard>
          {/* delay/closeDelay 是 preview-card Trigger 的 prop（Root 没有）；
              400 同 Hint 口径 —— 划过标题不闪卡 */}
          <HoverCardTrigger
            delay={400}
            closeDelay={0}
            render={
              <span
                className="flex min-w-0 flex-1 cursor-default items-center gap-1.5"
                aria-label={`项目：${project.name}`}
              />
            }
          >
            {/* 图标是按钮（同「更多」钮 ghost 同款，hover 出底）；点击行为空位
                —— 同头部「更多」钮先占位后接线的惯例 */}
            <Button variant="ghost" size="icon-sm" className={cn(HOVER, 'text-muted-foreground')} aria-label={`项目：${project.name}`}>
              <IconFolder className="size-4.5" />
            </Button>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</span>
          </HoverCardTrigger>
          {/* 排版对照 ContextIndicator 的 PopoverContent（13px 主文案 + muted
              次行 + border-t 分组）；卡片纯展示无动作行。align=start：触发区
              是整行标题（flex-1），默认居中对齐会让卡片飘到内容区中部 ——
              左对齐到触发区左缘（图标处）即 zcode 位置 */}
          <HoverCardContent side="bottom" align="start" sideOffset={8} className="w-72 gap-0 p-3">
            <div className="flex items-center gap-2">
              <IconFolder className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</span>
            </div>
            <div className="mt-3 flex items-center gap-2 border-t pt-3">
              <IconFolder className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-foreground">{project.name}</div>
                {/* 主根路径（多根项目其余目录在工作区面板看，同信息区口径） */}
                <div className="truncate text-xs text-muted-foreground">{project.cwds[0]}</div>
              </div>
            </div>
            {lastActiveAt !== undefined && (
              <div className="mt-3 flex items-center gap-2">
                <IconClock className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate text-sm text-foreground">
                  最近活动 {relativeTime(lastActiveAt)}
                </span>
              </div>
            )}
          </HoverCardContent>
        </HoverCard>
      ) : (
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</span>
      )}
      <Hint tip="更多" side="bottom">
        <Button variant="ghost" size="icon-sm" className={cn(HOVER, 'text-muted-foreground')} aria-label="更多">
          <IconDots className="size-4" />
        </Button>
      </Hint>
      {/* 标签页区折叠开关：系列图标两态，同 AppHeader 的 content-sidebar 开关 */}
      <Hint tip={tabsCollapsed ? '展开标签页区' : '折叠标签页区'} side="bottom">
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(HOVER, 'text-muted-foreground')}
          aria-label={tabsCollapsed ? '展开标签页区' : '折叠标签页区'}
          disabled={tabsToggleDisabled}
          onClick={onToggleTabs}
        >
          {tabsCollapsed ? (
            <IconLayoutSidebarRightExpand className="size-[19px]" />
          ) : (
            <IconLayoutSidebarRightCollapse className="size-[19px]" />
          )}
        </Button>
      </Hint>
    </header>
  )
}

/** 对话流：消息源 = chat store 活动会话（引擎事件流驱动，含流式占位与工具卡行），
    渲染期按回合分组（TurnGroup 管两态呈现）。截断/失败提示条挂在消息末尾
    （stopReason=length 是正常结束的附属信息，不是错误） */
function ChatMessages() {
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const messages = useChatStore(
    (s) => s.bySession[activeSessionId ?? '']?.messages ?? EMPTY_MESSAGES
  )
  const turnOutcomes = useChatStore(
    (s) => s.bySession[s.activeSessionId ?? '']?.turnOutcomes ?? EMPTY_TURN_OUTCOMES
  )
  // 对话内容主题：亮色令牌变量挂消息流容器（单点），暗色/extraCss 由 hook 内部
  // <style> 管理 —— 见 ChatTheme.ts
  const themeVars = useChatTheme()
  const running = useChatStore(selectRunning)
  const stopping = useChatStore(selectStopping)
  const lastRunOutcome = useChatStore(selectLastRunOutcome)
  const truncated = useChatStore(selectTruncated)
  // 压缩进行中（完备化 D8）：started→completed 窗口，消息流内状态条
  const compacting = useChatStore(selectCompacting)
  const lastError = useChatStore(selectLastError)

  // 结果属于用户回合；新提问只改变当前live，不能把旧中止/失败改成done。
  // 仅末尾无user兜底组沿用会话最近结果，其他未知结果默认done。
  const turns = groupTurns(messages)
  const terminalPhase = (outcome: SessionBucket['runtime']['lastRunOutcome'] | undefined): TurnPhase =>
    outcome === 'stopped' ? 'stopped' : outcome === 'failed' ? 'failed' : 'done'
  // 索引只预览已完成回合的末段回答；工具间已封段的正文也不能冒充最终回答。
  const indexAnswers = new Map<string, string>()
  for (const turn of turns) {
    if (turn.user === undefined || (turn === turns.at(-1) && running) || terminalPhase(turnOutcomes[turn.user.id]) !== 'done') continue
    const answer = turn.items.findLast((item) => item.type === undefined && item.role === 'assistant' && !item.placeholder && item.content.trim() !== '')
    if (answer !== undefined && answer.type === undefined) indexAnswers.set(turn.user.id, answer.content)
  }
  // 段间排期接力种子：随活动会话更换（切会话时消息全部重挂，旧段排期自然作废）
  const revealPacing = useMemo(() => createStreamingRevealPacing(), [activeSessionId])

  return (
    <RevealPacingContext.Provider value={revealPacing}>
    <MessageScroller className="min-h-0 flex-1">
      <MessageScrollerViewport className="chat-viewport">
        {/* select-text：对话正文是正文类内容（AGENTS.md 方针 5 的首个放开点）。
            放开区里的 chrome 行在行上收回 select-none（TraceLine 轨迹行族 /
            用量行 / 时间戳）—— 放开的是正文，不是行头。
            正文与输入框共用 chat-column，索引仅使用列外留白；留白不足时收起，
            不靠正文单侧 padding 给索引让位，避免正文与输入框中心线错开。
            回合 = 视觉单元：外层 gap-6 隔回合，回合内 gap-3 紧凑成组。顶层
            条目（user/终答/live 过程行）挂 scroller item 供刻度/定位按
            messageId 查表；终态折叠体内的过程条目不挂 —— content-visibility
            会扰动开合动画的轨道分母（见 TurnGroup 终态分支） */}
        <MessageScrollerContent
          style={themeVars}
          className="chat-column gap-6 py-6 select-text"
        >
          {turns.map((turn) => (
            // key：user 有则用 user；无 user 头组取首项 id（D9 保留式下压缩条
            // 原位成组、可多条并存，静态 'head' 会撞 key；无 user 的组结构上
            // 必有首项 —— 压缩条组带 bar、尾部兜底组先 push 再填 items）
            <div key={turn.user?.id ?? turn.items[0].id} className="flex min-w-0 flex-col gap-3">
              <TurnGroup
                turn={turn}
                phase={turn === turns.at(-1) && running
                  ? 'live'
                  : terminalPhase(turn.user !== undefined
                    ? turnOutcomes[turn.user.id]
                    : turn === turns.at(-1) ? lastRunOutcome : undefined)}
                stopping={turn === turns.at(-1) && stopping}
              />
            </div>
          ))}
          {/* 压缩中状态条（完备化 D8，Codex 两态的前态）：started→completed 窗口
              常驻行；摘要是一次秒级 LLM 调用，期间本条与流式占位/工具卡并存 */}
          {compacting && (
            <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground" aria-hidden="true" />
              正在压缩上下文…
            </div>
          )}
          {/* 截断动作条：自动续写预算尽
              （3 次）仍截断时交还用户 ——「继续生成」走 session.continue（引擎注入
              续写指令并再给满预算），「立即压缩」走 session.compact（腾地后重发更
              稳）。流式中隐藏（续写中 truncated 已被乐观清位，双保险） */}
          {truncated && !running && (
            <div className="flex items-center justify-center gap-1.5 text-xs text-warning">
              <span>回复被输出长度上限截断</span>
              <Button
                variant="ghost"
                size="xs"
                className="h-6 gap-1 rounded-lg px-2 text-warning hover:bg-warning/10 hover:text-warning"
                onClick={() => void useChatStore.getState().continueGeneration()}
              >
                <IconPlayerPlayFilled className="size-3" aria-hidden="true" />
                继续生成
              </Button>
              <Button
                variant="ghost"
                size="xs"
                className="h-6 gap-1 rounded-lg px-2 text-warning hover:bg-warning/10 hover:text-warning"
                onClick={() => void useChatStore.getState().compactNow()}
              >
                <IconStack2Filled className="size-3" aria-hidden="true" />
                立即压缩
              </Button>
            </div>
          )}
          {lastError && <div className="text-center text-xs text-destructive">{lastError}</div>}
        </MessageScrollerContent>
      </MessageScrollerViewport>
      {/* 索引轨道只标注内容消息（工具卡不是刻度目标，过滤掉） */}
      <ConversationIndex messages={messages.filter((m): m is MessageLike => m.type !== 'tool')} answers={indexAnswers} />
      {/* 非底部时浮现的"滚到底部"圆钮，message-scroller 现成 */}
      <MessageScrollerButton />
    </MessageScroller>
    </RevealPacingContext.Provider>
  )
}

/**
 * 发送组合键判定（导出供单测）：shortcut 选中组合 → true（发送并吃掉默认
 * 行为），其余 Enter 组合 → false（textarea 原生换行）；IME 组词中恒 false
 * （输入法确认键也是 Enter，不判 isComposing 会把组词当发送）。
 * enter 档只挡 shift —— 与首发行为一致（Ctrl+Enter 同发，主流输入框惯例）；
 * 另两档做精确单键匹配（Ctrl+Shift+Enter 这类跨档组合不误发）。
 */
export function isSendKey(
  event: { key: string; shiftKey: boolean; ctrlKey: boolean; nativeEvent: { isComposing: boolean } },
  shortcut: SendShortcut
): boolean {
  if (event.key !== 'Enter' || event.nativeEvent.isComposing) return false
  if (shortcut === 'enter') return !event.shiftKey
  if (shortcut === 'shift+enter') return event.shiftKey && !event.ctrlKey
  return event.ctrlKey && !event.shiftKey
}

/**
 * 底部输入区：输入卡上方灰条（项目会话信息区，新聊天限定）+
 * 输入卡（InputGroup 原生圆角白卡 + 极浅 1px 边，聚焦无反馈）：发送组合键
 * 按设置页「发送快捷键」分流（isSendKey；缺省 Enter，IME 组词中不误发）、
 * 流式中发送钮变停止钮（agent.abort）、底部工具行 = 裸 +
 * 附件 / 权限模式菜单 / 上下文指示器 / 模型下拉（ModelMenu）/ 发送。
 * 输入草稿由独立仓通过 props 提供：待审批时本组件整体被
 * ApprovalPanel **替换**（2026-11-11 用户定调：审批卡覆盖输入位、不支持
 * 输入 —— run 挂起中本就发不出，留着能打字的框是误导），本地态会随卸载
 * 丢草稿，独立仓持有则裁决后回来字还在。
 */
function ChatComposer({
  session,
  draftId,
  draft,
  value,
  onValueChange
}: {
  session: HomeSession
  draftId: string
  draft: Draft
  value: string
  onValueChange: (next: string) => void
}) {
  // 草稿仓持有提交身份与编辑代次；输入区因审批卸载也不丢提交后的新编辑。
  const setValue = onValueChange
  const running = useChatStore(selectRunning)
  const submit = useChatStore((s) => s.submit)
  const abort = useChatStore((s) => s.abort)
  const sendShortcut = useEngineStore((s) => s.sendShortcut)
  const activeModelId = useEngineStore((s) => s.activeModelId)
  const thinkingLevel = useEngineStore((s) => s.thinkingLevel)
  // 活动模型的 provider：双键查找（findActiveModel）。id 单键两处撞车 —— 全集里
  // 撞未配 key 的收录家（azure 也收录 deepseek-v4-pro），可用集里撞同名可用家
  // （zai 目录与自定义网关都有 glm-5.3，都配了 key 时永远命中目录在前那份，
  // 自定义厂商"选不上"即此，2026-11-10）
  const activeProvider = useEngineStore((s) =>
    findActiveModel(s.models, s.keyConfigured, s.activeModelId, s.activeProviderId)?.provider
  )
  const imageInput = useEngineStore((s) => findActiveModel(s.models, s.keyConfigured, s.activeModelId, s.activeProviderId)?.input?.includes('image') === true)
  const media = useAttachmentStore((s) => s.media)
  const items = draft.items
  const referenceOnly = items.some((item) => item.ref !== undefined && isReferenceOnlyAttachment(item.ref, imageInput, media))
  const overCapacity = items.reduce((n, item) => n + item.size, 0) > ATTACHMENT_LIMITS.messageBytes
  const blocked = !draft.loaded || items.some((item) => item.status !== 'ready') || overCapacity
  const sendLabel = referenceOnly ? '作为文件发送' : '发送'
  const reportError = (error: unknown): void => {
    useAttachmentStore.setState((state) => ({ drafts: { ...state.drafts, [draftId]: { ...state.drafts[draftId]!, error: unwrapIpcError(error) } } }))
  }
  const add = (files: Array<File | string>): void => useAttachmentStore.getState().add(draftId, files)
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
    if ((!text && items.length === 0) || running || blocked) return
    const token = useAttachmentStore.getState().startSubmission(draftId)
    const view = useHomeStore.getState().session
    // submit 可能要先按需建会话（空列表着陆页直发，chat store 内物化）——必须
    // 受理结果直接携带目标 sessionId，不能在 await 后用可能已切走的活动会话猜归属。
    // 清空输入放在受理成功之后：
    // submit 失败（引擎不可用）会 rethrow，此时输入框保留原文供改后重发
    void (async () => {
      try {
        const acceptedSessionId = await submit(text, activeModelId, thinkingLevel, activeProvider,
          items.flatMap((item) => item.ref === undefined ? [] : [item.ref]),
          items.flatMap((item) => item.directory === undefined ? [] : [item.directory]))
        if (acceptedSessionId === false) return
        const consumed = useAttachmentStore.getState().consume(draftId, draft, token)
        if (!consumed) return
        if (view.kind === 'new') {
          bindChatDraft(acceptedSessionId, draftId)
          useHomeStore.getState().finishNewChat(view.draftId ?? 'default', acceptedSessionId)
        }
        const visible = useHomeStore.getState().session
        if (visible.kind === 'chat' && visible.chatId === acceptedSessionId) {
          useChatStore.setState({ activeSessionId: acceptedSessionId })
          scrollToEnd()
        }
      } catch {
        return // 失败态已由 store 落（错误条 + 运行位复位），原文留在输入框
      }
    })()
  }

  return (
    <div className="shrink-0 pb-4">
      <div className="chat-column chat-composer-column">
        {/* 灰舌头（项目会话信息区）：见函数头注释 —— 新聊天限定。
            项目归属 = 只显项目卡（名称 + 悬停见全部根路径）——项目必含目录，
            再出目录卡是重复信息（用户实测：项目叫 Cogent、目录 basename 也叫
            Cogent 时出现两个"Cogent"）；目录卡只在"无项目但会话直接绑了
            目录"时兜底显示 */}
        {session.kind === 'new' && (
          <div className="relative mx-4 -mb-3 flex h-12 items-center gap-6 rounded-t-xl bg-muted px-4 pb-3">
            {project || projectId === undefined ? (
              /* ProjectPicker 同时负责项目清单和会话物化。不能在这里仅改视图态，
                  因为 projectId 只能在 session.create 时绑定，否则首条消息会串归属。 */
              <ProjectPicker
                projectId={projectId}
                onProjectId={(nextProjectId) => {
                  useHomeStore.getState().updateNewChat({ projectId: nextProjectId })
                }}
              />
            ) : primaryCwd ? (
              /* 目录胶囊：basename 为主显示，悬停看全路径（shadcn Tooltip） */
              <Hint tip={primaryCwd} side="top">
                <Button
                  variant="ghost"
                  size="xs"
                  className="gap-1.5 px-1 font-normal text-sm text-foreground hover:bg-accent-foreground/5"
                >
                  <IconDeviceDesktop className="size-4.5 text-muted-foreground" />
                  {cwdBasename}
                </Button>
              </Hint>
            ) : null}
          </div>
        )}

        {/* 输入卡盖住信息条下沿，圆角与阴影由原语的 composer 档统一维护。 */}
        <InputGroup variant="composer">
          {items.length > 0 && <InputGroupAddon align="block-start" className="w-full px-4 pt-3">
            <AttachmentCards items={items}
              onRemove={(key) => useAttachmentStore.getState().remove(draftId, key)}
              onRetry={(key) => useAttachmentStore.getState().retry(draftId, key)} />
          </InputGroupAddon>}
          <InputGroupTextarea
            value={value}
            disabled={!draft.loaded}
            onPaste={(event) => {
              const data = event.clipboardData
              const text = data.getData('text/plain')
              // 表格的 HTML/位图并存时保留可编辑文字；截图只有图像时接附件。
              if (text !== '' && /<table[\s>]/i.test(data.getData('text/html'))) return
              const files = Array.from(data.files)
              if (files.length > 0) { event.preventDefault(); add(files); return }
              if (text === '' || data.getData('text/uri-list').split(/\r?\n/).some((line) => line.startsWith('file://')) || data.types.includes('Files')) {
                event.preventDefault()
                void window.cogent.clipboardFiles().then(add, reportError)
              }
            }}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              // 发送组合键按「发送快捷键」设置分流（isSendKey 内含 IME 保护）
              if (isSendKey(event, sendShortcut)) {
                event.preventDefault()
                send()
              }
            }}
            placeholder="随心输入"
            className="content-typography max-h-52 px-4 pt-5 pb-2 placeholder:text-placeholder"
          />
          {/* gap-1：工具行三块（+ / 权限钮 / 计划 chip）紧凑（2026-11-16 用户
              定调，曾 gap-2 偏松）；分隔线自身 mx 已归零由本 gap 接管间距 */}
          <InputGroupAddon align="block-end" className="composer-toolbar gap-1 p-2">
            <AttachmentMenu disabled={!draft.loaded} onAdd={add} onError={reportError} />
            {/* 权限模式菜单（三档单选 + 顶部计划开关项）+ 计划开关外置 chip
                （正交开关 v3：chip 常显开关态，菜单项等价入口，两处同源同步） */}
            <PermissionMenu session={session} />
            <PlanToggle session={session} />
            <div className="composer-actions ml-auto flex min-w-0 items-center gap-3">
              {/* 上下文指示器紧邻模型下拉：分母（contextWindow）跟着模型走 */}
              <ContextIndicator session={session} />
              <ModelMenu />
              {/* 发送/停止双态：流式中变方块停止钮（abort 后 store 由 run.* 事件复位）。
                  图标按钮沿用 icon-sm 圆角档；空输入置灰；cursor-pointer（2026-11-16 用户定调，
                  Button 原语默认 cursor-default）；Hint 文案按双态切换 */}
              {running ? (
                <Hint tip="停止" side="top">
                  <Button
                    size="icon-sm"
                    className="size-7 cursor-pointer bg-foreground/85 hover:bg-foreground"
                    aria-label="停止"
                    onClick={() => void abort()}
                  >
                    <IconSquare className="size-3 fill-current" />
                  </Button>
                </Hint>
              ) : (
                <Hint tip={sendLabel} side="top">
                  <Button
                    size="icon-sm"
                    /* 禁用态 cursor-not-allowed（2026-11-16 用户定调）：原语
                       disabled:pointer-events-none 会把光标回落成父层的 default
                       （Hint 外层接住 pointer 事件），显式声明禁用光标；允许
                       pointer 事件穿透到钮上是安全的 —— button disabled 属性
                       本身就不派发 click */
                    className="size-7 cursor-pointer bg-foreground/85 hover:bg-foreground disabled:pointer-events-auto disabled:cursor-not-allowed disabled:hover:bg-foreground/85"
                    aria-label={sendLabel}
                    disabled={blocked || (!value.trim() && items.length === 0)}
                    onClick={send}
                  >
                    <IconArrowUp className="size-3.5" />
                  </Button>
                </Hint>
              )}
            </div>
          </InputGroupAddon>
          {draft.error !== null && <InputGroupAddon align="block-end" role="alert">{draft.error}
            {!draft.loaded && <Button variant="ghost" size="xs" onClick={() => void useAttachmentStore.getState().load(draftId)}>重试恢复</Button>}
          </InputGroupAddon>}
          {draft.rejections !== undefined && draft.rejections.length > 0 && <InputGroupAddon align="block-end">
            <AttachmentRejections items={draft.rejections} onClear={() => useAttachmentStore.getState().clearRejections(draftId)} />
          </InputGroupAddon>}
          {overCapacity && <InputGroupAddon align="block-end" role="alert">附件合计超过 {formatAttachmentBytes(ATTACHMENT_LIMITS.messageBytes)}，请移除部分文件。</InputGroupAddon>}
        </InputGroup>
      </div>
    </div>
  )
}

export function HomeChat({
  tabsCollapsed,
  tabsToggleDisabled,
  onToggleTabs,
}: {
  tabsCollapsed: boolean
  tabsToggleDisabled?: boolean
  onToggleTabs: () => void
}) {
  const session = useHomeStore((s) => s.session)
  const title = useChatStore(
    (s) => s.sessions.find((x) => x.id === s.activeSessionId)?.title ?? '新聊天'
  )
  // 项目会话归属项目（头部信息卡用）：已有会话按 projectId 反查 project
  // store；"新聊天进行中"态无会话标题语义，不显图标（与头部标题同生灭）。
  // lastActiveAt = 同项目各会话 updatedAt 的 max（项目级无现成字段，派生），
  // selector 返回原始值数字，引用稳定不引起额外重渲染
  const activeProjectId = useChatStore((s) =>
    session.kind === 'chat' ? s.sessions.find((x) => x.id === s.activeSessionId)?.projectId : undefined
  )
  const project = useProjectStore((s) =>
    activeProjectId !== undefined ? s.projects.find((p) => p.id === activeProjectId) : undefined
  )
  const lastActiveAt = useChatStore((s) => {
    if (activeProjectId === undefined) return undefined
    let max = 0
    for (const x of s.sessions) {
      if (x.projectId === activeProjectId && x.updatedAt > max) max = x.updatedAt
    }
    return max > 0 ? max : undefined
  })
  // 待审批 = ApprovalPanel **替换**输入区（2026-11-11 用户定调：审批卡覆盖
  // 输入位、待审批不支持输入）。草稿由独立仓持有，Composer 卸载不丢字。
  // 挂起提问（4c-2）同款占位（QuestionPanel 与审批面板互斥呈现 —— 都是
  // run 挂起中的人机裁决，同一时刻至多一类挂起是引擎执行模型的自然结果）
  const hasPendingApproval = useChatStore(
    (s) => (s.bySession[s.activeSessionId ?? '']?.pendingApprovals.length ?? 0) > 0
  )
  const hasPendingQuestion = useChatStore(
    (s) => (s.bySession[s.activeSessionId ?? '']?.pendingQuestions.length ?? 0) > 0
  )
  const hasPendingPlan = useChatStore(
    (s) => (s.bySession[s.activeSessionId ?? '']?.pendingPlans.length ?? 0) > 0
  )
  const draftId = session.kind === 'chat' ? chatDraftId(session.chatId) : `new-${session.draftId ?? 'default'}`
  const draft = useAttachmentStore((s) => s.drafts[draftId] ?? EMPTY_DRAFT)
  useEffect(() => { void useAttachmentStore.getState().load(draftId) }, [draftId])
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  return (
    <div className="home-chat relative flex h-full min-w-0 flex-col"
      onDragEnter={(event) => {
        if (!draft.loaded || !event.dataTransfer.types.includes('Files')) return
        event.preventDefault(); dragDepth.current++; setDragging(true)
      }}
      onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' } }}
      onDragLeave={(event) => { event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDragging(false) }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault(); dragDepth.current = 0; setDragging(false)
        if (draft.loaded) useAttachmentStore.getState().add(draftId, Array.from(event.dataTransfer.files))
      }}>
      {dragging && <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center rounded-lg border-2 border-dashed bg-background/90" role="status">添加到当前聊天</div>}
      <ChatHeader
        title={title}
        project={project}
        lastActiveAt={lastActiveAt}
        tabsCollapsed={tabsCollapsed}
        tabsToggleDisabled={tabsToggleDisabled}
        onToggleTabs={onToggleTabs}
      />
      {/* 吸底跟随不走库 autoScroll（已关）：其 RO→rAF→scrollTo 链路慢一帧，
          流式期间"增长帧推下、下一帧拉回"即工作中行抖动；跟随由
          message-scroller 的 useStreamingBottomPin 独占（增长当帧贴底），
          滚走释放/滚回恢复同样在彼处。defaultScrollPosition（初始定位）、
          发送时 scrollToEnd（显式 API）不受影响；悬浮钮显隐由库按位置自判 */}
      <MessageScrollerProvider defaultScrollPosition="end">
        {/* 内容区主体（relative 供 TodoStrip absolute 挂靠）：清单浮在消息流
            右上角（2026-11-16 用户定调），不再占输入区上方布局位 —— 跨回合的
            "进行中"状态与"当下"输入（下方的面板/输入框）彻底分离 */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <ChatMessages />
          <TodoStrip />
        </div>
        {hasPendingApproval ? (
          <ApprovalPanel />
        ) : hasPendingPlan ? (
          <PlanPanel />
        ) : hasPendingQuestion ? (
          <QuestionPanel />
        ) : (
          <ChatComposer session={session} draftId={draftId} draft={draft} value={draft.text} onValueChange={(text) => useAttachmentStore.getState().setText(draftId, text)} />
        )}
      </MessageScrollerProvider>
    </div>
  )
}
