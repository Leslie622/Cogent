/**
 * archive-view 纯函数单测（zcode 对齐随拆出落测）：钉分组身份三档
 * （项目 / 未归类 / 已移除项目 —— 悬空 projectId 合成一组，与 zcode
 * 软删墓碑逐 id 分组的差异点）、搜索与项目筛选的作用域、组内双档排序、
 * 组间按最新 updatedAt 排序（不受组内排序档影响）、筛选选项的身份稳定
 * （空项目也列出，未归类 / 已移除项目仅在实际存在时出现）。
 */
import { describe, expect, it } from 'vitest'
import {
  buildArchiveGroups,
  buildArchiveProjectOptions,
  type ArchiveSort,
} from '@/features/settings/archive-view'
import type { ProjectSummary, SessionSummary } from '@/env.d'

const chat = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  title: id,
  createdAt: 10,
  updatedAt: 10,
  ...over,
})
const project = (id: string, name: string): ProjectSummary => ({
  id,
  name,
  cwds: ['/w'],
  createdAt: 1,
})

describe('buildArchiveGroups 分组身份', () => {
  const projects = [project('p1', '甲'), project('p2', '乙')]

  it('三档身份：项目名 / 未归类 / 已移除项目（悬空 id 合成一组）', () => {
    const groups = buildArchiveGroups(
      [
        chat('a', { projectId: 'p1' }),
        chat('b', {}),
        chat('c', { projectId: 'p2' }),
        chat('d', { projectId: 'gone' }),
        chat('e', { projectId: 'gone2' }),
      ],
      projects
    )
    expect(groups.map((g) => [g.key, g.label, g.removed])).toEqual([
      ['p1', '甲', false],
      ['none', '未归类', false],
      ['p2', '乙', false],
      ['missing', '已移除项目', true],
    ])
    expect(groups[3].chats.map((c) => c.id)).toEqual(['d', 'e'])
  })

  it('搜索按标题过滤后再分组（空串 = 不过滤）', () => {
    const list = [chat('alpha', { projectId: 'p1' }), chat('beta', { projectId: 'p1' })]
    expect(buildArchiveGroups(list, projects, { query: 'ALP' }).map((g) => g.chats)).toEqual([
      [list[0]],
    ])
    expect(buildArchiveGroups(list, projects, { query: '' })).toHaveLength(1)
  })

  it('项目筛选项与组 key 同档：none / missing / 项目 id', () => {
    const list = [
      chat('a', { projectId: 'p1' }),
      chat('b', {}),
      chat('d', { projectId: 'gone' }),
    ]
    expect(buildArchiveGroups(list, projects, { project: 'none' }).map((g) => g.key)).toEqual(['none'])
    expect(buildArchiveGroups(list, projects, { project: 'missing' }).map((g) => g.key)).toEqual([
      'missing',
    ])
    expect(buildArchiveGroups(list, projects, { project: 'p1' }).map((g) => g.chats)).toEqual([
      [list[0]],
    ])
    // all 或不传 = 不过滤（含未归类与已移除项目，即「所有项目」语义）
    expect(buildArchiveGroups(list, projects, { project: 'all' })).toHaveLength(3)
    expect(buildArchiveGroups(list, projects)).toHaveLength(3)
  })
})

describe('buildArchiveGroups 排序', () => {
  const projects = [project('p1', '甲'), project('p2', '乙')]

  it('组内按档位时间倒序：updated / created', () => {
    const list = [
      chat('old-upd', { projectId: 'p1', createdAt: 1, updatedAt: 2 }),
      chat('new-upd', { projectId: 'p1', createdAt: 9, updatedAt: 1 }),
    ]
    const keyOf = (sort: ArchiveSort) =>
      buildArchiveGroups(list, projects, { sort })[0].chats.map((c) => c.id)
    expect(keyOf('updated')).toEqual(['old-upd', 'new-upd'])
    expect(keyOf('created')).toEqual(['new-upd', 'old-upd'])
  })

  it('组间按组内最新 updatedAt 倒序，不受组内排序档影响', () => {
    const list = [
      chat('p2-new', { projectId: 'p2', createdAt: 99, updatedAt: 5 }),
      chat('p2-old', { projectId: 'p2', createdAt: 1, updatedAt: 1 }),
      chat('p1-only', { projectId: 'p1', createdAt: 1, updatedAt: 9 }),
    ]
    for (const sort of ['updated', 'created'] as const) {
      expect(buildArchiveGroups(list, projects, { sort }).map((g) => g.key)).toEqual(['p1', 'p2'])
    }
  })
})

describe('buildArchiveProjectOptions 筛选选项', () => {
  it('全部现存项目都列出（0 条归档也保身份）；未归类 / 已移除项目仅存在时出现', () => {
    const projects = [project('p1', '甲'), project('p2', '乙')]
    const list = [
      chat('a', { projectId: 'p1' }),
      chat('b', {}),
      chat('d', { projectId: 'gone' }),
    ]
    expect(buildArchiveProjectOptions(list, projects)).toEqual([
      { value: 'all', label: '所有项目' },
      { value: 'none', label: '未归类' },
      { value: 'p1', label: '甲' },
      { value: 'p2', label: '乙' },
      { value: 'missing', label: '已移除项目' },
    ])
    // 只有项目归档：无 none / missing 档
    expect(buildArchiveProjectOptions([chat('a', { projectId: 'p1' })], projects)).toEqual([
      { value: 'all', label: '所有项目' },
      { value: 'p1', label: '甲' },
      { value: 'p2', label: '乙' },
    ])
    // 空归档集：仍列出全部项目（当前筛选值不落空）
    expect(buildArchiveProjectOptions([], projects)).toEqual([
      { value: 'all', label: '所有项目' },
      { value: 'p1', label: '甲' },
      { value: 'p2', label: '乙' },
    ])
  })
})
