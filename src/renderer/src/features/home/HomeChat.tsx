/**
 * 主要区（UI 件 5，区域代号见 AGENTS.md）：会话三段式 flex-col ——
 *   ① 头部：项目图标（只有项目会话才有，演示数据 project 非空时出）+ 会话标题，
 *      右侧 [更多 + 标签页区折叠开关]（折叠开关命令/状态由 HomeMain 经 props 下发，
 *      与 AppHeader 的 content-sidebar 开关同一手法）
 *   ② 对话流：MessageScroller（@shadcn/react）—— 自动吸底/滚到底部悬浮钮现成；
 *      用户消息 = 灰气泡右挂（时间戳 + 复制/编辑），助手消息 = 无气泡平铺左对齐
 *      （参考稿排版）。对话正文是"正文类内容"，按 AGENTS.md 方针 5 在内容容器上
 *      select-text 放开选中
 *   ③ 输入框：shadcn AI 组件（components/ui/input-group，即 ai-sdk PromptInput 族
 *      的本地实现）—— 圆角容器 + 底部工具行（附件 + / 完全访问 / 模型下拉 / 黑圆
 *      发送钮），Textarea 自带 field-sizing-content 自动长高；样式按项目配色覆写
 * 对话索引（参考稿图 2/3）：流左侧一列短横线刻度，每条对应对话一条消息；当前
 * 锚点消息的刻度伸长加深（宽度/颜色 transition 即参考稿的动画），点击刻度经
 * scrollToMessage 平滑定位 —— 可见性/锚点由 message-scroller 的 visibility hook
 * 提供，不自研滚动监听。对话流与输入框同宽（max-w-3xl 居中，有空间时固定、
 * 没空间时随面板压缩）。
 * 演示数据静态样例：会话/消息域接入 store 属引擎后续件，动作全空位。
 */
import { useEffect, useState } from 'react'
import {
  IconArrowUp,
  IconChevronDown,
  IconCopy,
  IconDeviceDesktop,
  IconDots,
  IconFolder,
  IconGitBranch,
  IconLayoutSidebarRightCollapse,
  IconLayoutSidebarRightExpand,
  IconPencil,
  IconPlus,
  IconShieldExclamation,
} from '@tabler/icons-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { useHomeStore, type HomeSession } from '@/stores/home'
import { PROJECTS, findChat } from './data'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/components/ui/input-group'
import { Message, MessageContent, MessageFooter } from '@/components/ui/message'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from '@/components/ui/message-scroller'

/** 演示消息：任何已打开的会话都出这一段样例对话（会话消息域接入后替换） */

type DemoMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** 用户消息气泡下的时间戳；助手消息的 meta 是"用时 N 秒"状态行 */
  time?: string
  meta?: string
}

/** 静态样例：8 条够滚出索引动画；接 store 后由会话域替换 */
const MESSAGES: readonly DemoMessage[] = [
  { id: 'm1', role: 'user', text: '你好', time: '12:52' },
  {
    id: 'm2',
    role: 'assistant',
    text: '你好！我是 Cogent。接着整理项目约定，还是先看看新搭的内容区主体？',
    meta: '用时 1 秒',
  },
  { id: 'm3', role: 'user', text: '先看看主体区的骨架吧', time: '12:52' },
  {
    id: 'm4',
    role: 'assistant',
    text: '好。这块分左右两区：左边主要区（会话标题 + 对话流 + 输入框），右边标签页区 —— 平时折叠，拖开分屏线或点头部的折叠按钮展开。',
  },
  { id: 'm5', role: 'user', text: '对话流左侧那排小横线是什么？', time: '12:53' },
  {
    id: 'm6',
    role: 'assistant',
    text: '对话索引：每条横线对应对话里的一条消息，滚动时长线跟着当前消息走，点击横线可以直接定位过去。',
    meta: '用时 3 秒',
  },
  { id: 'm7', role: 'user', text: '明白了，先把这版发我看看', time: '12:53' },
  {
    id: 'm8',
    role: 'assistant',
    text: '已就绪：标签页区默认折叠，试试拖开它，或者点右上的折叠按钮。',
  },
]

/** 白底行/钮 hover：黑 5% 软叠（全局配方，同 content-sidebar 行） */
const HOVER = 'hover:bg-accent-foreground/5 hover:text-foreground'

/** 头部：项目图标（项目会话才有）+ 标题 + [更多 / 标签页区折叠开关]。
    标题/归属查样例数据；新聊天还没有标题，项目回显在下方信息区 */
