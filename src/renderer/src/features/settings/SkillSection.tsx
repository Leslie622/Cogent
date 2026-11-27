/**
 * 设置 · 技能分区（docs/模块/技能座.md & docs/计划/技能座升级实现.md）：
 * 数据真源 = 引擎的多源技能目录（bundled 内置 + 用户/项目 .cogent/.agents/.claude
 * + 向上祖先至 .git）与两级启停状态文件（skills.* 经 engine:request 通用代理，
 * 导入/导出/打开目录经主进程受信任特权 IPC 直达 Host，不让 renderer 传任意本机路径）。
 *
 * 关键特性：
 * - 回合边界热刷新：编辑、启停、导入均在下一回合生效；
 * - 无损编辑：保存时保留既有 SKILL.md 的 license/compatibility/metadata/allowed-tools 等字段；
 * - 完整管理面：新建、编辑/只读查看、目录与 .zip 导入（含冲突覆盖确认）、导出 .zip、
 *   一键打开技能目录、附带文件（scripts/references/assets）清单展示与高级调用设置。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  IconAlertTriangle,
  IconArrowBackUp,
  IconBook,
  IconChevronDown,
  IconChevronRight,
  IconDownload,
  IconEye,
  IconFileZip,
  IconFolderOpen,
  IconFolderPlus,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTrash
} from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { showErrorToast } from '@/components/ui/sonner'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Hint } from '@/components/Hint'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { SettingsGroup, SettingsPage } from './SettingsParts'
import { ScopeMenu } from './ScopeMenu'
import { BADGE, FIELD_GAP, FIELD_LABEL } from './models-recipes'
import { unwrapIpcError } from '@/lib/ipc'
import { useProjectScope, type ProjectScope } from '@/hooks/use-project-scope'
import type { SkillOrigin, SkillScope, SkillSummary } from '@/env.d'

/** 编辑/查看弹窗载荷（skills.read 回填；新增传 null） */
interface SkillDraft {
  name: string
  scope: SkillScope
  description: string
  body: string
  whenToUse: string
  manualOnly: boolean
  userInvocable: boolean
  argumentHint: string
  license?: string
  compatibility?: string
  allowedTools?: string[]
  unsupportedRuntime?: 'context-fork'
  resourceFiles: string[]
  readonly: boolean
}

interface SkillSaveInput {
  name: string
  description: string
  body: string
  whenToUse: string
  manualOnly: boolean
  userInvocable: boolean
  argumentHint: string
}

/**
 * 表单就地校验 —— 规则是引擎 skills.save 入口（skill-store validateSkillName/
 * validateDescription）的 UI 镜像，引擎仍是权威校验层。
 */
function draftError(name: string, description: string): string | null {
  if (name.length === 0) return '名称必填（小写字母 / 数字 / 连字符）'
  if (name.length > 64) return `名称：超过 64 字符（${name.length}）`
  if (!/^[a-z0-9-]+$/.test(name)) return '名称：只能是小写字母、数字、连字符'
  if (name.startsWith('-') || name.endsWith('-')) return '名称：不能以连字符开头或结尾'
  if (name.includes('--')) return '名称：不能含连续连字符'
  if (description.length === 0) return '描述必填（模型按它判断何时调用技能）'
  if (description.length > 1024) return `描述：超过 1024 字符（${description.length}）`
  return null
}

function originBadgeLabel(origin: SkillOrigin | undefined, eco: boolean | undefined): string | null {
  if (origin === 'bundled') return '内置'
  if (origin === 'claude') return '生态 · .claude'
  if (origin === 'agents') return '生态 · .agents'
  if (origin === 'custom') return '自定义目录'
  if (eco) return '生态目录'
  return null
}

