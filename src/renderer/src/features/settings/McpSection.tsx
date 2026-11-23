/**
 * 设置 · MCP 服务器分区（阶段 4a-2，2026-11-15 按 zcode 参考稿重排 + 作用域）：
 * 数据真源 = 引擎的 ~/.cogent/mcp.json（mcp.list / mcp.sync / mcp.override
 * 经 engine:request 通用代理 —— 引擎独占写者，无壳侧双写）。全量替换语义：
 * 每次改动整表 mcp.sync；页头明示「变更新会话生效」（会话装配时快照定格）。
 * 作用域（zcode 对齐）：本机·用户 = 全局定义面（增删改/导入）；
 * 项目 = 合并视图 + 项目 override 写入（开关落工作区 .cogent/mcp.json，
 * 只影响该项目；重置 = 清除 override 回落用户级）。作用域下拉 = 本机·用户
 * + 全部项目（useProjectScope：默认跟随活跃会话归属项目，可任意切换；
 * 项目 cwd = 主根 cwds[0]）。搜索 = 本地过滤（名称/命令行·URL/描述）。
 * 连接状态点（zcode 绿/红）无数据面 —— Host 是 headless，连接状态在 pi
 * 会话内部，需协议扩展才能暴露（后续候选，见 模块/MCP座.md 边界）。
 * 新增/编辑弹窗（表单/JSON 双模式）在 McpServerDialog.tsx；纯序列化/解析
 * 在 mcp-import.ts（2026-11-17 会话状态重构 P6 拆出）。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  IconArrowBackUp,
  IconDownload,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTerminal2,
  IconTrash,
  IconWorld
} from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { SettingsGroup, SettingsPage } from './SettingsParts'
import { ScopeMenu } from './ScopeMenu'
import { BADGE, FIELD_LABEL } from './models-recipes'
import { unwrapIpcError } from '@/lib/ipc'
import { parseImport } from './mcp-import'
import { McpServerDialog } from './McpServerDialog'
import { useProjectScope } from '@/hooks/use-project-scope'
import type { McpExposure, McpServerDef, McpServerSummary } from '@/env.d'
import { MediaBindingsSection } from './MediaBindingsSection'

/** IPC / 解析错误 → 文案（engine:request 直抛 Error，失败原样呈现给用户） */
const messageOf = (error: unknown): string => unwrapIpcError(error)

