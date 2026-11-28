/**
 * 设置 · 已归档的聊天分区（zcode 对齐：packages/ui/src/project-sidebar/
 * ArchiveManagement.tsx + ArchiveGroupCard.tsx）：主列表按项目分组两级 ——
 * 组行（文件夹 + 名 + 计数 + 组级批量菜单）默认收起，展开出组内聊天行，
 * 开合走 Collapsible 导航变体过渡（自定义布局，不走 SettingsRow）。
 * 数据源 = session.listArchived；分组 / 筛选 / 排序本地做
 * （archive-view.ts 纯函数 + 单测，量级小不进引擎协议）。
 * 恢复 = session.archive(archived:false)（组级批量免确认）；删除 =
 * session.delete（彻底删，转录文件一并清，不可逆 —— 单个 / 组批 / 全部
 * 都过 AlertDialog 确认；引擎无批量方法，串行循环）。「全部永久删除」
 * 删的是当前筛选 + 搜索后的可见集，筛选态文案换「永久删除筛选结果」。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  IconAlertTriangle,
  IconArrowBackUp,
  IconChevronDown,
  IconDots,
  IconFolder,
  IconSearch,
  IconTrash,
} from '@tabler/icons-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingsPage } from './SettingsParts'
import { useChatStore } from '@/stores/chat'
import { useProjectStore } from '@/stores/project'
import {
  buildArchiveGroups,
  buildArchiveProjectOptions,
  type ArchiveGroup,
  type ArchiveSort,
} from './archive-view'
import type { SessionSummary } from '@/env.d'
import { cn } from 'cn'
import { useHoverSlide } from '@/hooks/use-hover-slide'

/** 排序档（label 即 Select 显示文案；组内行序与行内时间共用档位） */
const SORTS = [
  { value: 'updated', label: '更新时间' },
  { value: 'created', label: '创建时间' },
] as const

/** 待确认的删除集（单个 / 组批 / 全部共用一形状，文案按数量生成） */
type DeleteConfirm = { ids: string[] }

