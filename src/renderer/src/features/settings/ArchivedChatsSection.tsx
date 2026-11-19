/**
 * 设置 · 已归档的聊天分区：回收站管理列表（自定义布局，不走 SettingsRow ——
 * 行内容是"标题 + 项目徽标 + 时间 + 双动作钮"，通用行件装不下）。数据源 =
 * session.listArchived（引擎按 archivedAt 倒序）；搜索 / 项目筛选 / 排序全在
 * 本地做（列表量级小，一次拉全即可，不进引擎协议）。
 * 恢复 = session.archive(archived:false)；删除 = session.delete（彻底删，
 * 转录文件一并清，不可逆 —— 单个与全部都过 AlertDialog 确认）。
 * 「全部删除」删的是当前筛选 + 搜索后的可见集（引擎无批量方法，串行循环）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { IconAlertTriangle, IconArrowBackUp, IconSearch, IconTrash } from '@tabler/icons-react'
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
import type { SessionSummary } from '@/env.d'

/** 排序档（label 即 Select 显示文案） */
const SORTS = [
  { value: 'archived', label: '归档时间' },
  { value: 'updated', label: '最近更新' },
  { value: 'title', label: '标题' },
] as const
type SortKey = (typeof SORTS)[number]['value']

/** 项目筛选项：'all' 全部 / 'none' 无项目（含项目已删的会话 —— 项目删除后
    projectId 悬空，名字无从查起，归并此档而不是造"未知项目"档） */
type ProjectFilter = 'all' | 'none' | (string & {})

/** 待确认的删除动作（弹窗状态机）：单个（带会话）或全部（带可见集 id） */
type DeleteConfirm = { kind: 'one'; chat: SessionSummary } | { kind: 'all'; ids: string[] }

