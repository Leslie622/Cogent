/**
 * content-sidebar 的首页内容（UI 件 4 → 2026-11-09 真实化）：Agent 对话导航。
 * 头部（路由标题：首页用应用名 Cogent + 右侧搜索钮）+ 列表四段：① 新聊天整行
 * 动作项 ② 置顶分区（pinnedAt 会话，按置顶时间倒序）③ 项目分区（两级：项目行
 * → 子会话，project store 真数据）④ 最近分区（一级会话行，按 updatedAt 倒序）。
 *
 * 数据源全部真实（演示域 data.ts 已退役）：会话 = chat store（引擎 session.list），
 * 项目 = project store（引擎 project.list）。行点击 = chat.selectSession（高亮看
 * activeSessionId，行与内容不再错位）；发起入口 startNew = chat.createSession
 * （真建引擎会话防串话，见 docs/技术笔记/pi-agent-integration-isolation.md）+
 * home.startNewChat（视图态）。
 * 分区标题带折叠箭头（折叠态常显、展开态 hover 显现）；标题行 hover 浮现
 * [更多 ⋯ + 创建类] 双钮（项目=创建项目弹窗、最近=新建聊天）；项目行 hover
 * 浮现 [更多 + 新建聊天]；聊天行动作 [置顶 + 归档]（置顶真接线 setPinned，
 * 归档仍空位）。
 * 布局手法：行 = 相对定位容器（hover 底色 + group），主点击区是占满的 button，
 * 动作钮 absolute 贴其右 —— 避免 button 嵌 button（非法结构）。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconArchive,
  IconChevronDown,
  IconDots,
  IconFolder,
  IconFolderOpen,
  IconFolderPlus,
  IconFolderShare,
  IconMessagePlus,
  IconPencil,
  IconPin,
  IconPinFilled,
  IconSearch,
  IconTrash,
} from '@tabler/icons-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { ProjectDialog } from './ProjectDialog'
import { useChatStore, type SessionSummary } from '@/stores/chat'
import { useProjectStore } from '@/stores/project'
import { useHomeStore } from '@/stores/home'

/** 行 hover 时右侧浮现的动作钮簇；focus-within 兜底键盘聚焦时也可见。
    菜单开着时也保持显现（2026-11-11 用户反馈）：右键菜单开着 = trigger（行 div
    自身）带 data-popup-open → group-data-popup-open；行内「更多」dropdown 开着 =
    子 trigger 带 data-popup-open → group-has 兜住（此时焦点已被 Base UI 移进
    弹层，focus-within 不可靠，不能只靠它） */
const ACTIONS =
  'absolute right-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 group-data-popup-open:opacity-100 group-has-[[data-popup-open]]:opacity-100'

/** 行内动作钮：24px 热区（icon-xs），hover 底比行底再深一档（/15）才可辨 */
const ACTION_BUTTON = 'text-muted-foreground hover:bg-accent-foreground/15 hover:text-foreground'

/** 行 hover / active 底色：黑低透明软叠，active 与 hover 同色（用户定的规则：
    选中态不加深，就是"常驻的 hover 色"，同 ChatGPT）；深度 5% */
/** 菜单开着时同色保持（2026-11-11 用户反馈：右键/「更多」菜单弹出后鼠标移出行，
    高亮就掉了）：data-popup-open = 行自身是右键菜单 trigger（开着即挂）；
    has-[[data-popup-open]] = 行内有 dropdown trigger 开着（项目行「更多」）——
    :has() 只看后代、匹配不到元素自身，两条各管一头，缺一不可 */
const ROW_HOVER =
  'bg-transparent transition-colors duration-100 hover:bg-accent-foreground/5 data-popup-open:bg-accent-foreground/5 has-[[data-popup-open]]:bg-accent-foreground/5'
const ROW_ACTIVE = 'bg-accent-foreground/5'

