/**
 * 设置页作用域选择（技能 / MCP 分区共用）：下拉 = 本机·用户 + 全部项目，
 * 用户挑哪个项目看哪个（2026-11-15 用户反馈：原「本项目」隐式跟随活跃会话、
 * 无法分项目浏览）。默认选中 = 活跃会话归属的项目（延续「跟着当前工作」的
 * 直觉；项目会话 summary 不带 cwd，按 projectId 直配）；手动挑过即固定，
 * 不再随会话切换漂移。选中的项目被删 → 回落 本机·用户。
 *
 * 项目 cwd = cwds[0]（主根，与引擎 workspaceRoots 首根同口径）；cwds 非空
 * 由引擎侧形状校验保证（project.ts:49），这里不重复设防。
 */
import { useState } from 'react'
import { useChatStore } from '@/stores/chat'
import { useProjectStore } from '@/stores/project'
import type { ProjectSummary } from '@/env.d'

export interface ProjectScope {
  /** Select 绑定值（'user' 哨兵 | projectId；picked 项目已删时回落 'user'） */
  selectValue: string
  /** 用户显式选择；传 'user' 或项目 id */
  pick: (value: string) => void
  scope: 'user' | 'project'
  /** 选中的项目（scope=user 时 undefined） */
  project: ProjectSummary | undefined
  /** 项目主根（scope=user 时 undefined） */
  projectCwd: string | undefined
  /** Select 的 items（触发器显示文案，「本机 · X」形，zcode 同款） */
  items: Array<{ value: string; label: string }>
  /** 弹层分组渲染：本机（用户档）+ 项目（二级菜单，各项目名） */
  groups: Array<{ label: string; items: Array<{ value: string; label: string }> }>
}

export function useProjectScope(): ProjectScope {
  /** null = 用户还没挑过（跟随默认）；'user' 哨兵 | 项目 id */
  const [picked, setPicked] = useState<string | null>(null)
  const activeProjectId = useChatStore((s) => s.sessions.find((x) => x.id === s.activeSessionId)?.projectId)
  const projects = useProjectStore((s) => s.projects)

  const selection = picked ?? activeProjectId ?? 'user'
  const project = selection === 'user' ? undefined : projects.find((p) => p.id === selection)
  // picked 的项目被删（列表查无）→ 视图回落用户档，Select 值同步避免空显示
  const selectValue = project === undefined ? 'user' : selection

  return {
    selectValue,
    pick: setPicked,
    scope: project === undefined ? 'user' : 'project',
    project,
    projectCwd: project?.cwds[0],
    items: [
      { value: 'user', label: '本机 · 用户' },
      ...projects.map((p) => ({ value: p.id, label: `本机 · ${p.name}` }))
    ],
    groups: [
      { label: '本机', items: [{ value: 'user', label: '用户' }] },
      ...(projects.length > 0 ? [{ label: '项目', items: projects.map((p) => ({ value: p.id, label: p.name })) }] : [])
    ]
  }
}