export function ArchivedChatsSection() {
  // null = 初载未回（MCP 页同款三态：加载中 / 空 / 列表）
  const [archived, setArchived] = useState<SessionSummary[] | null>(null)
  const [query, setQuery] = useState('')
  const [project, setProject] = useState<string>('all')
  const [sort, setSort] = useState<ArchiveSort>('updated')
  const [confirming, setConfirming] = useState<DeleteConfirm | null>(null)
  // 各分组卡组头之间的悬停滑动（展开的组头自带底色，不停上去）
  const groupsSlide = useHoverSlide()
  const [deleting, setDeleting] = useState(false)
  const sessions = useChatStore((s) => s.sessions)
  const projects = useProjectStore((s) => s.projects)

  // 初载拉归档列表；sessions 变化（恢复动作让会话回主列表）时顺势刷新视图
  const reload = useCallback(async () => {
    const list = await window.cogent.engineRequest('session.listArchived', {})
    setArchived(list)
  }, [])
  useEffect(() => {
    void reload()
  }, [reload, sessions.length])

  const groups = useMemo(
    () => buildArchiveGroups(archived ?? [], projects, { query, sort, project }),
    [archived, projects, query, sort, project]
  )
  const projectOptions = useMemo(
    () => buildArchiveProjectOptions(archived ?? [], projects),
    [archived, projects]
  )
  const visibleIds = useMemo(() => groups.flatMap((g) => g.chats.map((c) => c.id)), [groups])

  // 恢复（回收站非破坏动作，组级批量也免确认）；串行与 reload 对齐真实盘面
  const restore = async (ids: string[]) => {
    setDeleting(true)
    try {
      for (const id of ids) {
        await useChatStore.getState().archive(id, false)
      }
      await reload()
    } finally {
      setDeleting(false)
    }
  }

  const runDelete = async (ids: string[]) => {
    // 串行删（引擎无批量方法）；中途失败让错误冒泡中断，reload 对齐真实盘面
    setDeleting(true)
    try {
      for (const id of ids) {
        await useChatStore.getState().deleteSession(id)
      }
      setConfirming(null)
      await reload()
    } finally {
      setDeleting(false)
    }
  }

  const total = archived?.length ?? 0
  const filtered = query.trim() !== '' || project !== 'all'

  return (
    <SettingsPage
      title="已归档的聊天"
      desc="归档是回收站语义：聊天从主列表移除但转录保留，可恢复或彻底删除。"
      toolbar={
        <>
          {/* 搜索框：与 MCP 页同款裸 input 手搭（黑 5% 软叠底）；圆角 lg 档与表单控件统一 */}
          <div className="flex h-8 w-52 items-center gap-2 rounded-lg bg-accent-foreground/5 px-3">
            <IconSearch className="size-4 shrink-0 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索已归档聊天"
              className="h-full w-full min-w-0 bg-transparent text-sm text-foreground outline-none placeholder:text-placeholder"
            />
          </div>
          {/* 静态标签放触发框外（zcode 同款）：框内只留选中值与下拉箭头 */}
          <div className="text-sm text-muted-foreground">排序方式</div>
          <Select value={sort} items={SORTS} onValueChange={(next) => {
            if (next !== null) setSort(next)
          }}>
            <SelectTrigger size="default" aria-label="排序方式">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start">
              <SelectGroup>
                {SORTS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {/* 项目筛选：SelectValue 按 items 映射显示当前项 label */}
          <Select
            value={project}
            items={projectOptions}
            onValueChange={(next) => {
              if (next !== null) setProject(next)
            }}
          >
            <SelectTrigger size="default" aria-label="按项目筛选">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start">
              <SelectGroup>
                {projectOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {/* 全部删除：跟随当前筛选 + 搜索的可见集（文案带数量让确认弹窗有锚） */}
          <Button
            variant="destructive"
            size="default"
            className="ml-auto"
            disabled={deleting || visibleIds.length === 0}
            onClick={() => setConfirming({ ids: visibleIds })}
          >
            <IconTrash className="size-3.5" />
            {filtered ? '永久删除筛选结果' : '全部永久删除'}
          </Button>
        </>
      }
    >
      {archived === null ? (
        <div className="mt-8 rounded-lg border border-border px-5 py-4 text-xs text-muted-foreground">
          加载中…
        </div>
      ) : total === 0 ? (
        /* 空态文案对齐主流产品（ChatGPT 同款口吻） */
        <div className="mt-8 flex flex-col items-center gap-1 rounded-lg border border-dashed border-border px-6 py-12 text-center">
          <div className="text-sm font-medium">没有已归档的聊天</div>
          <div className="text-xs text-muted-foreground">
            归档的聊天会显示在此处。你可以在聊天操作中选择归档。
          </div>
        </div>
      ) : groups.length === 0 ? (
        <div className="mt-8 flex flex-col items-center gap-1 rounded-lg border border-dashed border-border px-6 py-12 text-center">
          <div className="text-sm font-medium">没有匹配的归档聊天</div>
          <div className="text-xs text-muted-foreground">调整搜索词或筛选条件再试。</div>
        </div>
      ) : (
        <div ref={groupsSlide.containerRef} className={cn(groupsSlide.containerClassName, 'mt-8 flex flex-col gap-5')}>
          {groupsSlide.pill}
          {groups.map((group) => (
            <ArchiveGroupCard
              key={group.key}
              group={group}
              sort={sort}
              disabled={deleting}
              onRestore={restore}
              onAskDelete={setConfirming}
            />
          ))}
        </div>
      )}

      {/* 删除确认：单个 / 组批 / 全部共用一弹窗（彻底删除不可逆，转录文件一并清） */}
      <AlertDialog open={confirming !== null} onOpenChange={(open) => {
        if (!open && !deleting) setConfirming(null)
      }}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader className="gap-2">
            <AlertDialogTitle className="flex items-center gap-2.5">
              <IconAlertTriangle className="size-5 shrink-0 text-destructive" />
              删除这 {confirming?.ids.length ?? 0} 个归档聊天？
            </AlertDialogTitle>
            <AlertDialogDescription>
              将彻底删除这些聊天及其转录文件，此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            {/* Action 是纯 Button 包装（不带 Close 原语，见 alert-dialog.tsx）：
                点击不自动关窗 —— 关窗时机在 runDelete 成功后，失败保持开窗留现场 */}
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={() => {
                if (confirming !== null) void runDelete(confirming.ids)
              }}
            >
              {deleting ? '删除中…' : `永久删除 ${confirming?.ids.length ?? 0} 个`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsPage>
  )
}

/**
 * 归档分组卡：组头 = 折叠触发（文件夹 + 名 + 旋转箭头）+ 计数 + 组级批量
 * 菜单（全部取消归档 / 全部永久删除，作用于该组经筛选后的可见集）；
 * 组体内容常驻（导航变体 keepMounted）—— zcode 收起组不挂载行 DOM 是
 * 为万级行量做的取舍，回收站量级小，取过渡与行状态保留。
 */
function ArchiveGroupCard({
  group,
  sort,
  disabled,
  onRestore,
  onAskDelete,
}: {
  group: ArchiveGroup
  sort: ArchiveSort
  disabled: boolean
  onRestore: (ids: string[]) => Promise<void>
  onAskDelete: (confirm: DeleteConfirm) => void
}) {
  const [open, setOpen] = useState(false)
  const ids = group.chats.map((c) => c.id)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex items-center gap-2">
        {/* 组头触发：裸 button（无库形态可套，hover/展开态就地给基础档；
            展开态由本地 open 状态控制 —— 不赌原语挂在 trigger 上的 data-*） */}
        <CollapsibleTrigger
          render={
            <button
              type="button"
              data-hover-slide
              aria-label={`${group.label} 的归档聊天`}
              className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-sm font-medium outline-none hover:bg-muted ${open ? 'bg-muted' : ''}`}
            />
          }
        >
          <IconFolder className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate" title={group.label}>
            {group.label}
          </span>
          {/* 折叠箭头（侧栏同语言）：折叠态 -90° 指右，展开回正 */}
          <IconChevronDown
            className={`size-[13px] shrink-0 text-muted-foreground transition-transform ${!open ? '-rotate-90' : ''}`}
          />
        </CollapsibleTrigger>
        <span className="shrink-0 text-sm text-muted-foreground">{group.chats.length} 个聊天</span>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={disabled}
                aria-label={`${group.label}的归档操作`}
              />
            }
          >
            <IconDots className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto min-w-36">
            <DropdownMenuItem disabled={disabled} onClick={() => void onRestore(ids)}>
              <IconArrowBackUp className="size-4" />
              全部取消归档
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              disabled={disabled}
              onClick={() => onAskDelete({ ids })}
            >
              <IconTrash className="size-4" />
              全部永久删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {/* 组体：行卡（divide-y），标题 + 时间（随排序档切换）| 取消归档 / 删除。
          导航变体承载 200ms 开合过渡（与侧栏分区同款）：内容常驻挂载
          （keepMounted）—— 回收站量级小，换过渡与行状态保留比省这点 DOM 划算，
          与 zcode「收起不挂载」的取舍不同，量级判断见文件头注释 */}
      <CollapsibleContent variant="navigation">
        <div className="mt-2 flex flex-col divide-y divide-border rounded-lg border border-border">
          {group.chats.map((chat) => (
            <div key={chat.id} className="flex items-center gap-4 px-5 py-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium" title={chat.title}>
                  {chat.title}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {new Date(sort === 'created' ? chat.createdAt : chat.updatedAt).toLocaleDateString()}
                </div>
              </div>
              {/* 行动作：恢复文字钮 + 删除 icon 钮（回收站页动作即主线，常显不 hover 藏） */}
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={disabled}
                  onClick={() => void onRestore([chat.id])}
                >
                  取消归档
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={disabled}
                  aria-label={`永久删除 ${chat.title}`}
                  onClick={() => onAskDelete({ ids: [chat.id] })}
                >
                  <IconTrash className="size-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
