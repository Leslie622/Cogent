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
import { memo, useEffect, useMemo, useRef, useState } from 'react'
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
import { CreateProjectDialog } from './CreateProjectDialog'
import { useChatStore, type SessionSummary } from '@/stores/chat'
import { useProjectStore } from '@/stores/project'
import { useHomeStore } from '@/stores/home'

/** 行 hover 时右侧浮现的动作钮簇；focus-within 兜底键盘聚焦/菜单开着时也可见 */
const ACTIONS =
  'absolute right-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100'

/** 行内动作钮：24px 热区（icon-xs），hover 底比行底再深一档（/15）才可辨 */
const ACTION_BUTTON = 'text-muted-foreground hover:bg-accent-foreground/15 hover:text-foreground'

/** 行 hover / active 底色：黑低透明软叠，active 与 hover 同色（用户定的规则：
    选中态不加深，就是"常驻的 hover 色"，同 ChatGPT）；深度 5% */
const ROW_HOVER = 'bg-transparent transition-colors duration-100 hover:bg-accent-foreground/5'
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
/** memo：展开/收起一个项目时 HomeSidebar 全量重渲染，其余行 props 未变即跳过 */
const ChatRow = memo(function ChatRow({
  chat,
  active,
  indent,
  onSelect,
  onTogglePin,
  onArchive,
  actions
}: {
  chat: SessionSummary
  active: boolean
  indent: boolean
  onSelect: () => void
  onTogglePin: () => void
  /** 归档（回收站语义）：会话从主列表消失，设置页「已归档的聊天」可恢复/删除 */
  onArchive: () => void
  actions?: ReactNode
}) {
  return (
    <div
      className={cn(
        'group relative flex h-8 items-center rounded-md pr-2',
        indent ? 'pl-8' : 'pl-2',
        ROW_HOVER,
        active && ROW_ACTIVE
      )}
    >
      {/* active 只用底色区分不加粗（字重变化引起抖动）；文字一律近黑，层级靠
          底色/分区标题灰 */}
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1.5 pr-12 text-[13px] text-foreground"
        aria-current={active ? 'true' : undefined}
        onClick={onSelect}
      >
        <span className="truncate">{chat.title}</span>
      </button>
      <div className={ACTIONS}>
        {actions ?? (
          <>
            <Button
              variant="ghost"
              size="icon-xs"
              className={ACTION_BUTTON}
              aria-label={chat.pinnedAt ? '取消置顶' : '置顶聊天'}
              onClick={onTogglePin}
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
              onClick={onArchive}
            >
              <IconArchive className="size-4" />
            </Button>
          </>
        )}
      </div>
    </div>
  )
})

