/**
 * content-sidebar 的首页内容（UI 件 4）：Agent 对话导航。头部（路由标题：首页用
 * 应用名 Cogent + 右侧搜索钮）+ 列表四段：① 新聊天整行动作项 ② 置顶分区
 * （被置顶的会话集中放这里）③ 项目分区（两级：项目行 → 子聊天）④ 最近分区
 * （一级聊天行）。
 * 分区标题带折叠箭头（折叠态常显、展开态 hover 显现；展开=下、收起=右，-rotate-90 旋转过渡），
 * 标题行 hover 浮现 [更多 ⋯ + 创建类] 双钮（项目=创建项目、最近=新建聊天；
 * 置顶分区只要更多一个）；项目行 = 文件夹开/合图标随子列表展开态翻转 +
 * hover 浮现 [更多 + 新建聊天] 双钮，更多出菜单（置顶/编辑/在资源管理器中打开/
 * 归档聊天/移除项目），行点击展开/收起子聊天；聊天行里只有项目子项缩进
 * （pl-8 对齐父级文字），置顶/最近项 pl-2 与分区标题文字对齐。
 * 高亮色阶（浅灰底太浅的统一修正）：行 hover = accent-foreground/10，
 * active = /15 且不加粗（底色深浅区分，不动字重），行内动作钮 hover = /15
 * （比行底再深一档，钮在行上才可辨）。数据静态样例、动作全空位 —— 项目/聊天
 * CRUD 属引擎后续件。
 * 布局手法：行 = 相对定位容器（hover 底色 + group），主点击区是占满的
 * button，动作钮 absolute 贴其右 —— 避免 button 嵌 button（非法结构），
 * 也无需 stopPropagation。
 */
import type { ReactNode } from 'react'
import { useState } from 'react'
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
import { useHomeStore } from '@/stores/home'
import { PINNED, PROJECTS, RECENT, type ChatSummary, type ProjectSummary } from './data'

/** 行 hover 时右侧浮现的动作钮簇；focus-within 兜底键盘聚焦/菜单开着时也可见 */
const ACTIONS =
  'absolute right-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100'

/** 行内动作钮：24px 热区（icon-xs），hover 底比行底再深一档（/15）才可辨 */
const ACTION_BUTTON = 'text-muted-foreground hover:bg-accent-foreground/15 hover:text-foreground'

/** 行 hover / active 底色：黑低透明软叠，active 与 hover 同色（用户定的规则：
    选中态不加深，就是"常驻的 hover 色"，同 ChatGPT）；深度 5% */
const ROW_HOVER = 'hover:bg-accent-foreground/5'
const ROW_ACTIVE = 'bg-accent-foreground/5'

/** 分区标题行：标题 + 折叠箭头（hover 显现，展开=下/收起=右旋转过渡） */
function SectionHeader({
  title,
  open,
  onToggle,
  actions,
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
        {/* 折叠箭头：折叠态常显（折叠了 = 有藏起的内容，箭头是展开示意，不能藏）；
            展开态纯 hover 显形 —— 不能挂 focus-within 兜底：点击标题后焦点留在
            按钮上，鼠标移开箭头会赖着不灭（用户实测踩坑）。键盘场景由按钮自身的
            focus ring 兜底即可。展开=下、收起=-90° 指右，旋转过渡；opacity 藏
            而非条件渲染 —— 占位恒定，标题文字不随显隐跳动 */}
        <IconChevronDown
          className={cn(
            'size-[13px] shrink-0 transition-all',
            open && 'opacity-0 group-hover:opacity-100',
            !open && '-rotate-90',
          )}
        />
      </button>
      <div className={ACTIONS}>{actions}</div>
    </div>
  )
}

/**
 * 聊天行：indent 区分层级（项目子项=true 缩进对齐父级文字，置顶/最近=false
 * 与分区标题文字对齐）；actions 可换右侧 hover 钮簇（默认 [置顶 + 归档]）
 */
