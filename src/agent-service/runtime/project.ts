/**
 * 项目注册表 —— 「项目 = 目录绑定」的引擎侧落点（计划 D3；2026-11-09 多根化）。
 *
 * 项目在这个引擎里就是一个薄实体：{ id, name, cwds[], createdAt }。它的意义
 * 不在自身，而在**被会话引用**（session.projectId → 继承全部目录），与 UI 的
 * 「项目 → 子聊天」两级结构同构。多根目录（首个 = 主根）覆盖跨仓库任务
 * （前端 + 后端两仓库一个项目），对齐 VS Code workspace / Claude Code --add-dir。
 *
 * 盘上格式 v2：cwds 数组；v1（单 cwd 字符串）启动时原位迁移 —— 迁移不是兼容读：
 * 读出 → 转形状 → 写回 v2，盘上永远只停留最新格式（单写者，无并发读者）。
 *
 * delete 语义：项目删除**不级联**——归属它的会话保留（projectId 悬挂）。
 * 理由：会话是用户资产（转录在），项目只是组织结构；悬挂 id 在 UI 侧
 * 显示为「无项目」即可。级联删会话是危险动作，真要做也应由 UI 显式确认。
 */
import { ProtocolError, RpcErrorCode } from '../../protocol'
import type { ProjectSummary } from '../../protocol'
import type { StorageDriver } from '../storage'

const PROJECT_COLLECTION = 'projects'
const PROJECT_FILE_VERSION = 2


/**
 * 盘上数据收窄 + v1→v2 迁移（信任边界：磁盘旧数据可能损坏/被手改/属旧版本）。
 * 迁移是显式动作不是静默兼容：v1 文件在此转 v2 并标脏，由调用方写回。
 */
function asStoredProject(doc: unknown, id: string): { summary: ProjectSummary; migrated: boolean } {
  if (typeof doc !== 'object' || doc === null) throw new Error(`项目文档形状不合法（projects/${id}.json）`)
  const raw = doc as { version?: unknown; summary?: unknown }
  const summary = raw.summary as Partial<ProjectSummary & { cwd?: string }>
  // v1 → v2：cwd 字符串包成单元素数组（旧字段 cwd 存在即按 v1 处理）
  if (raw.version === 1 && typeof summary.cwd === 'string' && typeof summary.id === 'string') {
    return {
      summary: {
        id: summary.id,
        name: summary.name ?? summary.id,
        cwds: [summary.cwd],
        createdAt: summary.createdAt ?? 0
      },
      migrated: true
    }
  }
  if (
    raw.version !== PROJECT_FILE_VERSION ||
    typeof summary.id !== 'string' ||
    typeof summary.name !== 'string' ||
    !Array.isArray(summary.cwds) ||
    summary.cwds.length === 0
  ) {
    throw new Error(`项目文档版本/形状不合法（projects/${id}.json），请手工处理后重启`)
  }
  return { summary: summary as ProjectSummary, migrated: false }
}

export class ProjectRegistry {
  private projects = new Map<string, ProjectSummary>()

  constructor(private storage: StorageDriver) {
    // 启动全量恢复（项目是小实体，全进内存；损坏报错不静默，同 session 口径）
    for (const id of this.storage.ids(PROJECT_COLLECTION)) {
      const { summary, migrated } = asStoredProject(this.storage.get(PROJECT_COLLECTION, id), id)
      this.projects.set(summary.id, summary)
      // v1 盘上文件立即转写 v2（迁移不是兼容读，盘上只留最新格式）
      if (migrated) this.persist(summary.id)
    }
  }

  list(): ProjectSummary[] {
    return [...this.projects.values()]
  }

  get(projectId: string): ProjectSummary | undefined {
    return this.projects.get(projectId)
  }

  create(name: string, cwds: string[]): ProjectSummary {
    const summary: ProjectSummary = {
      id: crypto.randomUUID(),
      name: name.trim(),
      cwds: [...cwds],
      createdAt: Date.now()
    }
    this.projects.set(summary.id, summary)
    this.persist(summary.id)
    return { ...summary }
  }

  rename(projectId: string, name: string): ProjectSummary {
    const summary = this.require(projectId)
    summary.name = name.trim()
    this.persist(projectId)
    return { ...summary }
  }

  /** 项目置顶/取消（字段落盘，同会话 setPinned 口径） */
  setPinned(projectId: string, pinned: boolean): ProjectSummary {
    const summary = this.require(projectId)
    if (pinned) summary.pinnedAt = Date.now()
    else delete summary.pinnedAt
    this.persist(projectId)
    return { ...summary }
  }

  delete(projectId: string): boolean {
    if (!this.projects.has(projectId)) return false
    this.projects.delete(projectId)
    this.storage.delete(PROJECT_COLLECTION, projectId)
    return true
  }

  private require(projectId: string): ProjectSummary {
    const summary = this.projects.get(projectId)
    if (!summary) throw new ProtocolError(RpcErrorCode.InternalError, `项目不存在: ${projectId}`)
    return summary
  }

  /** 尽力语义（失败记诊断不抛），同 SessionManager.persist 的口径与理由 */
  private persist(projectId: string): void {
    const summary = this.projects.get(projectId)
    if (!summary) return
    try {
      this.storage.put(PROJECT_COLLECTION, projectId, { version: PROJECT_FILE_VERSION, summary })
    } catch (error) {
      process.stderr.write(`[agent-service] 项目落盘失败（${projectId}，下回合重试）: ${(error as Error).message}\n`)
    }
  }
}