/** 分区标题行：标题 + 折叠箭头（hover 显现，展开=下/收起=右旋转过渡） */
function SectionHeader({
  title,
  open,
  onToggle,
  actions
}: {
  title: string
  open: boolean
  onToggle: () => void
  actions: ReactNode
}) {
  return (
    <div className={cn('group relative flex h-7 items-center rounded-md px-2', ROW_HOVER)}>
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1 pr-12 text-sm text-muted-foreground"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span>{title}</span>
        {/* 折叠箭头：折叠态常显（折叠了 = 有藏起的内容）；展开态纯 hover 显形 ——
            不能挂 focus-within（点击后焦点留住，箭头赖着不灭，用户实测踩坑）。
            opacity 藏而非条件渲染 —— 占位恒定，标题文字不随显隐跳动 */}
        <IconChevronDown
          className={cn(
            'size-[13px] shrink-0 transition-all',
            open && 'opacity-0 group-hover:opacity-100',
            !open && '-rotate-90'
          )}
        />
      </button>
      <div className={ACTIONS}>{actions}</div>
    </div>
  )
}

/** 空态行（分区无内容时的弱提示，替代旧演示数据的"永远有内容"） */
function EmptyHint({ text }: { text: string }) {
  return <div className="px-2 py-1.5 text-[13px] text-muted-foreground/80">{text}</div>
}

/**
 * 聊天行：indent 区分层级（项目子项=true 缩进对齐父级文字）；actions 可换右侧
 * hover 钮簇（默认 [置顶 + 归档]，置顶按 pinnedAt 二态切换图标）
 */
/** memo：展开/收起一个项目时 HomeSidebar 全量重渲染，其余行 props 未变即跳过。
    回调全部是 id 签名（父组件 useCallback 稳定引用）—— 若父组件传内联箭头
    包住行 id，浅比较每次必败，memo 形同虚设（本注释承诺的优化从未生效过的教训） */
const ChatRow = memo(function ChatRow({
  chat,
  active,
  indent,
  onSelect,
  onTogglePin,
  onArchive,
  actions,
  waitingApproval
}: {
  chat: SessionSummary
  active: boolean
  indent: boolean
  onSelect: (chatId: string) => void
  /** 置顶二值切换；目标态由行内计算（chat.pinnedAt 在场 = 当前已置顶） */
  onTogglePin: (chatId: string, pinned: boolean) => void
  /** 归档（回收站语义）：会话从主列表消失，设置页「已归档的聊天」可恢复/删除 */
  onArchive: (chatId: string) => void
  actions?: ReactNode
  /** 等待确认 tag（审批交互升级 D7；2026-11-11 用户定调形态）：会话有挂起
      *  审批即显，**占行尾动作钮簇的位置**（此时置顶/归档钮不渲染 —— 待审批
      *  是行当前的唯一状态，常显不随 hover 隐藏） */
  waitingApproval?: boolean
}) {
  return (
    // 行 div 即右键菜单 trigger（render 注入保留原元素与类）：右键行内任意处
    // （含标题钮/hover 钮）都在指针处弹出；菜单开着 trigger 挂 data-popup-open，
    // ROW_HOVER/ACTIONS 据此保持高亮与钮簇显现
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            className={cn(
              'group relative flex h-8 items-center rounded-md pr-2',
              indent ? 'pl-8' : 'pl-2',
              ROW_HOVER,
              active && ROW_ACTIVE
            )}
          />
        }
      >
        {/* active 只用底色区分不加粗（字重变化引起抖动）；文字一律近黑，层级靠
            底色/分区标题灰；pr-12 给 hover 钮簇让位（待审批时钮簇不在，收窄） */}
        <button
          type="button"
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 text-[13px] text-foreground',
            waitingApproval ? 'pr-2' : 'pr-12'
          )}
          aria-current={active ? 'true' : undefined}
          onClick={() => onSelect(chat.id)}
        >
          <span className="truncate">{chat.title}</span>
        </button>
        {waitingApproval ? (
          // 浅绿底 + 实色深绿字（文字色纪律：透明度只许用在背景）+ 呼吸点
          // （控制台 timeline 同款 pulse 语言，「进行中」感）
          <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-700">
            <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
            等待确认
          </span>
        ) : (
          <div className={ACTIONS}>
            {actions ?? (
              <>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className={ACTION_BUTTON}
                  aria-label={chat.pinnedAt ? '取消置顶' : '置顶聊天'}
                  onClick={() => onTogglePin(chat.id, chat.pinnedAt === undefined)}
                >
                  {chat.pinnedAt ? <IconPinFilled className="size-4" /> : <IconPin className="size-4" />}
                </Button>
                {/* 归档 = 回收站语义（软删）：会话从主列表消失，设置页「已归档的
                    聊天」可恢复/彻底删除 */}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className={ACTION_BUTTON}
                  aria-label="归档聊天"
                  onClick={() => onArchive(chat.id)}
                >
                  <IconArchive className="size-4" />
                </Button>
              </>
            )}
          </div>
        )}
      </ContextMenuTrigger>
      {/* 右键菜单项 = hover 钮同权动作（置顶/归档），主入口一个不少 */}
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onTogglePin(chat.id, chat.pinnedAt === undefined)}>
          {chat.pinnedAt ? <IconPinFilled className="size-[17px]" /> : <IconPin className="size-[17px]" />}
          {chat.pinnedAt ? '取消置顶' : '置顶'}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onArchive(chat.id)}>
          <IconArchive className="size-[17px]" />
          归档聊天
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
})