function ChatHeader({
  session,
  tabsCollapsed,
  onToggleTabs,
}: {
  session: HomeSession
  tabsCollapsed: boolean
  onToggleTabs: () => void
}) {
  const found = session.kind === 'chat' ? findChat(session.chatId) : null
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 pr-2 pl-4">
      {/* 文件夹图标只属于项目会话（自由会话/新聊天没有） */}
      {found?.project && <IconFolder className="size-4 shrink-0 text-muted-foreground" />}
      <span className="min-w-0 flex-1 truncate text-sm font-semibold">
        {found ? found.chat.title : '新聊天'}
      </span>
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

/** 单条消息：用户 = 灰气泡右挂 + 时间戳/复制/编辑；助手 = 平铺 + 可选状态行 */
function MessageRow({ message }: { message: DemoMessage }) {
  if (message.role === 'user') {
    return (
      <Message align="end">
        <MessageContent>
          <Bubble variant="muted" align="end">
            <BubbleContent>{message.text}</BubbleContent>
          </Bubble>
          <MessageFooter className="gap-1 px-0">
            <span className="text-[11px] text-muted-foreground">{message.time}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-6 text-muted-foreground hover:bg-accent-foreground/5 hover:text-foreground"
              aria-label="复制"
            >
              <IconCopy className="size-3.5" />
            </Button>
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
        {message.meta && <span className="text-xs text-muted-foreground">{message.meta}</span>}
        <p className="text-sm leading-relaxed text-foreground">{message.text}</p>
      </MessageContent>
    </Message>
  )
}

/**
 * 对话索引轨道（参考稿动画）：短横线刻度一列，宽度/颜色 transition ——
 * ① 静止态：当前消息的刻度伸长加深；② hover 阶梯（用户对标 ChatGPT）：悬停
 * 刻度最长、两侧按距离依次变短（24/17/14/10px），颜色同步减淡 —— 宽度差即
 * "指针位置感"。items-start 让加长向右伸，同参考稿。点击刻度经 message-scroller
 * 的 scrollToMessage 平滑居中定位（库的强项，直接用）。
 * 激活项自算而不用库的 visibility/scrollable 快照：快照要等真实滚动才提交
 * （挂载默认吸底后是空），且 content-visibility 裁剪的占位高度会让 scrollable
 * 的"还能滚"判断在真到底时仍为真 —— 自算只有两条稳定规则：视口顶边压着的
 * 消息为当前；按真实 scrollHeight 口径已吸底时点亮末条。
 */
function ConversationIndex() {
  const { scrollToMessage } = useMessageScroller()
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
        setActiveId(items[items.length - 1].dataset.messageId ?? null)
        return
      }
      // 常规：顶边压着的最后一条 = 当前（与库的锚点定义一致）
      let current: string | null = items[0].dataset.messageId ?? null
      const viewportTop = vp.getBoundingClientRect().top
      for (const item of items) {
        const id = item.dataset.messageId
        if (!id) continue
        if (item.getBoundingClientRect().top <= viewportTop + 0.5) current = id
        else break
      }
      setActiveId(current)
    }
    measure() // 挂载即量一次（默认吸底态也有激活刻度）
    vp.addEventListener('scroll', measure, { passive: true })
    return () => vp.removeEventListener('scroll', measure)
  }, [])

  return (
    <div
      className="absolute top-1/2 left-3 flex -translate-y-1/2 flex-col items-start gap-[7px]"
      onMouseLeave={() => setHoverIndex(null)}
    >
      {MESSAGES.map((message, index) => {
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
            title={message.text.slice(0, 20)}
            aria-label={`定位消息：${message.text.slice(0, 12)}`}
            onMouseEnter={() => setHoverIndex(index)}
            onClick={() => scrollToMessage(message.id, { align: 'center', behavior: 'smooth' })}
            className={cn('h-[3px] rounded-full transition-all duration-200', width, shade)}
          />
        )
      })}
    </div>
  )
}

