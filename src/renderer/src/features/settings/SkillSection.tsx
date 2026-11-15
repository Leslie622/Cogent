/**
 * 设置 · 技能分区（阶段 4b-2）：数据真源 = 引擎的技能目录
 * （~/.cogent/skills 用户级 + <工作区>/.cogent/skills 项目级）与两级启停
 * 状态文件（skills.* 经 engine:request 通用代理 —— 引擎独占写者，无壳侧
 * 双写）。与 MCP 座的关键差异：① 技能是被动文本 → 项目级**允许定义**
 * （同名项目胜）；② 段落钩子每回合活算 → 变更**下一回合生效**（无需
 * 新会话，含手放文件）。开关两档：本机·用户写 user 名单；本项目写项目
 * overrides（可禁 user 技能 / 重启用 user 已禁，重置 = inherit 回落）。
 * 搜索 = 本地过滤（名称 / 描述）。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  IconArrowBackUp,
  IconBook,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTrash
} from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SettingsGroup, SettingsPage } from './SettingsParts'
import { BADGE, FIELD_GAP, FIELD_LABEL } from './models-recipes'
import { useChatStore } from '@/stores/chat'
import type { SkillSummary } from '@/env.d'

/** IPC / 解析错误 → 文案（engine:request 直抛 Error，失败原样呈现给用户） */
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** 作用域两档（与 MCP 页同位） */
const SCOPES = [
  { value: 'user', label: '本机 · 用户' },
  { value: 'project', label: '本项目' }
] as const

type SectionScope = (typeof SCOPES)[number]['value']

/** 编辑弹窗的回填载荷（skills.read 取回；新增传 null） */
interface SkillDraft {
  name: string
  description: string
  body: string
}

/**
 * 新增/编辑弹窗：name（编辑锁）+ description + 正文 Markdown。frontmatter
 * 由引擎生成（防手写错），这里只编辑业务字段；值域校验在引擎 skills.save
 * 入口（名字字符规则 / 描述长度），失败原样呈现。
 */