export function ArchivedChatsSection() {
  // null = 初载未回（MCP 页同款三态：加载中 / 空 / 列表）
  const [archived, setArchived] = useState<SessionSummary[] | null>(null)
  const [query, setQuery] = useState('')
  const [projectFilter, setProjectFilter] = useState<ProjectFilter>('all')
  const [sort, setSort] = useState<SortKey>('archived')
  const [confirming, setConfirming] = useState<DeleteConfirm | null>(null)
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

  // 项目名映射（徽标与筛选项显示用）；悬空 projectId（项目已删）查不到名
  const projectNameById = useMemo(
    () => new Map(projects.map((p) => [p.id, p.name])),
    [projects]
  )
  // 筛选项只列归档集中实际出现的项目（全量项目会堆一排空筛选项）
  const filterableProjects = useMemo(() => {
    const ids = new Set(
      (archived ?? []).map((s) => s.projectId).filter((id): id is string => id !== undefined)
    )
    return projects.filter((p) => ids.has(p.id)).map((p) => ({ value: p.id, label: p.name }))
  }, [archived, projects])

  // 本地管道：项目筛选 → 搜索（标题）→ 排序
  const visible = useMemo(() => {
    if (archived === null) return null
    const q = query.trim().toLowerCase()
    const filtered = archived.filter((s) => {
      if (projectFilter === 'none' && s.projectId !== undefined) return false
      if (projectFilter !== 'all' && projectFilter !== 'none' && s.projectId !== projectFilter) return false
      return q === '' || s.title.toLowerCase().includes(q)
    })
    return [...filtered].sort((a, b) => {
      if (sort === 'title') return a.title.localeCompare(b.title, 'zh-Hans-CN')
      if (sort === 'updated') return b.updatedAt - a.updatedAt
      return (b.archivedAt ?? b.updatedAt) - (a.archivedAt ?? a.updatedAt)
    })
  }, [archived, projectFilter, query, sort])

  const restore = async (chatId: string) => {
    await useChatStore.getState().archive(chatId, false)
    await reload()
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
  const visibleCount = visible?.length ?? 0
  const projectOptions: Array<{ value: ProjectFilter; label: string }> = [
    { value: 'all', label: '全部项目' },
    ...((archived ?? []).some((s) => s.projectId === undefined)
      ? [{ value: 'none' as const, label: '无项目' }]
      : []),
    ...filterableProjects,
  ]

  return (
    <SettingsPage
      title="已归档的聊天"
      desc="归档是回收站语义：聊天从主列表移除但转录保留，可恢复或彻底删除。"
      toolbar={
        <>
          <div className="text-sm">
            归档 <span className="text-muted-foreground">{total}</span>
          </div>
          <div className="h-4 w-px bg-border" />
          {/* 项目筛选：SelectValue 按 items 映射显示当前项 label */}
          <Select
            value={projectFilter}
            items={projectOptions}
            onValueChange={(next) => {
              if (next !== null) setProjectFilter(next)
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
          <Select value={sort} items={SORTS} onValueChange={(next) => {
            if (next !== null) setSort(next)
          }}>
            <SelectTrigger size="default" aria-label="排序">
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
          {/* 搜索框：与 MCP 页同款裸 input 手搭（黑 5% 软叠胶囊底） */}
          <div className="ml-auto flex h-8 w-52 items-center gap-2 rounded-full bg-accent-foreground/5 px-3">
            <IconSearch className="size-4 shrink-0 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索归档聊天"
              className="h-full w-full min-w-0 bg-transparent text-sm text-foreground outline-none placeholder:text-placeholder"
            />
          </div>
          {/* 全部删除：跟随当前筛选 + 搜索的可见集（文案带数量让确认弹窗有锚） */}
          {visibleCount > 0 && (
            <Button
              variant="destructive"
              size="default"
              disabled={deleting}
              onClick={() => {
                if (visible !== null) setConfirming({ kind: 'all', ids: visible.map((s) => s.id) })
              }}
            >
              <IconTrash className="size-3.5" />
              全部删除
            </Button>
          )}
        </>
      }
    >
      {archived === null ? (
        <div className="mt-7 rounded-xl border border-border px-5 py-4 text-xs text-muted-foreground">
          加载中…
        </div>
      ) : total === 0 ? (
        /* 空态文案对齐主流产品（ChatGPT 同款口吻） */
        <div className="mt-7 flex flex-col items-center gap-1 rounded-xl border border-dashed border-border px-6 py-12 text-center">
          <div className="text-sm font-medium">没有已归档的聊天</div>
          <div className="text-xs text-muted-foreground">
            归档的聊天会显示在此处。你可以在聊天操作中选择归档。
          </div>
        </div>
      ) : !visible || visibleCount === 0 ? (
        <div className="mt-7 flex flex-col items-center gap-1 rounded-xl border border-dashed border-border px-6 py-12 text-center">
          <div className="text-sm font-medium">没有匹配的归档聊天</div>
          <div className="text-xs text-muted-foreground">调整搜索词或筛选条件再试。</div>
        </div>
      ) : (
        /* 行卡（divide-y）：标题 + 项目徽标 + 归档时间 | 恢复 / 删除 icon 钮 */
        <div className="mt-7 flex flex-col divide-y divide-border rounded-xl border border-border">
          {visible.map((chat) => (
            <div key={chat.id} className="flex items-center gap-4 px-5 py-3.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{chat.title}</span>
                  {chat.projectId !== undefined && projectNameById.has(chat.projectId) && (
                    <span className="shrink-0 rounded-full bg-accent-foreground/5 px-2 py-0.5 text-xs text-muted-foreground">
                      {projectNameById.get(chat.projectId)}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  归档于 {new Date(chat.archivedAt ?? chat.updatedAt).toLocaleDateString()}
                </div>
              </div>
              {/* 双动作钮：ghost icon 原生形态常显（回收站页动作即主线，不 hover 藏） */}
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="default"
                  aria-label={`恢复 ${chat.title}`}
                  disabled={deleting}
                  onClick={() => void restore(chat.id)}
                >
                  <IconArrowBackUp className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="default"
                  className="text-muted-foreground hover:text-destructive"
                  aria-label={`删除 ${chat.title}`}
                  disabled={deleting}
                  onClick={() => setConfirming({ kind: 'one', chat })}
                >
                  <IconTrash className="size-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 删除确认：单个 / 全部共用一弹窗（彻底删除不可逆，转录文件一并清） */}
      <AlertDialog open={confirming !== null} onOpenChange={(open) => {
        if (!open && !deleting) setConfirming(null)
      }}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader className="gap-2">
            <AlertDialogTitle className="flex items-center gap-2.5">
              <IconAlertTriangle className="size-5 shrink-0 text-destructive" />
              {confirming?.kind === 'all' ? `删除全部 ${confirming.ids.length} 个归档聊天？` : '删除这个归档聊天？'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming?.kind === 'all'
                ? '将删除当前列表中的全部聊天及其转录文件，此操作无法撤销。'
                : `「${confirming?.chat.title ?? ''}」及其转录文件将被彻底删除，此操作无法撤销。`}
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
                if (confirming !== null) {
                  void runDelete(confirming.kind === 'all' ? confirming.ids : [confirming.chat.id])
                }
              }}
            >
              {deleting ? '删除中…' : '删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsPage>
  )
}