/** 对话流：Scroller 全宽，内容 max-w-3xl 居中（与输入框同宽，见 ChatComposer） */
function ChatMessages() {
  return (
    <MessageScrollerProvider defaultScrollPosition="end">
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport>
          {/* select-text：对话正文是正文类内容（AGENTS.md 方针 5 的首个放开点）。
              内边距给索引轨道留固定 gutter：pl-11 = 轨道(左 12px + 激活刻度 20px)
              + 12px 间隙 —— 面板窄时（列宽顶到 max-w-3xl）文字也不会贴轨道/边缘 */}
          <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-6 py-6 pr-6 pl-11 select-text">
            <div className="text-center text-xs text-muted-foreground">今天 12:52</div>
            {MESSAGES.map((message) => (
              <MessageScrollerItem key={message.id} messageId={message.id} scrollAnchor>
                <MessageRow message={message} />
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <ConversationIndex />
        {/* 非底部时浮现的"滚到底部"圆钮，message-scroller 现成 */}
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  )
}

/** 信息区条目钮：ghost 无底感、hover 轻叠（同全局配方），文字实色近黑 */
const STRIP_BUTTON = 'gap-1.5 px-1 font-normal text-[13px] text-foreground hover:bg-accent-foreground/5'

/**
 * 底部输入区（对标 ChatGPT 参考稿，1:1）：输入卡上方一个灰 div（项目会话
 * 信息区）—— 宽比卡小一圈（两侧各缩 20px，mx-5），只有左上/右上圆角（12px），底边
 * 与卡顶齐平贴住，浏览器"标签页扣在面板上"的形状。**只在新聊天时出现**
 * （已有对话的会话不显示，用户定的规则）：未选项目 = 单个"选择项目"钮；
 * 项目内发起 = 回显项目名 + 本地 + main。项全是按钮（图标+文字），点击行为
 * 后续件。输入卡：24px 圆角白卡 + 极浅 1px 边，输入行 + 底部工具行（裸 +
 * 附件钮、浅红胶囊"完全访问"空位、中灰模型下拉空位、28px 石墨灰圆发送钮，
 * 空输入置灰）。聚焦不出 ring/边框变色。
 */
function ChatComposer({ session }: { session: HomeSession }) {
  const [value, setValue] = useState('')
  // 回显项目：项目行"新建聊天"发起时带 projectId
  const project =
    session.kind === 'new' && session.projectId
      ? PROJECTS.find((p) => p.id === session.projectId)
      : undefined

  return (
    <div className="shrink-0 px-4 pb-4">
      <div className="mx-auto w-full max-w-3xl">
        {/* 灰舌头（项目会话信息区）：见函数头注释 —— 新聊天限定 */}
        {session.kind === 'new' && (
          <div className="mx-5 flex h-9 items-center gap-6 rounded-t-xl bg-muted px-4">
            {project ? (
              <>
                <Button variant="ghost" size="xs" className={STRIP_BUTTON}>
                  <IconFolder className="size-4 text-muted-foreground" />
                  {project.name}
                </Button>
                <Button variant="ghost" size="xs" className={STRIP_BUTTON}>
                  <IconDeviceDesktop className="size-4 text-muted-foreground" />
                  本地
                </Button>
                <Button variant="ghost" size="xs" className={STRIP_BUTTON}>
                  <IconGitBranch className="size-4 text-muted-foreground" />
                  main
                </Button>
              </>
            ) : (
              <Button variant="ghost" size="xs" className={STRIP_BUTTON}>
                <IconFolder className="size-4 text-muted-foreground" />
                选择项目
              </Button>
            )}
          </div>
        )}

        {/* has-* 反制两条：①组件给带 textarea 的组默认 rounded-2xl，压回
            rounded-3xl；②聚焦态 border-ring + ring-3 光晕，参考稿聚焦无变化
            —— 都同变体覆写（tailwind-merge 按变体组去重） */}
        <InputGroup className="rounded-3xl border-foreground/10 bg-background has-[>textarea]:rounded-3xl has-[[data-slot=input-group-control]:focus-visible]:border-foreground/10 has-[[data-slot=input-group-control]:focus-visible]:ring-0">
          <InputGroupTextarea
            value={value}
            onChange={(event) => setValue(event.target.value)}
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
              {/* 模型下拉（空位）：中灰次级色 + 灰小箭头（视觉 diff：底部小字
                整体浅灰，不抢层次），演示名占位 */}
              <Button
                variant="ghost"
                size="xs"
                className="gap-0.5 px-2 text-[13px] text-muted-foreground has-[>svg]:px-2 hover:bg-accent-foreground/5 hover:text-foreground"
              >
                GLM-4.7
                <IconChevronDown className="size-3" />
              </Button>
              {/* 发送：28px 石墨灰圆 + 白箭头（视觉 diff 定稿：参考稿按钮是低
                  饱和石墨灰不是纯黑、直径比 36px 小一档），空输入置灰 */}
              <Button
                size="icon-sm"
                className="size-7 rounded-full bg-foreground/85 hover:bg-foreground"
                aria-label="发送"
                disabled={!value.trim()}
              >
                <IconArrowUp className="size-3.5" />
              </Button>
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
  return (
    <div className="flex h-full min-w-0 flex-col">
      <ChatHeader session={session} tabsCollapsed={tabsCollapsed} onToggleTabs={onToggleTabs} />
      {/* 对话流：已有会话出消息（信息区不显示）；新聊天中段留空（空状态属后续件） */}
      {session.kind === 'chat' ? <ChatMessages /> : <div className="min-h-0 flex-1" />}
      <ChatComposer session={session} />
    </div>
  )
}