function SkillDialog({
  open,
  initial,
  onClose,
  onSave
}: {
  open: boolean
  initial: SkillDraft | null
  onClose: () => void
  onSave: (draft: SkillDraft) => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(initial?.name ?? '')
    setDescription(initial?.description ?? '')
    setBody(initial?.body ?? '')
    setFormError(null)
  }, [open, initial])

  const save = (): void => {
    if (name.trim().length === 0) {
      setFormError('名称必填（小写字母 / 数字 / 连字符）')
      return
    }
    if (description.trim().length === 0) {
      setFormError('描述必填（模型按它判断何时用这个技能）')
      return
    }
    onSave({ name: name.trim(), description: description.trim(), body })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{initial !== null ? '编辑技能' : '新建技能'}</DialogTitle>
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
            <div className={FIELD_LABEL}>描述（何时用这个技能）</div>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="如 提交前的检查清单与顺序"
              className="mt-1.5"
            />
          </div>
          <div className={FIELD_GAP}>
            <div className={FIELD_LABEL}>正文（Markdown 指令，frontmatter 由引擎生成）</div>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={'1. …\n2. …'}
              rows={10}
              className="mt-1.5 font-mono text-[12px]"
            />
          </div>
        </div>
        {formError !== null && <div className="mt-3 text-[13px] text-destructive">{formError}</div>}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button size="sm" onClick={save}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function SkillSection() {
  /** null = 加载中（首拉未返回） */
  const [skills, setSkills] = useState<SkillSummary[] | null>(null)
  const [fileErrors, setFileErrors] = useState<string[]>([])
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  /** null = 新增；编辑态 = skills.read 取回的回填载荷 */
  const [editing, setEditing] = useState<SkillDraft | null>(null)
  const [scope, setScope] = useState<SectionScope>('user')
  const [query, setQuery] = useState('')

  /** 项目作用域的 cwd：当前活跃会话的工作区（无绑定会话 = 项目档不可用） */
  const projectCwd = useChatStore((s) => s.sessions.find((x) => x.id === s.activeSessionId)?.cwd)

  const refresh = useCallback(async () => {
    if (scope === 'project' && projectCwd === undefined) {
      setSkills([])
      return
    }
    try {
      const r = await window.cogent.engineRequest('skills.list', scope === 'project' ? { cwd: projectCwd } : {})
      setSkills(r.skills)
      setFileErrors(r.errors)
    } catch (error) {
      setActionError(messageOf(error))
    }
  }, [scope, projectCwd])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** 写动作共用骨架：成功清错重拉，失败原样呈现 */
  const runAction = async (call: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await call()
      setActionError(null)
      await refresh()
    } catch (error) {
      setActionError(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  const openCreate = (): void => {
    setEditing(null)
    setDialogOpen(true)
  }

  /** 编辑：先 skills.read 取正文回填（list 不带 body），失败原地报错不开弹窗 */
  const openEdit = (s: SkillSummary): void => {
    void (async () => {
      try {
        const r = await window.cogent.engineRequest('skills.read', {
          scope: s.scope,
          name: s.name,
          ...(scope === 'project' && projectCwd !== undefined && { cwd: projectCwd })
        })
        setEditing({ name: s.name, description: r.description, body: r.body })
        setDialogOpen(true)
      } catch (error) {
        setActionError(messageOf(error))
      }
    })()
  }

  const saveFromDialog = (draft: SkillDraft): void => {
    setDialogOpen(false)
    void runAction(() =>
      window.cogent.engineRequest('skills.save', {
        scope,
        name: draft.name,
        description: draft.description,
        body: draft.body,
        ...(scope === 'project' && projectCwd !== undefined && { cwd: projectCwd })
      })
    )
  }

  /** 开关：user 档写禁用名单；project 档写 overrides（对任何行 —— 覆盖按名） */
  const toggle = (s: SkillSummary, enabled: boolean): void => {
    void runAction(() =>
      window.cogent.engineRequest('skills.setEnabled', {
        scope,
        name: s.name,
        value: enabled ? 'enabled' : 'disabled',
        ...(scope === 'project' && projectCwd !== undefined && { cwd: projectCwd })
      })
    )
  }

  const resetOverride = (s: SkillSummary): void => {
    if (projectCwd === undefined) return
    void runAction(() =>
      window.cogent.engineRequest('skills.setEnabled', { scope: 'project', cwd: projectCwd, name: s.name, value: 'inherit' })
    )
  }

  const remove = (s: SkillSummary): void => {
    void runAction(() =>
      window.cogent.engineRequest('skills.delete', {
        scope: s.scope,
        name: s.name,
        ...(s.scope === 'project' && projectCwd !== undefined && { cwd: projectCwd })
      })
    )
  }

  const userScope = scope === 'user'
  const count = skills?.length ?? 0
  const q = query.trim().toLowerCase()
  const visible = q === '' ? (skills ?? []) : (skills ?? []).filter((s) => `${s.name} ${s.description}`.toLowerCase().includes(q))

  return (
    <SettingsPage
      title="技能"
      desc={
        userScope ? (
          <>
            技能 = SKILL.md 指令包：清单进系统提示、正文由模型按需自取（渐进加载）。
            存储于用户级 ~/.cogent/skills，变更<strong>下一回合生效</strong>（无需新会话，
            手放的文件同样会被发现）；项目可在「本项目」放同名技能覆盖或按名启停。
          </>
        ) : (
          <>
            项目作用域 = 工作区 <span className="font-mono">{projectCwd ?? '—'}</span> 下的 .cogent/skills：
            同名技能覆盖用户级（近者胜），也可在本页直接新建项目技能；
            开关写项目覆盖（可禁用 / 重启用用户级技能），「重置」清除覆盖回落。
          </>
        )
      }
      toolbar={
        <>
          <Select value={scope} items={SCOPES} onValueChange={(next) => next !== null && setScope(next)}>
            <SelectTrigger aria-label="作用域">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {SCOPES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <div className="text-sm">
            <span className="font-medium">已安装</span> <span className="text-muted-foreground">{count}</span>
          </div>
          <div className="ml-auto flex h-8 w-56 items-center gap-2 rounded-full bg-accent-foreground/5 px-3">
            <IconSearch className="size-4 shrink-0 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索技能"
              className="h-full w-full min-w-0 bg-transparent text-[13px] text-foreground outline-none placeholder:text-placeholder"
            />
          </div>
          <Button variant="outline" size="icon-sm" disabled={busy} onClick={() => void refresh()} aria-label="刷新">
            <IconRefresh className="size-4" />
          </Button>
          <Button size="sm" disabled={busy || (!userScope && projectCwd === undefined)} onClick={openCreate}>
            <IconPlus className="size-4" />
            新建
          </Button>
        </>
      }
    >
      {skills === null ? (
        <div className="mt-3 rounded-xl border border-border px-5 py-4 text-[13px] text-muted-foreground">加载中…</div>
      ) : !userScope && projectCwd === undefined ? (
        <div className="mt-3 rounded-xl border border-dashed border-border px-6 py-10 text-center text-[13px] text-muted-foreground">
          当前没有绑定工作区的活跃会话 —— 在聊天里选中一个项目会话后，这里显示该项目的技能与覆盖设置。
        </div>
      ) : count === 0 ? (
        userScope ? (
          <div className="mt-3 flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-12 text-center">
            <div className="text-sm font-medium">还没有技能</div>
            <div className="text-[13px] text-muted-foreground">新建一枚，或把 SKILL.md 技能包放进 ~/.cogent/skills（自动发现）。</div>
            <div className="mt-2 flex items-center gap-2">
              <Button size="sm" disabled={busy} onClick={openCreate}>
                <IconPlus className="size-4" />
                新建技能
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-3 rounded-xl border border-dashed border-border px-6 py-10 text-center text-[13px] text-muted-foreground">
            本项目还没有技能 —— 可在本页新建（写入项目 .cogent/skills），或依赖用户级技能。
          </div>
        )
      ) : visible.length === 0 ? (
        <div className="mt-3 rounded-xl border border-border px-5 py-4 text-[13px] text-muted-foreground">
          没有匹配「{query.trim()}」的技能
        </div>
      ) : (
        <SettingsGroup label="">
          {visible.map((s) => (
            <div key={s.name} className="flex items-center gap-4 px-5 py-4">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
                <IconBook className="size-[18px] text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{s.name}</span>
                  {!s.enabled && <span className={BADGE}>已禁用</span>}
                  {s.manualOnly && <span className={BADGE}>手动调用</span>}
                  {!userScope && s.scope === 'project' && <span className={BADGE}>项目定义</span>}
                  {s.override !== undefined && <span className={BADGE}>项目覆盖</span>}
                </div>
                <div className="mt-0.5 truncate text-[13px] text-muted-foreground" title={s.path}>
                  {s.description}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Switch
                  checked={s.enabled}
                  disabled={busy}
                  onCheckedChange={(checked: boolean) => toggle(s, checked)}
                  aria-label={`${s.name} 启用`}
                />
                {userScope || s.scope === 'project' ? (
                  <>
                    <Button variant="ghost" size="icon-xs" disabled={busy} onClick={() => openEdit(s)} aria-label={`编辑 ${s.name}`}>
                      <IconPencil className="size-4" />
                    </Button>
                    <Button variant="ghost" size="icon-xs" disabled={busy} onClick={() => remove(s)} aria-label={`删除 ${s.name}`}>
                      <IconTrash className="size-4" />
                    </Button>
                  </>
                ) : null}
                {!userScope && s.override !== undefined && (
                  /* 项目档专属：清除覆盖（inherit = 回落用户级求值） */
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={busy}
                    onClick={() => resetOverride(s)}
                    aria-label={`重置 ${s.name} 的项目覆盖`}
                  >
                    <IconArrowBackUp className="size-4" />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </SettingsGroup>
      )}

      {fileErrors.length > 0 && (
        <SettingsGroup label="配置诊断">
          {fileErrors.map((e, i) => (
            <div key={i} className="px-5 py-3 text-[13px] leading-relaxed text-destructive">
              {e}
            </div>
          ))}
        </SettingsGroup>
      )}

      {actionError !== null && (
        <div className="mt-4 rounded-lg border border-destructive/30 px-4 py-3 text-[13px] text-destructive">
          {actionError}
        </div>
      )}

      <SkillDialog open={dialogOpen} initial={editing} onClose={() => setDialogOpen(false)} onSave={saveFromDialog} />
    </SettingsPage>
  )
}
