/**
 * 审批规则表 —— 「始终允许此工作区」的引擎侧落点（审批交互升级 D3）。
 *
 * 形状与存储位置的决策依据（三家调研，计划 §1.5）：
 * - 粒度 = 工作区 roots × 工具类别，**只存位置不存内容** —— Claude Code 的
 *   settings.local.json 存精确命令（含密钥）被误提交泄漏（Apiiro 实锤），
 *   Cogent 只存目录名，无参数泄漏面；
 * - 存 `~/.cogent/approvals.json`（引擎侧全局单文件，**不进项目目录**）——
 *   杜绝 repo 内误提交事故面；Qoder「始终允许本项目」同款工作区级持久；
 * - 判定优先序（D3）：软边界（1.3 起在审批层，session.ts decideApproval
 *   先查 write-boundary，越界恒拒）> 本规则表放行 > mode 矩阵 —— 规则只能
 *   放行"边界内"的写，越界写恒被拒，与 Claude Code「deny > allow 严格序」
 *   铁律同构。
 *
 * 为什么不走 StorageDriver / driver collection：collection 是
 * `<root>/<collection>/<id>.json` 目录语义（一实体一文件），而规则表是全局
 * 一小份单文档（预计个位数条目），单文件整读整写最贴切 —— 自写 tmp+rename
 * 原子写，手法同 JsonStorageDriver.put（main 侧的 writeFileAtomic 不可
 * import，host 零 Electron 依赖的边界纪律）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolKind } from '../../protocol'

/** 盘上文档格式版本（字段演进据此迁移，同 sessions/projects 的 version 手法） */
const RULES_FILE_VERSION = 1

/** 单条规则：工作区根快照 × 工具类别（createdAt 仅审计呈现用，不参与判定） */
export interface ApprovalRule {
  roots: string[]
  kind: ToolKind
  createdAt: number
}

/** 盘上文档形状 */
interface StoredRules {
  version: 1
  rules: ApprovalRule[]
}

/**
 * 盘上数据收窄（信任边界：磁盘旧数据可能被手改/损坏）。损坏报错由构造方
 * 旁置 .corrupt 后按空表继续 —— 规则表损坏不该炸引擎启动（同 session/
 * project 的逐文件隔离口径：可见性保留，故障不扩散）。
 */
function asStoredRules(doc: unknown): StoredRules {
  if (typeof doc !== 'object' || doc === null) throw new Error('规则文档形状不合法（approvals.json）')
  const d = doc as Partial<StoredRules>
  if (d.version !== RULES_FILE_VERSION || !Array.isArray(d.rules)) {
    throw new Error('规则文档版本/形状不合法（approvals.json）')
  }
  for (const rule of d.rules) {
    if (
      typeof rule !== 'object' ||
      !Array.isArray(rule.roots) ||
      rule.roots.length === 0 ||
      !rule.roots.every((r) => typeof r === 'string' && r.length > 0) ||
      typeof rule.kind !== 'string' ||
      typeof rule.createdAt !== 'number'
    ) {
      throw new Error('规则条目形状不合法（approvals.json）')
    }
  }
  return d as StoredRules
}

export class ApprovalRegistry {
  private rules: ApprovalRule[] = []

  constructor(private readonly root: string) {
    const file = this.filePath
    if (!existsSync(file)) return
    try {
      this.rules = asStoredRules(JSON.parse(readFileSync(file, 'utf-8'))).rules
    } catch (error) {
      // 旁置现场再按空表继续（静默重建违反约定.md §1.1，可见性靠旁置文件保留）
      try {
        renameSync(file, `${file}.corrupt`)
      } catch {
        // 旁置失败（文件被占锁等）不追加深陷：诊断已留，启动继续
      }
      process.stderr.write(
        `[host] 审批规则文档损坏已隔离（approvals.json → .corrupt，按空表继续）: ${(error as Error).message}\n`
      )
    }
  }

  /**
   * 判定：会话工作区根与某条同类别规则存在交集即放行（D3「任一根命中」）。
   * 交集而非全等：项目后加的目录不在旧规则里 → 新根不命中 → 照常审批
   * （宁可多问）；无绑定根会话传入空数组天然不命中，无根不落规则的 UI
   * 语义在引擎侧自洽（协议直达也放不进来）。
   */
  allows(roots: string[], kind: ToolKind): boolean {
    return this.rules.some((rule) => rule.kind === kind && roots.some((r) => rule.roots.includes(r)))
  }

  /** 落规则（幂等：同 kind 且 roots 集合相同不重复落 —— 重复点「始终允许」无副作用） */
  add(roots: string[], kind: ToolKind): void {
    const sameSet = (a: string[], b: string[]): boolean =>
      a.length === b.length && a.every((r) => b.includes(r))
    if (this.rules.some((rule) => rule.kind === kind && sameSet(rule.roots, roots))) return
    this.rules.push({ roots: [...roots], kind, createdAt: Date.now() })
    this.persist()
  }

  /** 尽力落盘（失败记诊断不抛，同 session/project persist 口径：内存判定先行，盘上下次重试） */
  private persist(): void {
    try {
      mkdirSync(this.root, { recursive: true })
      const doc: StoredRules = { version: RULES_FILE_VERSION, rules: this.rules }
      // 原子替换（tmp+rename）：写中途崩溃留下完整旧文件而非截断新文件
      const file = this.filePath
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(doc, null, 2))
      renameSync(tmp, file)
    } catch (error) {
      process.stderr.write(`[host] 审批规则落盘失败（下次变更重试）: ${(error as Error).message}\n`)
    }
  }

  private get filePath(): string {
    return join(this.root, 'approvals.json')
  }
}