/** 项目行 + 展开态的子会话行；文件夹图标旋转过渡（同 svg，不替换实例）。
    回调同为 id 签名 + 父组件稳定引用（memo 生效前提，同 ChatRow 注释） */
const ProjectRow = memo(function ProjectRow({
  projectId,
  projectName,
  chats,
  expanded,
  activeSessionId,
  onToggle,
  onSelectSession,
  onStartChat,
  onDeleteProject,
  onEditProject,
  onArchiveChat,
  onTogglePin,
  isWaitingApproval,
  pinned
}: {
  projectId: string
  projectName: string
  /** 该项目下的会话（chat store 按 projectId 过滤） */
  chats: SessionSummary[]
  expanded: boolean
  activeSessionId: string | null
  onToggle: (projectId: string) => void
  onSelectSession: (chatId: string) => void
  onStartChat: (projectId: string) => void
  onDeleteProject: (projectId: string) => void
  /** 编辑项目（菜单项接线 → HomeSidebar 开编辑弹窗） */
  onEditProject: (projectId: string) => void
  /** 子会话归档（回收站语义，下传给 ChatRow） */
  onArchiveChat: (chatId: string) => void
  /** 项目置顶/取消（菜单项接线） */
  onTogglePin: (projectId: string) => void
  /** 会话是否有挂起审批（等待确认 tag，D7；下传给子 ChatRow） */
  isWaitingApproval: (chatId: string) => boolean
  pinned: boolean
}) {
  // 子会话置顶回调：行内 useCallback —— ProjectRow 自身少渲染，但真渲染时
  // 也不能让全部子 ChatRow 因新闭包而陪跑
  const handleToggleChatPin = useCallback((chatId: string, next: boolean) => {
    void useChatStore.getState().setPinned(chatId, next)
  }, [])

  /** 项目动作清单：「更多」dropdown 与右键 context menu 双入口同权同项 ——
      抽成单一数据源，两处 map 各配自己的 Item 组件，防两份手抄漂移。
      归档仍是空位，接线时改这里即可；「编辑」= 改名弹窗（引擎只有 rename，
      目录增删无通道）；「在资源管理器中打开」走 main 侧 shell.openPath
      （renderer 不碰文件系统，contextIsolation 纪律） */
  const actions = [
    {
      key: 'pin',
      icon: pinned ? <IconPinFilled className="size-[17px]" /> : <IconPin className="size-[17px]" />,
      label: pinned ? '取消置顶' : '置顶',
      onClick: () => onTogglePin(projectId)
    },
    { key: 'edit', icon: <IconPencil className="size-[17px]" />, label: '编辑', onClick: () => onEditProject(projectId) },
    {
      key: 'reveal',
      icon: <IconFolderShare className="size-[17px]" />,
      label: '在资源管理器中打开',
      // 打开项目主根目录（cwds 首个 = 创建时选的主根）。打开失败（目录已删等）
      // 是外部世界常态：错误串打到控制台即可诊断，不弹不打断菜单流
      onClick: () => {
        const project = useProjectStore.getState().projects.find((p) => p.id === projectId)
        if (project !== undefined) {
          void window.cogent.openPath(project.cwds[0]).then((error) => {
            if (error !== null) console.error(`打开项目目录失败：${error}`)
          })
        }
      }
    },
    { key: 'archive', icon: <IconArchive className="size-[17px]" />, label: '归档聊天' },
    { key: 'remove', icon: <IconTrash className="size-[17px]" />, label: '移除项目', onClick: () => onDeleteProject(projectId) }
  ]

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger
          render={<div className={cn('group relative flex h-8 items-center rounded-md px-2', ROW_HOVER)} />}
        >
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 pr-12 text-[13px] text-foreground"
            aria-expanded={expanded}
            onClick={() => onToggle(projectId)}
          >
            {/* 文件夹开/合两形态（IconFolder/IconFolderOpen，恢复此前语义）+
                CrossFade：两个 svg 叠放，透明度交叉渐变 150ms —— 不回到三元
                瞬跳（那是闪动参与因子之一），也不像旋转那样丢掉"打开"形态 */}
            <span className="relative size-4 shrink-0">
              <IconFolder
                className={cn(
                  'absolute inset-0 size-4 text-muted-foreground transition-opacity duration-150',
                  expanded && 'opacity-0'
                )}
              />
              <IconFolderOpen
                className={cn(
                  'absolute inset-0 size-4 text-muted-foreground transition-opacity duration-150',
                  !expanded && 'opacity-0'
                )}
              />
            </span>
            <span className="truncate">{projectName}</span>
          </button>
          <div className={ACTIONS}>
            {/* 更多：项目级菜单；「移除项目」只删项目不级联删会话（引擎 delete 语义，
                会话落回"最近"，见 docs/计划-工作区与会话真实化.md 第 4 步）。
                菜单项来自上方 actions 数据源（与右键菜单同权同项） */}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon-xs" className={ACTION_BUTTON} aria-label="更多" />}
              >
                <IconDots className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" sideOffset={2}>
                {actions.map(({ key, icon, label, onClick }) => (
                  <DropdownMenuItem key={key} onClick={onClick}>
                    {icon}
                    {label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="ghost"
              size="icon-xs"
              className={ACTION_BUTTON}
              aria-label="新建聊天"
              onClick={() => onStartChat(projectId)}
            >
              <IconMessagePlus className="size-4" />
            </Button>
          </div>
        </ContextMenuTrigger>
        {/* 右键菜单：与「更多」dropdown 同一组动作（actions 数据源），双入口同权 */}
        <ContextMenuContent>
          {actions.map(({ key, icon, label, onClick }) => (
            <ContextMenuItem key={key} onClick={onClick}>
              {icon}
              {label}
            </ContextMenuItem>
          ))}
        </ContextMenuContent>
      </ContextMenu>
      {/* 展开子区：单一容器条件渲染（内部才变），不做三元结构跳变 —— 此前
          chats.map(...) ↔ EmptyHint 两种结构在 Fragment 同一位置互换，React 按
          "不同类型"整棵卸载重建，点击展开/收起时列表闪一下（用户实测）。另：
          文件夹图标开/合用 CSS 旋转过渡而非换组件 —— IconFolder/IconFolderOpen
          是两个组件实例，三元切换 = svg 元素替换，也参与闪动。收起态旋转
          -90°（icon 语义同分区折叠箭头：闭=指右，开=指下） */}
      {expanded && (
        <div className="flex flex-col gap-0.5">
          {chats.length > 0 ? (
            chats.map((chat) => (
              <ChatRow
                key={chat.id}
                chat={chat}
                active={activeSessionId === chat.id}
                indent
                onSelect={onSelectSession}
                onArchive={onArchiveChat}
                onTogglePin={handleToggleChatPin}
                waitingApproval={isWaitingApproval(chat.id)}
              />
            ))
          ) : (
            <EmptyHint text="项目下还没有聊天" />
          )}
        </div>
      )}
    </>
  )
})

export function HomeSidebar() {
  const [pinnedOpen, setPinnedOpen] = useState(true)
  const [projectsOpen, setProjectsOpen] = useState(true)
  const [recentOpen, setRecentOpen] = useState(true)
  // 展开的项目集合；首个项目默认展开（项目列表加载后补一次）
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  // 创建项目弹窗（入口 = 项目分区标题的「创建项目」钮）
  const [createOpen, setCreateOpen] = useState(false)
  // 编辑项目弹窗（入口 = 项目行菜单「编辑」）：持 projectId 而非布尔 —— key
  // 之用，弹窗每次打开都是全新实例（name 初值从 store 取，免手写重置）
  const [editProjectId, setEditProjectId] = useState<string | null>(null)

  // 会话/项目都是引擎真数据：chat store（session.list）+ project store（project.list）
  const sessions = useChatStore((s) => s.sessions)
  const createSession = useChatStore((s) => s.createSession)
  // 等待确认 tag 的派生源（D7）：pendingApprovalsBySession 非空即显。函数签名
  // 下传（useCallback 稳定引用保 ProjectRow/ChatRow memo；pending 变化只让
  // 涉事行因 waitingApproval 布尔翻转而重渲染）
  const pendingApprovals = useChatStore((s) => s.pendingApprovalsBySession)
  const isWaitingApproval = useCallback(
    (chatId: string): boolean => (pendingApprovals[chatId]?.length ?? 0) > 0,
    [pendingApprovals]
  )
  // 行点击真选中：selectSession 拉历史 + 置 activeSessionId（HomeChat 呈现源）——
  // 此前只切 home 视图态不选会话，行与内容错位（真实化要修的核心之一）
  const selectSession = useChatStore((s) => s.selectSession)
  const projects = useProjectStore((s) => s.projects)
  const loadProjects = useProjectStore((s) => s.load)
  const removeProject = useProjectStore((s) => s.remove)
  const setPinnedProject = useProjectStore((s) => s.setPinned)
  // 视图态只管"新聊天进行中"的信息区/无行选中；chat 行高亮直接看 chat store 的
  // activeSessionId（选中后两者同源同变）
  const session = useHomeStore((s) => s.session)
  const startNewChat = useHomeStore((s) => s.startNewChat)

  /** 行点击 = 真选中（chat.selectSession）+ 视图态对齐（kind:'chat'）。
      动作回调一律 useCallback（依赖只有 store action 稳定引用）：这是
      ChatRow/ProjectRow memo 生效的前提 —— 内联闭包会让浅比较每次必败 */
  const openSession = useCallback(
    (chatId: string) => {
      void selectSession(chatId)
      useHomeStore.setState({ session: { kind: 'chat', chatId } })
    },
    [selectSession]
  )

  // project store 初载（chat store 由 App 挂载时 load；项目此前无入口，这里补）
  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  // 首个项目默认展开：只在项目列表**首次落定**时补一次（ref 锁），此后展开集
  // 完全归用户操作管。此前条件写 "expanded.size === 0 就补"——收起唯一展开的
  // 项目时 size 归 0，effect 立即又自动展开 → 项目根本折不起来、点击闪一下
  // （effect 与用户操作打架，2026-11-09 折叠失效的真凶）
  const defaultExpandedDone = useRef(false)
  useEffect(() => {
    if (!defaultExpandedDone.current && projects.length > 0) {
      defaultExpandedDone.current = true
      setExpanded(new Set([projects[0].id]))
    }
  }, [projects])

  // 分区数据派生（全从真数据来）。置顶 = **移动语义**（用户 2026-11-09 拍板，
  // 对齐 ChatGPT）：被置顶的会话/项目从原分区消失，只在置顶分区出现——置顶是
  // "把最常用的东西放到最上面"，原处重复反而噪音；取消置顶即回原分区。
  // 置顶分区 = 会话 + 项目混合，各自按 pinnedAt 倒序（新置顶在上）
  const pinnedChats = sessions
    .filter((s) => s.pinnedAt !== undefined)
    .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0))
  const pinnedProjects = projects
    .filter((p) => p.pinnedAt !== undefined)
    .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0))
  // 项目分区排除已置顶（移动语义）；子会话按归属过滤 + updatedAt 倒序。
  // byProject 做成 useMemo 的查表 Map：此前是每次 render 调用的函数，返回新数组
  // 引用 → ProjectRow/ChatRow 的 memo 全部失效（props 每次都"变"），任何一次
  // setExpanded 都让整棵列表树重渲染（闪动的参与因子之一）
  const listedProjects = projects.filter((p) => p.pinnedAt === undefined)
  // 编辑弹窗的目标（菜单打开时行在渲染 = store 必有；编辑中项目被删则 undefined
  // → 弹窗条件渲染自然消失）
  const editingProject = editProjectId !== null ? projects.find((p) => p.id === editProjectId) : undefined
  const chatsByProject = useMemo(() => {
    const map = new Map<string, SessionSummary[]>()
    for (const project of projects) {
      map.set(
        project.id,
        sessions.filter((s) => s.projectId === project.id).sort((a, b) => b.updatedAt - a.updatedAt)
      )
    }
    return map
  }, [projects, sessions])
  const byProject = (projectId: string) => chatsByProject.get(projectId) ?? []
  // 最近 = 无归属且未置顶的会话（移动语义下不重复）
  const recent = sessions
    .filter((s) => s.projectId === undefined && s.pinnedAt === undefined)
    .sort((a, b) => b.updatedAt - a.updatedAt)

  // 发起新聊天 = 视图态切 kind:'new' + （按需）真建引擎会话。主流语义（ChatGPT
  // 同款）：**当前会话还是空的（没发过任何消息）时不再堆一个新空会话**，直接
  // 复用 —— 否则连点 N 次新聊天就攒 N 个「新会话」垃圾；空会话复用到它发出
  // 首条消息为止。带 projectId = 项目内发起（继承项目 cwd）；项目场景不复用
  // 非本项目会话（挂错归属），但可复用同项目下的空会话
  const startNew = useCallback(
    (projectId?: string) => {
      const state = useChatStore.getState()
      const active = state.sessions.find((s) => s.id === state.activeSessionId)
      const activeIsEmpty =
        active !== undefined &&
        (state.messagesBySession[active.id]?.length ?? 0) === 0 &&
        active.title === '新会话' && // 双保险：转录空 + 标题未命名（防投影延迟误判）
        (projectId === undefined ? active.projectId === undefined : active.projectId === projectId)
      if (!activeIsEmpty) {
        void createSession(projectId !== undefined ? { projectId } : undefined)
      }
      startNewChat(projectId)
    },
    [createSession, startNewChat]
  )

  /** 归档（回收站语义）：归档的活动会话 → 视图落 kind:'new'（chat store 内已处理） */
  const archiveChat = useCallback((chatId: string) => {
    void useChatStore.getState().archive(chatId, true)
  }, [])

  /** 会话置顶二值切换（id 签名直传 ChatRow） */
  const toggleChatPin = useCallback((chatId: string, pinned: boolean) => {
    void useChatStore.getState().setPinned(chatId, pinned)
  }, [])

  /** 删除项目（不级联删会话，引擎 delete 语义）；id 签名直传 ProjectRow */
  const deleteProject = useCallback(
    (projectId: string) => {
      void removeProject(projectId)
    },
    [removeProject]
  )

  /** 编辑项目（开改名弹窗）；id 签名 + 稳定引用（ProjectRow memo 前提） */
  const editProject = useCallback((projectId: string) => {
    setEditProjectId(projectId)
  }, [])

  /** 项目置顶/取消（project store 接引擎；移动语义由分区渲染实现）。
      查找走 getState 快照而非闭包捕获 projects —— 依赖数组少一项，引用更稳定 */
  const toggleProjectPin = useCallback(
    (projectId: string) => {
      const target = useProjectStore.getState().projects.find((p) => p.id === projectId)
      void setPinnedProject(projectId, target?.pinnedAt === undefined)
    },
    [setPinnedProject]
  )

  const toggleProject = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  return (
    <div className="flex h-full flex-col">
      {/* 头部：路由标题（首页 = 应用名）+ 搜索钮（行为空位） */}
      <div className="flex h-12 shrink-0 items-center justify-between pl-4 pr-2.5">
        <span className="text-[16px] font-semibold">Cogent</span>
        <Button
          variant="ghost"
          size="icon-xs"
          className="size-7 text-muted-foreground hover:bg-accent-foreground/7 hover:text-foreground"
          aria-label="搜索"
        >
          <IconSearch className="size-4" />
        </Button>
      </div>

      {/* scrollbar-gutter-stable：内容超/不超一屏时滚动条空间常驻预留 —— 项目
          展开/收起会跨越"是否出滚动条"的临界点，无预留时 13px 滚动条突然出现
          会把整列内容向左挤一下（用户实测点击项目的"抖动"）。工具类是 message
          -scroller 同款（globals.css .scrollbar-gutter-stable） */}
      <div className="scrollbar-gutter-stable min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {/* 新聊天：整行动作项 → 无项目发起，主体信息区出"选择项目" */}
        <button
          type="button"
          onClick={() => startNew()}
          className={cn(
            'flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-foreground',
            ROW_HOVER
          )}
        >
          <IconMessagePlus className="size-4 text-muted-foreground" />
          新聊天
        </button>

        {/* 置顶分区：会话 + 项目混合（移动语义，各自 pinnedAt 倒序）。
            项目行复用 ProjectRow（完整动作簇：更多菜单/新建聊天/置顶菜单）——
            此前手搓紧凑行丢了右侧按钮（用户发现），复用才是对的：置顶只是
            换个分区渲染，行本身的能力不该变。子会话展开就地可见 */}
        <section className="mt-4 flex flex-col gap-0.5">
          <SectionHeader
            title="置顶"
            open={pinnedOpen}
            onToggle={() => setPinnedOpen((v) => !v)}
            actions={
              <Button variant="ghost" size="icon-xs" className={ACTION_BUTTON} aria-label="更多">
                <IconDots className="size-4" />
              </Button>
            }
          />
          {pinnedOpen &&
            (pinnedProjects.length + pinnedChats.length > 0 ? (
              <>
                {pinnedProjects.map((project) => (
                  <ProjectRow
                    key={project.id}
                    projectId={project.id}
                    projectName={project.name}
                    chats={byProject(project.id)}
                    expanded={expanded.has(project.id)}
                    activeSessionId={session.kind === 'chat' ? session.chatId : null}
                    onToggle={toggleProject}
                    onSelectSession={openSession}
                    onStartChat={startNew}
                    onDeleteProject={deleteProject}
                    onEditProject={editProject}
                    onArchiveChat={archiveChat}
                    onTogglePin={toggleProjectPin}
                    isWaitingApproval={isWaitingApproval}
                    pinned
                  />
                ))}
                {pinnedChats.map((chat) => (
                  <ChatRow
                    key={chat.id}
                    chat={chat}
                    active={session.kind === 'chat' && session.chatId === chat.id}
                    indent={false}
                    onSelect={openSession}
                    onArchive={archiveChat}
                    onTogglePin={toggleChatPin}
                    waitingApproval={isWaitingApproval(chat.id)}
                  />
                ))}
              </>
            ) : (
              <EmptyHint text="暂无置顶" />
            ))}
        </section>

        {/* 项目分区：project store 真数据 + 「创建项目」弹窗入口 */}
        <section className="mt-4 flex flex-col gap-0.5">
          <SectionHeader
            title="项目"
            open={projectsOpen}
            onToggle={() => setProjectsOpen((v) => !v)}
            actions={
              <>
                <Button variant="ghost" size="icon-xs" className={ACTION_BUTTON} aria-label="更多">
                  <IconDots className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className={ACTION_BUTTON}
                  aria-label="创建项目"
                  onClick={() => setCreateOpen(true)}
                >
                  <IconFolderPlus className="size-4" />
                </Button>
              </>
            }
          />
          {projectsOpen &&
            (listedProjects.length > 0 ? (
              listedProjects.map((project) => (
                <ProjectRow
                  key={project.id}
                  projectId={project.id}
                  projectName={project.name}
                  chats={byProject(project.id)}
                  expanded={expanded.has(project.id)}
                  activeSessionId={session.kind === 'chat' ? session.chatId : null}
                  onToggle={toggleProject}
                  onSelectSession={openSession}
                  onStartChat={startNew}
                  onDeleteProject={deleteProject}
                  onEditProject={editProject}
                  onArchiveChat={archiveChat}
                  onTogglePin={toggleProjectPin}
                  isWaitingApproval={isWaitingApproval}
                  pinned={project.pinnedAt !== undefined}
                />
              ))
            ) : (
              <EmptyHint text="还没有项目" />
            ))}
        </section>

        {/* 最近分区：无归属且未置顶的会话（移动语义，置顶的不重复出现） */}
        <section className="mt-4 flex flex-col gap-0.5">
          <SectionHeader
            title="最近"
            open={recentOpen}
            onToggle={() => setRecentOpen((v) => !v)}
            actions={
              <>
                <Button variant="ghost" size="icon-xs" className={ACTION_BUTTON} aria-label="更多">
                  <IconDots className="size-4" />
                </Button>
                {/* 最近无项目归属：同顶部"新聊天" = 无项目发起 */}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className={ACTION_BUTTON}
                  aria-label="新建聊天"
                  onClick={() => startNew()}
                >
                  <IconMessagePlus className="size-4" />
                </Button>
              </>
            }
          />
          {recentOpen &&
            (recent.length > 0 ? (
              recent.map((chat) => (
                <ChatRow
                  key={chat.id}
                  chat={chat}
                  active={session.kind === 'chat' && session.chatId === chat.id}
                  indent={false}
                  onSelect={openSession}
                  onArchive={archiveChat}
                  onTogglePin={toggleChatPin}
                  waitingApproval={isWaitingApproval(chat.id)}
                />
              ))
            ) : (
              <EmptyHint text="暂无聊天" />
            ))}
        </section>
      </div>

      {/* 创建项目（两步流）。创建成功 → 主体落该项目下的新会话（startNew 自带
          同项目空会话复用，信息区回显项目卡）+ 展开其分区 */}
      <ProjectDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(projectId) => {
          setExpanded((prev) => new Set(prev).add(projectId))
          startNew(projectId)
        }}
      />

      {/* 编辑项目：与创建同一张表单（改名 + 目录增删，新加目录才走信任确认）。
          key = projectId 每次打开全新实例（预填即初值免重置）；项目被删
        （编辑中他人移除）则不渲染，弹窗自然消失 */}
      {editingProject !== undefined && (
        <ProjectDialog
          key={editingProject.id}
          open
          project={editingProject}
          onOpenChange={(next) => {
            if (!next) setEditProjectId(null)
          }}
        />
      )}
    </div>
  )
}