/** 导入弹窗：粘贴生态通用形状的 JSON（{"mcpServers": { … }}），重名覆盖 */
function ImportDialog({
  open,
  onClose,
  onImport
}: {
  open: boolean
  onClose: () => void
  onImport: (defs: McpServerDef[]) => void
}) {
  const [text, setText] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setText('')
      setFormError(null)
    }
  }, [open])

  const run = (): void => {
    if (text.trim().length === 0) {
      setFormError('粘贴要导入的 JSON')
      return
    }
    try {
      const { defs, errors } = parseImport(text)
      if (defs.length === 0) {
        setFormError(errors.length > 0 ? errors.join('；') : '没有可导入的服务器')
        return
      }
      onImport(defs)
    } catch (error) {
      setFormError(messageOf(error))
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>导入 MCP 服务器</DialogTitle>
        </DialogHeader>
        <div>
          <div className={FIELD_LABEL}>粘贴配置 JSON（与 Claude Desktop / zcode 等互拷的 mcpServers 形状）</div>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'{\n  "mcpServers": {\n    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }\n  }\n}'}
            rows={8}
            className="mt-1.5 font-mono text-xs"
          />
        </div>
        {formError !== null && <div className="mt-3 text-sm leading-relaxed text-destructive">{formError}</div>}
        <DialogFooter>
          <Button variant="ghost" size="default" onClick={onClose}>
            取消
          </Button>
          <Button size="default" onClick={run}>
            导入
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 列表缓存（模块级，按作用域键）：分区切换 = 组件重挂载，本地 state 归零
    会让页面先塌成加载卡、IPC 往返回来再弹起（跨进程 + 扫盘，肉眼可见）。
    命中缓存先渲染旧值、后台照常刷新（stale-while-revalidate），仅首访出加载卡 */
const serversCache = new Map<string, McpServerSummary[]>()

export function McpSection() {
  /** null = 加载中（仅该作用域首次访问、缓存未命中时短暂出现） */
  const [servers, setServers] = useState<McpServerSummary[] | null>(null)
  const [fileErrors, setFileErrors] = useState<string[]>([])
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [editing, setEditing] = useState<McpServerDef | null>(null)
  const [query, setQuery] = useState('')

  /**
   * 作用域选择：本机·用户 / 任一项目（useProjectScope，默认跟随活跃
   * 会话归属的项目，手动挑过即固定）；项目档 cwd = 该项目主根 cwds[0]
   */
  const scopeState = useProjectScope()
  const { scope, projectCwd } = scopeState

  const scopeKey = scope === 'project' ? `project:${projectCwd}` : 'user'
  const refresh = useCallback(async () => {
    // 缓存命中先顶上（切分区/切作用域回来不闪加载卡），拿到新值后原位替换
    const cached = serversCache.get(scopeKey)
    if (cached !== undefined) setServers(cached)
    try {
      const r = await window.cogent.engineRequest('mcp.list', scope === 'project' ? { cwd: projectCwd } : {})
      serversCache.set(scopeKey, r.servers)
      setServers(r.servers)
      setFileErrors(r.errors)
    } catch (error) {
      setActionError(messageOf(error))
    }
  }, [scope, projectCwd, scopeKey])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** 全量同步（替换语义，用户作用域写路径）：成功后重拉；引擎校验失败原样呈现 */
  const sync = async (next: McpServerDef[]): Promise<void> => {
    setBusy(true)
    try {
      await window.cogent.engineRequest('mcp.sync', { servers: next })
      setActionError(null)
      await refresh()
    } catch (error) {
      setActionError(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  /** 项目 override 写入（项目作用域写路径）：全量替换该项 override */
  const applyOverride = async (
    name: string,
    patch: { enabled?: boolean; exposure?: McpExposure }
  ): Promise<void> => {
    if (projectCwd === undefined) return
    setBusy(true)
    try {
      await window.cogent.engineRequest('mcp.override', { cwd: projectCwd, name, ...patch })
      setActionError(null)
      await refresh()
    } catch (error) {
      setActionError(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  const saveFromDialog = (def: McpServerDef, originalName: string | null): void => {
    // 替换同名条目（编辑）或追加（新增）—— mcp.sync 是全量替换，重名以表单为准
    const next = [
      ...(servers ?? [])
        .filter((s) => s.name !== def.name && s.name !== originalName)
        .map((s) => s.def),
      def
    ]
    setDialogOpen(false)
    void sync(next)
  }

  /** 导入合并：重名覆盖（导入值是用户刚确认的最新意图），其余保留，新增追加 */
  const importFromDialog = (defs: McpServerDef[]): void => {
    const merged = new Map((servers ?? []).map((s) => [s.name, s.def]))
    for (const def of defs) merged.set(def.name, def)
    setImportOpen(false)
    void sync([...merged.values()])
  }

  const toggle = (summary: McpServerSummary, enabled: boolean): void => {
    if (scope === 'project') {
      // 项目档开关 = override（保留同项的另一键，全量替换语义）
      void applyOverride(summary.name, {
        enabled,
        ...(summary.override?.exposure !== undefined && { exposure: summary.override.exposure })
      })
      return
    }
    const next = (servers ?? []).map((s) => (s.name === summary.name ? { ...s.def, enabled } : s.def))
    void sync(next)
  }

  const remove = (summary: McpServerSummary): void => {
    const next = (servers ?? []).filter((s) => s.name !== summary.name).map((s) => s.def)
    void sync(next)
  }

  const userScope = scope === 'user'
  const count = servers?.length ?? 0
  // 搜索 = 本地过滤（名称 / 命令行·URL / 描述）
  const q = query.trim().toLowerCase()
  const visible = q === '' ? (servers ?? []) : (servers ?? []).filter((s) =>
    `${s.name} ${s.detail} ${s.description ?? ''}`.toLowerCase().includes(q)
  )

  return (
    <SettingsPage
      title="MCP 服务器"
      toolbar={
        <>
          <ScopeMenu state={scopeState} />
          {/* 总计数（zcode 同位：竖分隔线 + 「服务器 N」） */}
          <div className="h-4 w-px bg-border" />
          <div className="text-sm">
            服务器 <span className="text-muted-foreground">{count}</span>
          </div>
          {/* 搜索框：与侧栏同款裸 input 手搭（黑 5% 软叠底）；圆角 lg 档与表单控件统一 */}
          <div className="ml-auto flex h-8 w-56 items-center gap-2 rounded-lg bg-accent-foreground/5 px-3">
            <IconSearch className="size-4 shrink-0 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索 MCP 服务器"
              className="h-full w-full min-w-0 bg-transparent text-sm text-foreground outline-none placeholder:text-placeholder"
            />
          </div>
        </>
      }
    >
      {servers !== null && userScope && <MediaBindingsSection servers={servers} />}
      {servers === null ? (
        <div className="mt-8 rounded-lg border border-border px-5 py-4 text-xs text-muted-foreground">加载中…</div>
      ) : count === 0 ? (
        userScope ? (
          /* 空态（zcode 形态）：虚线卡 + 主副文案 + 新建/导入双入口 */
          <div className="mt-8 flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-12 text-center">
            <div className="text-sm font-medium">尚未安装 MCP 服务器</div>
            <div className="text-xs text-muted-foreground">手动新建服务器，或导入已有配置。</div>
            <div className="mt-2 flex items-center gap-2">
              <Button
                size="default"
                disabled={busy}
                onClick={() => {
                  setEditing(null)
                  setDialogOpen(true)
                }}
              >
                <IconPlus className="size-4" />
                新建 MCP 服务器
              </Button>
              <Button variant="outline" size="default" disabled={busy} onClick={() => setImportOpen(true)}>
                <IconDownload className="size-4" />
                导入
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-8 rounded-lg border border-dashed border-border px-6 py-10 text-center text-xs text-muted-foreground">
            没有可覆盖的服务器 —— 先在「本机 · 用户」作用域添加 MCP 服务器。
          </div>
        )
      ) : visible.length === 0 ? (
        <div className="mt-8 rounded-lg border border-border px-5 py-4 text-xs text-muted-foreground">
          没有匹配「{query.trim()}」的服务器
        </div>
      ) : (
        <SettingsGroup
          label={`已安装 ${count}`}
          actions={
            <>
              <Button variant="outline" size="default" disabled={busy} onClick={() => void refresh()} aria-label="刷新">
                <IconRefresh className="size-4" />
              </Button>
              {userScope && (
                <>
                  <Button variant="outline" size="default" disabled={busy} onClick={() => setImportOpen(true)}>
                    <IconDownload className="size-4" />
                    导入
                  </Button>
                  <Button
                    size="default"
                    disabled={busy}
                    onClick={() => {
                      setEditing(null)
                      setDialogOpen(true)
                    }}
                  >
                    <IconPlus className="size-4" />
                    新建
                  </Button>
                </>
              )}
            </>
          }
        >
          {visible.map((s) => (
            <div key={s.name} className="flex items-center gap-4 px-5 py-4">
              {/* 类型图标方块（zcode 形态；无连接状态可标 —— 见文件头注释） */}
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
                {s.type === 'http' ? (
                  <IconWorld className="size-[18px] text-muted-foreground" />
                ) : (
                  <IconTerminal2 className="size-[18px] text-muted-foreground" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{s.name}</span>
                  {!s.enabled && <span className={BADGE}>已禁用</span>}
                  <span className={BADGE}>{s.exposure}</span>
                  {s.overrideApplied === true && <span className={BADGE}>项目覆盖</span>}
                </div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                  {s.detail}
                  {s.description !== undefined ? ` · ${s.description}` : ''}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Switch
                  checked={s.enabled}
                  disabled={busy}
                  onCheckedChange={(checked: boolean) => toggle(s, checked)}
                  aria-label={`${s.name} 启用`}
                />
                {userScope ? (
                  <>
                    <Button
                      variant="ghost"
                      size="default"
                      disabled={busy}
                      onClick={() => {
                        setEditing(s.def)
                        setDialogOpen(true)
                      }}
                      aria-label={`编辑 ${s.name}`}
                    >
                      <IconPencil className="size-4" />
                    </Button>
                    <Button variant="ghost" size="default" disabled={busy} onClick={() => remove(s)} aria-label={`删除 ${s.name}`}>
                      <IconTrash className="size-4" />
                    </Button>
                  </>
                ) : (
                  s.overrideApplied === true && (
                    /* 项目档专属：清除覆盖（空 patch = 回落用户级） */
                    <Button
                      variant="ghost"
                      size="default"
                      disabled={busy}
                      onClick={() => void applyOverride(s.name, {})}
                      aria-label={`重置 ${s.name} 的项目覆盖`}
                    >
                      <IconArrowBackUp className="size-4" />
                    </Button>
                  )
                )}
              </div>
            </div>
          ))}
        </SettingsGroup>
      )}

      {fileErrors.length > 0 && (
        <SettingsGroup label="配置诊断">
          {fileErrors.map((e, i) => (
            <div key={i} className="px-5 py-3 text-sm leading-relaxed text-destructive">
              {e}
            </div>
          ))}
        </SettingsGroup>
      )}

      {actionError !== null && (
        <div className="mt-4 rounded-lg border border-destructive/30 px-4 py-3 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <McpServerDialog open={dialogOpen} initial={editing} onClose={() => setDialogOpen(false)} onSave={saveFromDialog} />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} onImport={importFromDialog} />
    </SettingsPage>
  )
}
