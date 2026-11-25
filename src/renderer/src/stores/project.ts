/**
 * 项目域状态（zustand）：引擎 project.* 的 renderer 消费端。
 * 数据源 = 引擎 RPC（project.list/create/update/delete/setPinned），store 只做缓冲；
 * 会话归属靠 chat store 的 SessionSummary.projectId 关联（本 store 不持有会话）。
 */
import { create } from 'zustand'
import type { ProjectSummary } from '@/env.d'

interface ProjectState {
  projects: ProjectSummary[]
  loaded: boolean
  loadError: string | null
  load: () => Promise<void>
  create: (name: string, cwds: string[]) => Promise<ProjectSummary>
  /** 编辑（改名 + 目录增删一次提交，project.update 全量替换语义） */
  update: (projectId: string, name: string, cwds: string[]) => Promise<void>
  remove: (projectId: string) => Promise<void>
  setPinned: (projectId: string, pinned: boolean) => Promise<void>
}

let inflightLoad: Promise<void> | null = null

export const useProjectStore = create<ProjectState>((set) => ({
  projects: [],
  loaded: false,
  loadError: null,

  load: () => {
    if (inflightLoad !== null) return inflightLoad
    inflightLoad = window.cogent
      .engineRequest('project.list', {})
      .then(
        (projects) => {
          set({ projects, loaded: true, loadError: null })
        },
        (error: unknown) => {
          set({ loadError: error instanceof Error ? error.message : String(error), loaded: false })
        }
      )
      .finally(() => {
        inflightLoad = null
      })
    return inflightLoad
  },

  create: async (name, cwds) => {
    const { summary } = await window.cogent.engineRequest('project.create', { name, cwds })
    set((state) => ({ projects: [...state.projects, summary] }))
    return summary
  },

  update: async (projectId, name, cwds) => {
    const { summary } = await window.cogent.engineRequest('project.update', { projectId, name, cwds })
    set((state) => ({
      projects: state.projects.map((p) => (p.id === projectId ? summary : p))
    }))
  },

  remove: async (projectId) => {
    await window.cogent.engineRequest('project.delete', { projectId })
    set((state) => ({ projects: state.projects.filter((p) => p.id !== projectId) }))
  },

  /** 项目置顶/取消（引擎落 pinnedAt；移动语义由 HomeSidebar 分区过滤实现） */
  setPinned: async (projectId, pinned) => {
    const { summary } = await window.cogent.engineRequest('project.setPinned', { projectId, pinned })
    set((state) => ({
      projects: state.projects.map((p) => (p.id === projectId ? summary : p))
    }))
  }
}))