/** 项目行 + 展开态的子会话行；文件夹图标旋转过渡（同 svg，不替换实例） */
const ProjectRow = memo(function ProjectRow({
  projectName,
  chats,
  expanded,
  activeSessionId,
  onToggle,
  onSelectSession,
  onStartChat,
  onDeleteProject,
  onArchiveChat,
  onTogglePin,
  pinned
}: {
  projectName: string
  /** 该项目下的会话（chat store 按 projectId 过滤） */
  chats: SessionSummary[]
  expanded: boolean
  activeSessionId: string | null
  onToggle: () => void
  onSelectSession: (id: string) => void
  onStartChat: () => void
  onDeleteProject: () => void
  /** 子会话归栁（回收站语义，下传给 ChatRow） */
  onArchiveChat: (chatId: string) => void
  /** 项目置顶/取消（菜单项接线） */
  onTogglePin: () => void
  pinned: boolean
}) {
  return (
    <>
      <div className={cn('group relative flex h-8 items-center rounded-md px-2', ROW_HOVER)}>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 pr-12 text-[13px] text-foreground"
          aria-expanded={expanded}
          onClick={onToggle}
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
              会话落回"最近"，见 docs/计划-工作区与会话真实化.md 第 4 步） */}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon-xs" className={ACTION_BUTTON} aria-label="更多" />}
            >
              <IconDots className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" sideOffset={2}>
              <DropdownMenuItem onClick={onTogglePin}>
                {pinned ? <IconPinFilled className="size-[17px]" /> : <IconPin className="size-[17px]" />}
                {pinned ? '取消置顶' : '置顶'}
              </DropdownMenuItem>
              <DropdownMenuItem>
                <IconPencil className="size-[17px]" />
                编辑
              </DropdownMenuItem>
              <DropdownMenuItem>
                <IconFolderShare className="size-[17px]" />
                在资源管理器中打开
              </DropdownMenuItem>
              <DropdownMenuItem>
                <IconArchive className="size-[17px]" />
                归档聊天
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onDeleteProject}>
                <IconTrash className="size-[17px]" />
                移除项目
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon-xs"
            className={ACTION_BUTTON}
            aria-label="新建聊天"
            onClick={onStartChat}
          >
            <IconMessagePlus className="size-4" />
          </Button>
        </div>
      </div>
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
                onSelect={() => onSelectSession(chat.id)}
                onArchive={() => onArchiveChat(chat.id)}
                onTogglePin={() => void useChatStore.getState().setPinned(chat.id, !chat.pinnedAt)}
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

  // 会话/项目都是引擎真数据：chat store（session.list）+ project store（project.list）
  const sessions = useChatStore((s) => s.sessions)
  const createSession = useChatStore((s) => s.createSession)
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

  /** 行点击 = 真选中（chat.selectSession）+ 视图态对齐（kind:'chat'） */
  const openSession = (chatId: string) => {
    void selectSession(chatId)
    useHomeStore.setState({ session: { kind: 'chat', chatId } })
  }

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
  const startNew = (projectId?: string) => {
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
  }

  /** 归档（回收站语义）：归档的活动会话 → 视图落 kind:'new'（chat store 内已处理） */
  const archiveChat = (chatId: string) => {
    void useChatStore.getState().archive(chatId, true)
  }

  /** 项目置顶/取消（project store 接引擎；移动语义由分区渲染实现） */
  const toggleProjectPin = (projectId: string) => {
    const target = projects.find((p) => p.id === projectId)
    void setPinnedProject(projectId, target?.pinnedAt === undefined)
  }

  const toggleProject = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

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
                    projectName={project.name}
                    chats={byProject(project.id)}
                    expanded={expanded.has(project.id)}
                    activeSessionId={session.kind === 'chat' ? session.chatId : null}
                    onToggle={() => toggleProject(project.id)}
                    onSelectSession={openSession}
                    onStartChat={() => startNew(project.id)}
                    onDeleteProject={() => void removeProject(project.id)}
                    onArchiveChat={archiveChat}
                    onTogglePin={() => toggleProjectPin(project.id)}
                    pinned
                  />
                ))}
                {pinnedChats.map((chat) => (
                  <ChatRow
                    key={chat.id}
                    chat={chat}
                    active={session.kind === 'chat' && session.chatId === chat.id}
                    indent={false}
                    onSelect={() => openSession(chat.id)}
                    onArchive={() => archiveChat(chat.id)}
                    onTogglePin={() => void useChatStore.getState().setPinned(chat.id, !chat.pinnedAt)}
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
                  projectName={project.name}
                  chats={byProject(project.id)}
                  expanded={expanded.has(project.id)}
                  activeSessionId={session.kind === 'chat' ? session.chatId : null}
                  onToggle={() => toggleProject(project.id)}
                  onSelectSession={openSession}
                  onStartChat={() => startNew(project.id)}
                  onDeleteProject={() => void removeProject(project.id)}
                  onArchiveChat={archiveChat}
                  onTogglePin={() => toggleProjectPin(project.id)}
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
                  onSelect={() => openSession(chat.id)}
                  onArchive={() => archiveChat(chat.id)}
                  onTogglePin={() => void useChatStore.getState().setPinned(chat.id, !chat.pinnedAt)}
                />
              ))
            ) : (
              <EmptyHint text="暂无聊天" />
            ))}
        </section>
      </div>

      {/* 创建成功 → 主体落该项目下的新会话（startNew 自带同项目空会话复用，
          信息区回显项目卡）+ 展开其分区 */}
      <CreateProjectDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(projectId) => {
          setExpanded((prev) => new Set(prev).add(projectId))
          startNew(projectId)
        }}
      />
    </div>
  )
}
