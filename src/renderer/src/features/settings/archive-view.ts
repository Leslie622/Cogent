/**
 * 设置页「归档」的分组视图纯函数（zcode 对齐：packages/ui/src/
 * project-sidebar/archive-view.ts）。归档列表按项目分组两级展示：组行 =
 * 项目身份 + 计数 + 组级批量动作，展开挂载组内聊天行。
 * 与 zcode 的两处刻意差异（zcode 源码注释同样位置可查）：
 * - zcode 的 projects 表带 deleted 软删墓碑，悬空项目名永远可查（显示
 *   「名 · 已移除」）；Cogent 项目删除是硬删，悬空 projectId 名字无从查起，
 *   统一合成一组「已移除项目」（组内恢复后会话的悬空 projectId 保持原样，
 *   落回主列表「最近」分区，见 docs/模块/工作区与项目.md）。
 * - zcode 组 key 含 hostId（本机 + 远端多源）；Cogent 单 host，key 退化为
 *   projectId 本身（'none' / 'missing' / 项目 id 三档）。
 */
import type { ProjectSummary, SessionSummary } from '@/env.d'

/** 排序档：更新时间 / 创建时间（zcode 同款两档，组内行与行内时间共用） */
export type ArchiveSort = 'updated' | 'created'

/** 筛选值：'all' 不过滤 / 'none' 未归类 / 'missing' 已移除项目 / 项目 id */
export type ArchiveProjectFilter = 'all' | 'none' | 'missing' | (string & {})

export interface ArchiveGroup {
  /** 组身份：'none' / 'missing' / 项目 id */
  key: ArchiveProjectFilter
  /** 组行显示名：项目名 / 未归类 / 已移除项目 */
  label: string
  /** 悬空项目组（ projectId 还在但项目已删） */
  removed: boolean
  chats: SessionSummary[]
}

const sortTime = (chat: SessionSummary, sort: ArchiveSort) =>
  sort === 'created' ? chat.createdAt : chat.updatedAt

/**
 * 归档集 → 项目分组。筛选（搜索 + 项目）在分组前做，组菜单与「永久删除
 * 筛选结果」都作用于可见集。组间顺序 = 组内最新 updatedAt 倒序（与 zcode
 * 按任务流首现序等价：任务流即 updatedAt 倒序）。
 */
export function buildArchiveGroups(
  archived: SessionSummary[],
  projects: ProjectSummary[],
  filter: { query?: string; sort?: ArchiveSort; project?: ArchiveProjectFilter } = {}
): ArchiveGroup[] {
  const query = filter.query?.trim().toLowerCase() ?? ''
  const nameById = new Map(projects.map((p) => [p.id, p.name]))
  const groups = new Map<ArchiveProjectFilter, ArchiveGroup>()
  const latestUpdatedAt = new Map<ArchiveProjectFilter, number>()
  for (const chat of archived) {
    if (query !== '' && !chat.title.toLowerCase().includes(query)) continue
    // 三档身份：无项目 → 未归类；项目已删（悬空 id）→ 已移除项目；其余 → 项目
    const id = chat.projectId
    const name = id === undefined ? undefined : nameById.get(id)
    const key: ArchiveProjectFilter = id === undefined ? 'none' : name === undefined ? 'missing' : id
    if (filter.project !== undefined && filter.project !== 'all' && key !== filter.project) continue
    latestUpdatedAt.set(key, Math.max(latestUpdatedAt.get(key) ?? 0, chat.updatedAt))
    const group = groups.get(key)
    if (group !== undefined) {
      group.chats.push(chat)
    } else {
      groups.set(key, {
        key,
        label: key === 'none' ? '未归类' : key === 'missing' ? '已移除项目' : name!,
        removed: key === 'missing',
        chats: [chat],
      })
    }
  }
  for (const group of groups.values()) {
    group.chats.sort(
      (a, b) => sortTime(b, filter.sort ?? 'updated') - sortTime(a, filter.sort ?? 'updated')
    )
  }
  return [...groups.values()].sort(
    (a, b) => latestUpdatedAt.get(b.key)! - latestUpdatedAt.get(a.key)!
  )
}

/**
 * 筛选下拉选项（zcode buildArchiveProjectOptions 同语义）：归档集中出现的
 * 组（含未归类 / 已移除项目）+ 全部现存项目 —— 空项目也列出，选项身份
 * 不随最后一条取消归档消失，当前筛选值不落空。
 */
export function buildArchiveProjectOptions(
  archived: SessionSummary[],
  projects: ProjectSummary[]
): Array<{ value: ArchiveProjectFilter; label: string }> {
  const present = new Set(buildArchiveGroups(archived, projects).map((g) => g.key))
  return [
    { value: 'all', label: '所有项目' },
    ...(present.has('none') ? [{ value: 'none' as const, label: '未归类' }] : []),
    ...projects.map((p) => ({ value: p.id, label: p.name })),
    ...(present.has('missing') ? [{ value: 'missing' as const, label: '已移除项目' }] : []),
  ]
}