function ChatRow({
  chat,
  active,
  indent,
  onSelect,
  actions,
}: {
  chat: ChatSummary
  active: boolean
  indent: boolean
  onSelect: () => void
  actions?: ReactNode
}) {
  return (
    <div
      className={cn(
        'group relative flex h-8 items-center rounded-md pr-2',
        indent ? 'pl-8' : 'pl-2',
        ROW_HOVER,
        active && ROW_ACTIVE,
      )}
    >
      {/* active 只用底色区分，不加粗（字重变化会引起文字抖动）；文字一律近黑
          （对比 ChatGPT：列表主文字深色，层级靠底色/分区标题灰，不靠字色深浅） */}
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
            <Button variant="ghost" size="icon-xs" className={ACTION_BUTTON} aria-label="置顶聊天">
              <IconPin className="size-4" />
            </Button>
            <Button variant="ghost" size="icon-xs" className={ACTION_BUTTON} aria-label="归档聊天">
              <IconArchive className="size-4" />
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

/** 项目行 + 展开态的子聊天行；文件夹图标开/合随展开态翻转 */
function ProjectRow({
  project,
  expanded,
  activeChat,
  onToggle,
  onSelectChat,
  onStartChat,
}: {
  project: ProjectSummary
  expanded: boolean
  /** 新聊天进行中时无选中行（null） */
  activeChat: string | null
  onToggle: () => void
  onSelectChat: (id: string) => void
  /** 项目内"新建聊天"：带项目发起（主体信息区回显该项目） */
  onStartChat: () => void
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
          {expanded ? (
            <IconFolderOpen className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <IconFolder className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{project.name}</span>
        </button>
        <div className={ACTIONS}>
          {/* 更多：项目级菜单（项动作空位）；base-ui 触发器用 render 挂到 Button */}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className={ACTION_BUTTON}
                  aria-label="更多"
                />
              }
            >
              <IconDots className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" sideOffset={2}>
              <DropdownMenuItem>
                <IconPin className="size-[17px]" />
                置顶
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
              <DropdownMenuItem>
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
      {expanded &&
        project.chats.map((chat) => (
          <ChatRow
            key={chat.id}
            chat={chat}
            active={activeChat === chat.id}
            indent
            onSelect={() => onSelectChat(chat.id)}
          />
        ))}
    </>
  )
}

export function HomeSidebar() {
  const [pinnedOpen, setPinnedOpen] = useState(true)
  const [projectsOpen, setProjectsOpen] = useState(true)
  const [recentOpen, setRecentOpen] = useState(true)
  // 展开的项目集合（Set.has 出布尔，免查表兜底）；首个项目默认展开
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(['p-cogent']))
  // 会话选择走 home store（与 HomeChat 共享）：行 active 只看已有会话态，
  // 新聊天进行中（session.kind === 'new'）时无行选中
  const session = useHomeStore((s) => s.session)
  const openChat = useHomeStore((s) => s.openChat)
  const startNewChat = useHomeStore((s) => s.startNewChat)
  const activeChat = session.kind === 'chat' ? session.chatId : null

  const toggleProject = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="flex h-full flex-col">
      {/* 头部：路由标题（首页 = 应用名）+ 搜索钮（行为空位）。
          size-7 覆盖 icon-xs 的 24px：16px 图标留 6px 内边距；
          hover 底与行内动作钮同档（accent-foreground/10） */}
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

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {/* 新聊天：整行动作项（图标与行内"新建聊天"同款）→ 无项目发起，
            主体信息区出"选择项目" */}
        <button
          type="button"
          onClick={() => startNewChat()}
          className={cn(
            'flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-foreground',
            ROW_HOVER,
          )}
        >
          <IconMessagePlus className="size-4 text-muted-foreground" />
          新聊天
        </button>

        {/* 置顶分区：置顶会话集中地；title 与行 hover 都只要一个更多（动作空位） */}
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
            PINNED.map((chat) => (
              <ChatRow
                key={chat.id}
                chat={chat}
                active={activeChat === chat.id}
                indent={false}
                onSelect={() => openChat(chat.id)}
                actions={
                  <Button variant="ghost" size="icon-xs" className={ACTION_BUTTON} aria-label="更多">
                    <IconDots className="size-4" />
                  </Button>
                }
              />
            ))}
        </section>

        {/* 项目分区：两级结构（项目 → 子聊天） */}
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
                >
                  <IconFolderPlus className="size-4" />
                </Button>
              </>
            }
          />
          {projectsOpen &&
            PROJECTS.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                expanded={expanded.has(project.id)}
                activeChat={activeChat}
                onToggle={() => toggleProject(project.id)}
                onSelectChat={openChat}
                onStartChat={() => startNewChat(project.id)}
              />
            ))}
        </section>

        {/* 最近分区：一级聊天行（与分区标题对齐）；置顶过的会话不在此重复 */}
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
                {/* 最近无项目归属：同顶部"新聊天" = 无项目发起，信息区出"选择项目" */}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className={ACTION_BUTTON}
                  aria-label="新建聊天"
                  onClick={() => startNewChat()}
                >
                  <IconMessagePlus className="size-4" />
                </Button>
              </>
            }
          />
          {recentOpen &&
            RECENT.filter((chat) => !chat.pinned).map((chat) => (
              <ChatRow
                key={chat.id}
                chat={chat}
                active={activeChat === chat.id}
                indent={false}
                onSelect={() => openChat(chat.id)}
              />
            ))}
        </section>
      </div>
    </div>
  )
}