/** 新增/编辑/只读查看弹窗 */
function SkillDialog({
  open,
  initial,
  saving,
  saveError,
  onClose,
  onSave,
  onReveal
}: {
  open: boolean
  initial: SkillDraft | null
  saving: boolean
  saveError: string | null
  onClose: () => void
  onSave: (draft: SkillSaveInput) => void
  onReveal?: (name: string, scope: SkillScope) => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState('')
  const [whenToUse, setWhenToUse] = useState('')
  const [manualOnly, setManualOnly] = useState(false)
  const [userInvocable, setUserInvocable] = useState(true)
  const [argumentHint, setArgumentHint] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const readonly = initial?.readonly === true

  useEffect(() => {
    if (!open) return
    setName(initial?.name ?? '')
    setDescription(initial?.description ?? '')
    setBody(initial?.body ?? '')
    setWhenToUse(initial?.whenToUse ?? '')
    setManualOnly(initial?.manualOnly ?? false)
    setUserInvocable(initial?.userInvocable ?? true)
    setArgumentHint(initial?.argumentHint ?? '')
    setShowAdvanced(
      initial !== null &&
        (initial.whenToUse.length > 0 ||
          initial.manualOnly ||
          !initial.userInvocable ||
          initial.argumentHint.length > 0 ||
          initial.resourceFiles.length > 0 ||
          initial.allowedTools !== undefined ||
          initial.license !== undefined ||
          initial.compatibility !== undefined ||
          initial.unsupportedRuntime !== undefined)
    )
    setFormError(null)
  }, [open, initial])

  const save = (): void => {
    if (readonly) return
    const error = draftError(name.trim(), description.trim())
    if (error !== null) {
      setFormError(error)
      return
    }
    onSave({
      name: name.trim(),
      description: description.trim(),
      body,
      whenToUse: whenToUse.trim(),
      manualOnly,
      userInvocable,
      argumentHint: argumentHint.trim()
    })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {initial === null ? '新建技能' : readonly ? `查看技能 · ${initial.name}` : '编辑技能'}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div>
            <div className={FIELD_LABEL}>名称</div>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如 commit-check"
              disabled={initial !== null}
              className="mt-1.5"
            />
          </div>
          <div className={FIELD_GAP}>
            <div className={FIELD_LABEL}>描述（模型按它决定何时调用 skill 工具）</div>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="如 提交前的检查清单与顺序"
              disabled={readonly}
              className="mt-1.5"
            />
          </div>
          <div className={FIELD_GAP}>
            <div className={FIELD_LABEL}>正文（Markdown 指令；支持 ${'{COGENT_SKILL_DIR}'} 与 $ARGUMENTS，保存时无损保留其他 frontmatter）</div>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={'1. …\n2. …'}
              rows={10}
              disabled={readonly}
              className="mt-1.5 font-mono text-xs"
            />
          </div>

          <div className="rounded-lg border border-border">
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="flex w-full items-center justify-between px-3.5 py-2.5 text-left text-xs font-medium text-foreground hover:bg-accent/40"
            >
              <span>高级设置与附带文件</span>
              {showAdvanced ? (
                <IconChevronDown className="size-4 text-muted-foreground" />
              ) : (
                <IconChevronRight className="size-4 text-muted-foreground" />
              )}
            </button>
            {showAdvanced && (
              <div className="flex flex-col gap-3.5 border-t border-border px-3.5 py-3">
                <div>
                  <div className={FIELD_LABEL}>触发场景补充（when_to_use，可选）</div>
                  <Input
                    value={whenToUse}
                    onChange={(e) => setWhenToUse(e.target.value)}
                    placeholder="如 当用户要求代码审查、提交检查时"
                    disabled={readonly}
                    className="mt-1.5"
                  />
                </div>
                <div>
                  <div className={FIELD_LABEL}>参数提示（argument-hint，可选，输入框面板显示）</div>
                  <Input
                    value={argumentHint}
                    onChange={(e) => setArgumentHint(e.target.value)}
                    placeholder="如 [目标目录或文件路径]"
                    disabled={readonly}
                    className="mt-1.5"
                  />
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-xs font-medium">仅手动调用（disable-model-invocation）</div>
                    <div className="text-xs text-muted-foreground">开启后不进模型自动清单，只能由用户经 $ / /skill: 触发</div>
                  </div>
                  <Switch checked={manualOnly} disabled={readonly} onCheckedChange={setManualOnly} aria-label="仅手动调用" />
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-xs font-medium">允许在输入框面板选择（user-invocable）</div>
                    <div className="text-xs text-muted-foreground">关闭后仅由模型按清单自主调用，不显示在 $ / 候选面板</div>
                  </div>
                  <Switch checked={userInvocable} disabled={readonly} onCheckedChange={setUserInvocable} aria-label="允许输入框面板选择" />
                </div>

                {initial?.unsupportedRuntime === 'context-fork' && (
                  <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    该技能声明了 <span className="font-mono">context: fork</span>（独立子会话执行），待子会话座就绪前将在主会话中执行。
                  </div>
                )}

                {(initial?.license !== undefined || initial?.compatibility !== undefined || initial?.allowedTools !== undefined) && (
                  <div className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                    {initial.license !== undefined && <div>许可协议：{initial.license}</div>}
                    {initial.compatibility !== undefined && <div>兼容性声明：{initial.compatibility}</div>}
                    {initial.allowedTools !== undefined && (
                      <div>
                        声明工具（allowed-tools，仅静态保留展示，审批统一走 Cogent 规则）：
                        <span className="ml-1 font-mono text-foreground">{initial.allowedTools.join(', ')}</span>
                      </div>
                    )}
                  </div>
                )}

                {initial !== null && (
                  <div>
                    <div className="flex items-center justify-between">
                      <span className={FIELD_LABEL}>
                        附带文件（{initial.resourceFiles.length} 个）
                      </span>
                      {onReveal !== undefined && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => onReveal(initial.name, initial.scope)}
                        >
                          <IconFolderOpen className="size-3.5" />
                          打开目录
                        </Button>
                      )}
                    </div>
                    {initial.resourceFiles.length === 0 ? (
                      <div className="mt-1 text-xs text-muted-foreground">
                        暂无附带文件。可将 scripts/、references/、assets/ 放入技能目录中。
                      </div>
                    ) : (
                      <div className="mt-1.5 max-h-28 overflow-y-auto rounded-md border border-border bg-muted/20 px-2.5 py-1.5 font-mono text-xs text-muted-foreground">
                        {initial.resourceFiles.map((file) => (
                          <div key={file} className="truncate py-0.5">
                            {file}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        {(formError ?? saveError) !== null && (
          <div className="mt-3 text-sm text-destructive">{formError ?? saveError}</div>
        )}
        <DialogFooter>
          <Button variant="ghost" size="default" disabled={saving} onClick={onClose}>
            {readonly ? '关闭' : '取消'}
          </Button>
          {!readonly && (
            <Button size="default" disabled={saving} onClick={save}>
              {saving ? '保存中…' : '保存'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 列表缓存（模块级，按作用域键）：避免切分区重挂载塌成加载卡 */
const skillsCache = new Map<string, SkillSummary[]>()

export function SkillSection() {
  const scopeState = useProjectScope()
  const scopeKey = JSON.stringify([scopeState.selectValue, scopeState.projectCwd])
  return <SkillScopeView key={scopeKey} scopeKey={scopeKey} scopeState={scopeState} />
}

function SkillScopeView({ scopeState, scopeKey }: { scopeState: ProjectScope; scopeKey: string }) {
  const [skills, setSkills] = useState<SkillSummary[] | null>(() => skillsCache.get(scopeKey) ?? null)
  const [stateErrors, setStateErrors] = useState<string[]>([])
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionNotice, setActionNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [editing, setEditing] = useState<SkillDraft | null>(null)
  const [query, setQuery] = useState('')
  const active = useRef(false)
  const latestRead = useRef<symbol | null>(null)
  const latestEdit = useRef<symbol | null>(null)

  const { scope, projectCwd } = scopeState

  const refresh = useCallback(async () => {
    if (!active.current) return
    const read = Symbol(scopeKey)
    latestRead.current = read
    try {
      const r = await window.cogent.engineRequest('skills.list', scope === 'project' ? { cwd: projectCwd } : {})
      if (latestRead.current !== read) return
      skillsCache.set(scopeKey, r.skills)
      setSkills(r.skills)
      setStateErrors(r.stateErrors ?? [])
    } catch (error) {
      if (latestRead.current === read) setActionError(unwrapIpcError(error))
    }
  }, [scope, projectCwd, scopeKey])

  useLayoutEffect(() => {
    active.current = true
    void refresh()
    return () => {
      active.current = false
      latestRead.current = null
      latestEdit.current = null
    }
  }, [refresh])

  const runAction = async (
    call: () => Promise<string | void>,
    savingDialog = false
  ): Promise<void> => {
    setBusy(true)
    if (savingDialog) setSaveError(null)
    setActionNotice(null)
    try {
      const notice = await call()
      if (scope === 'user') skillsCache.clear()
      else skillsCache.delete(scopeKey)
      if (active.current) {
        if (savingDialog) setDialogOpen(false)
        setActionError(null)
        if (typeof notice === 'string' && notice.length > 0) setActionNotice(notice)
        await refresh()
      }
    } catch (error) {
      const message = unwrapIpcError(error)
      if (!active.current) showErrorToast(`${scopeState.project?.name ?? '本机 · 用户'}的技能设置：${message}`)
      else if (savingDialog) setSaveError(message)
      else setActionError(message)
    } finally {
      if (active.current) setBusy(false)
    }
  }

  const openCreate = (): void => {
    latestEdit.current = null
    setEditing(null)
    setSaveError(null)
    setDialogOpen(true)
  }

  const openEditOrView = (s: SkillSummary): void => {
    const edit = Symbol(s.name)
    latestEdit.current = edit
    void (async () => {
      try {
        const r = await window.cogent.engineRequest('skills.read', {
          scope: s.scope,
          name: s.name,
          ...(scope === 'project' && projectCwd !== undefined && { cwd: projectCwd })
        })
        if (latestEdit.current !== edit) return
        const isReadonly =
          s.readonly === true ||
          s.eco === true ||
          s.scope === 'bundled' ||
          (!userScope && s.scope !== 'project') ||
          s.editable === false
        setEditing({
          name: s.name,
          scope: s.scope,
          description: r.description,
          body: r.body,
          whenToUse: r.whenToUse ?? '',
          manualOnly: r.manualOnly === true,
          userInvocable: r.userInvocable !== false,
          argumentHint: r.argumentHint ?? '',
          license: r.license,
          compatibility: r.compatibility,
          allowedTools: r.allowedTools,
          unsupportedRuntime: r.unsupportedRuntime,
          resourceFiles: r.resourceFiles ?? [],
          readonly: isReadonly
        })
        setSaveError(null)
        setDialogOpen(true)
      } catch (error) {
        if (latestEdit.current === edit) setActionError(unwrapIpcError(error))
      }
    })()
  }

  const saveFromDialog = (draft: SkillSaveInput): void => {
    const prev = editing
    const includeWhenToUse =
      prev !== null ? draft.whenToUse !== prev.whenToUse : draft.whenToUse.length > 0
    const includeManualOnly =
      prev !== null ? draft.manualOnly !== prev.manualOnly : draft.manualOnly
    const includeUserInvocable =
      prev !== null ? draft.userInvocable !== prev.userInvocable : !draft.userInvocable
    const includeArgumentHint =
      prev !== null ? draft.argumentHint !== prev.argumentHint : draft.argumentHint.length > 0
    void runAction(async () => {
      await window.cogent.engineRequest('skills.save', {
        scope,
        name: draft.name,
        description: draft.description,
        body: draft.body,
        ...(includeWhenToUse && { whenToUse: draft.whenToUse }),
        ...(includeManualOnly && { manualOnly: draft.manualOnly }),
        ...(includeUserInvocable && { userInvocable: draft.userInvocable }),
        ...(includeArgumentHint && { argumentHint: draft.argumentHint }),
        ...(scope === 'project' && projectCwd !== undefined && { cwd: projectCwd })
      })
    }, true)
  }

  const toggle = (s: SkillSummary, enabled: boolean): void => {
    void runAction(async () => {
      await window.cogent.engineRequest('skills.setEnabled', {
        scope,
        name: s.name,
        value: enabled ? 'enabled' : 'disabled',
        ...(scope === 'project' && projectCwd !== undefined && { cwd: projectCwd })
      })
    })
  }

  const resetOverride = (s: SkillSummary): void => {
    if (projectCwd === undefined) return
    void runAction(async () => {
      await window.cogent.engineRequest('skills.setEnabled', {
        scope: 'project',
        cwd: projectCwd,
        name: s.name,
        value: 'inherit'
      })
    })
  }

  const remove = (s: SkillSummary): void => {
    void runAction(async () => {
      await window.cogent.engineRequest('skills.delete', {
        scope: s.scope,
        name: s.name,
        ...(s.scope === 'project' && projectCwd !== undefined && { cwd: projectCwd })
      })
    })
  }

  const importSkills = (kind: 'directory' | 'zip', overwrite = false): void => {
    void runAction(async () => {
      const result = await window.cogent.importSkills({
        scope,
        kind,
        overwrite,
        ...(scope === 'project' && projectCwd !== undefined && { cwd: projectCwd })
      })
      if (result.canceled) return
      const parts = [`已导入 ${result.imported.length} 枚技能：${result.imported.join('、')}`]
      if (result.skipped.length > 0) parts.push(`已跳过同名：${result.skipped.join('、')}`)
      return parts.join('；')
    })
  }

  const exportSkill = (s: SkillSummary): void => {
    void (async () => {
      setActionError(null)
      setActionNotice(null)
      try {
        const res = await window.cogent.exportSkill({
          scope: s.scope,
          name: s.name,
          ...(scope === 'project' && projectCwd !== undefined && { cwd: projectCwd })
        })
        if (!res.canceled && active.current) setActionNotice(`已导出技能「${s.name}」为 .zip`)
      } catch (error) {
        if (active.current) setActionError(unwrapIpcError(error))
      }
    })()
  }

  const revealDir = (name: string, targetScope: SkillScope): void => {
    void (async () => {
      setActionError(null)
      try {
        await window.cogent.revealSkillDir({
          scope: targetScope,
          name,
          ...(scope === 'project' && projectCwd !== undefined && { cwd: projectCwd })
        })
      } catch (error) {
        if (active.current) setActionError(unwrapIpcError(error))
      }
    })()
  }

  const userScope = scope === 'user'
  const totalCount = skills?.length ?? 0
  const count = skills?.filter((s) => s.invalid !== true).length ?? 0
  const q = query.trim().toLowerCase()
  const visible =
    q === ''
      ? (skills ?? [])
      : (skills ?? []).filter((s) => {
          const diagText = s.diagnostics?.map((d) => d.message).join(' ') ?? ''
          return `${s.name} ${s.description} ${s.whenToUse ?? ''} ${diagText}`.toLowerCase().includes(q)
        })

  const cogentApi = window.cogent as Partial<typeof window.cogent> | undefined
  const canImportExport = typeof cogentApi?.importSkills === 'function'

  return (
    <SettingsPage
      title="技能"
      toolbar={
        <>
          <ScopeMenu state={scopeState} />
          <div className="h-4 w-px bg-border" />
          <div className="text-sm">
            技能 <span className="text-muted-foreground">{count}</span>
          </div>
          <div className="ml-auto flex h-8 w-56 items-center gap-2 rounded-lg bg-accent-foreground/5 px-3">
            <IconSearch className="size-4 shrink-0 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索技能"
              className="h-full w-full min-w-0 bg-transparent text-sm text-foreground outline-none placeholder:text-placeholder"
            />
          </div>
        </>
      }
    >
      {skills === null ? (
        <div className="mt-8 rounded-lg border border-border px-5 py-4 text-xs text-muted-foreground">加载中…</div>
      ) : totalCount === 0 ? (
        userScope ? (
          <div className="mt-8 flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-12 text-center">
            <div className="text-sm font-medium">还没有技能</div>
            <div className="text-xs text-muted-foreground">
              新建、导入本地技能目录或 .zip 包，或把技能放进 ~/.cogent/skills、~/.agents/skills、~/.claude/skills（自动发现）。
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
              {canImportExport && (
                <>
                  <Button variant="outline" size="default" disabled={busy} onClick={() => importSkills('directory')}>
                    <IconFolderPlus className="size-4" />
                    导入目录
                  </Button>
                  <Button variant="outline" size="default" disabled={busy} onClick={() => importSkills('zip')}>
                    <IconFileZip className="size-4" />
                    导入 ZIP
                  </Button>
                </>
              )}
              <Button size="default" disabled={busy} onClick={openCreate}>
                <IconPlus className="size-4" />
                新建技能
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-8 flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-10 text-center">
            <div className="text-xs text-muted-foreground">
              该项目还没有技能 —— 可在本页新建或导入（写入项目 .cogent/skills），或依赖用户级与内置技能。
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              {canImportExport && (
                <>
                  <Button variant="outline" size="default" disabled={busy} onClick={() => importSkills('directory')}>
                    <IconFolderPlus className="size-4" />
                    导入目录
                  </Button>
                  <Button variant="outline" size="default" disabled={busy} onClick={() => importSkills('zip')}>
                    <IconFileZip className="size-4" />
                    导入 ZIP
                  </Button>
                </>
              )}
              <Button size="default" disabled={busy} onClick={openCreate}>
                <IconPlus className="size-4" />
                新建技能
              </Button>
            </div>
          </div>
        )
      ) : visible.length === 0 ? (
        <div className="mt-8 rounded-lg border border-border px-5 py-4 text-xs text-muted-foreground">
          没有匹配「{query.trim()}」的技能
        </div>
      ) : (
        <SettingsGroup
          label={`已安装 ${count}`}
          actions={
            <>
              <Button variant="outline" size="default" disabled={busy} onClick={() => void refresh()} aria-label="刷新">
                <IconRefresh className="size-4" />
              </Button>
              {canImportExport && (
                <>
                  <Button variant="outline" size="default" disabled={busy} onClick={() => importSkills('directory')}>
                    <IconFolderPlus className="size-4" />
                    导入目录
                  </Button>
                  <Button variant="outline" size="default" disabled={busy} onClick={() => importSkills('zip')}>
                    <IconFileZip className="size-4" />
                    导入 ZIP
                  </Button>
                </>
              )}
              <Button size="default" disabled={busy} onClick={openCreate}>
                <IconPlus className="size-4" />
                新建
              </Button>
            </>
          }
        >
          {visible.map((s) => {
            const originTag = originBadgeLabel(s.origin, s.eco)
            const isInvalid = s.invalid === true
            const diags = s.diagnostics ?? []
            const hasError = isInvalid || diags.some((d) => d.severity === 'error')
            const hasWarning = !hasError && diags.some((d) => d.severity === 'warning')
            const isWritableDir =
              s.readonly !== true &&
              s.eco !== true &&
              s.scope !== 'bundled' &&
              (userScope || s.scope === 'project')
            const isEditable = isWritableDir && s.editable !== false
            const isViewable = !isEditable && !(isInvalid && s.editable === false)

            return (
              <div key={`${s.scope}:${s.path}`} className="flex items-center gap-4 px-5 py-4">
                <div
                  className={
                    hasError
                      ? 'flex size-10 shrink-0 items-center justify-center rounded-lg border border-destructive/30 bg-destructive/5'
                      : 'flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-background'
                  }
                >
                  {hasError ? (
                    <IconAlertTriangle className="size-[18px] text-destructive" />
                  ) : (
                    <IconBook className="size-[18px] text-muted-foreground" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium">{s.name}</span>
                    {isInvalid ? (
                      <span className="rounded-md bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">不可用</span>
                    ) : (
                      !s.enabled && <span className={BADGE}>已禁用</span>
                    )}
                    {hasWarning && (
                      <span className="rounded-md bg-warning/10 px-1.5 py-0.5 text-xs text-warning">规范提示</span>
                    )}
                    {s.manualOnly && <span className={BADGE}>仅手动</span>}
                    {s.userInvocable === false && <span className={BADGE}>仅模型</span>}
                    {originTag !== null && <span className={BADGE}>{originTag}</span>}
                    {!userScope && s.scope === 'project' && <span className={BADGE}>项目定义</span>}
                    {s.override !== undefined && <span className={BADGE}>项目覆盖</span>}
                    {s.resourceCount !== undefined && s.resourceCount > 0 && (
                      <span className={BADGE}>{s.resourceCount} 个附带文件</span>
                    )}
                    {s.unsupportedRuntime === 'context-fork' && <span className={BADGE}>主会话兼容</span>}
                  </div>
                  {s.description.length > 0 && (
                    <Hint tip={s.whenToUse !== undefined ? `${s.description}\n触发场景：${s.whenToUse}` : s.description} side="top">
                      <div className="mt-0.5 min-w-0 truncate text-xs text-muted-foreground">
                        {s.description}
                      </div>
                    </Hint>
                  )}
                  {diags.length > 0 && (
                    <div className="mt-1 flex flex-col gap-0.5">
                      {diags.map((d, idx) => (
                        <div
                          key={idx}
                          className={`flex items-start gap-1.5 text-xs leading-relaxed ${
                            d.severity === 'error' ? 'text-destructive' : 'text-warning'
                          }`}
                        >
                          <IconAlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                          <span className="min-w-0 break-words">{d.message}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {isInvalid ? (
                    <Hint tip="技能存在错误，修复后才可启用" side="top">
                      <span className="inline-flex">
                        <Switch checked={false} disabled aria-label={`${s.name} 启用`} />
                      </span>
                    </Hint>
                  ) : (
                    <Switch
                      checked={s.enabled}
                      disabled={busy}
                      onCheckedChange={(checked: boolean) => toggle(s, checked)}
                      aria-label={`${s.name} 启用`}
                    />
                  )}
                  {canImportExport && (
                    <>
                      <Hint tip="打开技能目录" side="top">
                        <Button
                          variant="ghost"
                          size="default"
                          disabled={busy}
                          onClick={() => revealDir(s.name, s.scope)}
                          aria-label={`打开 ${s.name} 目录`}
                        >
                          <IconFolderOpen className="size-4" />
                        </Button>
                      </Hint>
                      {!isInvalid && (
                        <Hint tip="导出为 .zip" side="top">
                          <Button
                            variant="ghost"
                            size="default"
                            disabled={busy}
                            onClick={() => exportSkill(s)}
                            aria-label={`导出 ${s.name}`}
                          >
                            <IconDownload className="size-4" />
                          </Button>
                        </Hint>
                      )}
                    </>
                  )}
                  {isEditable ? (
                    <Button
                      variant="ghost"
                      size="default"
                      disabled={busy}
                      onClick={() => openEditOrView(s)}
                      aria-label={`编辑 ${s.name}`}
                    >
                      <IconPencil className="size-4" />
                    </Button>
                  ) : (
                    isViewable && (
                      <Hint tip="查看技能正文与附带文件" side="top">
                        <Button
                          variant="ghost"
                          size="default"
                          disabled={busy}
                          onClick={() => openEditOrView(s)}
                          aria-label={`查看 ${s.name}`}
                        >
                          <IconEye className="size-4" />
                        </Button>
                      </Hint>
                    )
                  )}
                  {isWritableDir && (
                    <Button
                      variant="ghost"
                      size="default"
                      disabled={busy}
                      onClick={() => remove(s)}
                      aria-label={`删除 ${s.name}`}
                    >
                      <IconTrash className="size-4" />
                    </Button>
                  )}
                  {!userScope && s.override !== undefined && (
                    <Button
                      variant="ghost"
                      size="default"
                      disabled={busy}
                      onClick={() => resetOverride(s)}
                      aria-label={`重置 ${s.name} 的项目覆盖`}
                    >
                      <IconArrowBackUp className="size-4" />
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
        </SettingsGroup>
      )}

      {stateErrors.length > 0 && (
        <div role="alert" className="mt-4 flex flex-col gap-1 rounded-lg border border-destructive/30 px-4 py-3 text-sm text-destructive">
          {stateErrors.map((e, i) => (
            <div key={i} className="break-words">{e}</div>
          ))}
        </div>
      )}

      {actionNotice !== null && (
        <div role="status" className="mt-4 rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm text-foreground">
          {actionNotice}
        </div>
      )}

      {actionError !== null && (
        <div role="alert" className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-destructive/30 px-4 py-3 text-sm text-destructive">
          <span className="min-w-0 flex-1">{actionError}</span>
          {canImportExport && actionError.includes('覆盖导入') && (
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="outline" size="sm" disabled={busy} onClick={() => importSkills('directory', true)}>
                覆盖导入目录
              </Button>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => importSkills('zip', true)}>
                覆盖导入 ZIP
              </Button>
            </div>
          )}
        </div>
      )}

      <SkillDialog
        open={dialogOpen}
        initial={editing}
        saving={busy}
        saveError={saveError}
        onClose={() => setDialogOpen(false)}
        onSave={saveFromDialog}
        onReveal={canImportExport ? revealDir : undefined}
      />
    </SettingsPage>
  )
}
