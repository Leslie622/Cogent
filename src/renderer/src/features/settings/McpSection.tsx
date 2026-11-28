/**
 * MCP 设置：配置由 Host 单写；状态与工具来自共享连接池事件。
 * 作用域绑定项目稳定 ID 与主根，旧作用域回包及写入结果不能污染新视图。
 * 低信项目定义先审阅；设置页聚焦服务器、工具与认证（docs/模块/MCP座.md）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  IconArrowBackUp,
  IconChevronDown,
  IconChevronRight,
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
import { showErrorToast } from '@/components/ui/sonner'
import { Switch } from '@/components/ui/switch'
import { SettingsGroup, SettingsPage } from './SettingsParts'
import { ScopeMenu } from './ScopeMenu'
import { BADGE } from './models-recipes'
import { unwrapIpcError } from '@/lib/ipc'
import { McpServerDialog } from './McpServerDialog'
import { useProjectScope, type ProjectScope } from '@/hooks/use-project-scope'
import { useSettingsStore } from '@/stores/settings'
import type { McpExposure, McpServerDef, McpServerSummary } from '@/env.d'
import { McpImportDialog, McpOAuthDialog } from './McpManagementDialogs'
import { McpServerDetails } from './McpServerDetails'
import type { McpPendingTrustFile, McpScope } from '@shared/mcp'

/** IPC / 解析错误 → 文案（engine:request 直抛 Error，失败原样呈现给用户） */
const messageOf = (error: unknown): string => unwrapIpcError(error)

/** 列表缓存（模块级，按作用域键）：分区切换 = 组件重挂载，本地 state 归零
    会让页面先塌成加载卡、IPC 往返回来再弹起（跨进程 + 扫盘，肉眼可见）。
    命中缓存先渲染旧值、后台照常刷新（stale-while-revalidate），仅首访出加载卡 */
const serversCache = new Map<string, McpServerSummary[]>()

export function McpSection() {
  const baseScope = useProjectScope()
  const locateRequest = useSettingsStore((s) => s.locateRequest)
  const clearLocate = useSettingsStore((s) => s.clearLocate)

  // 搜索定位 MCP 用户级配置项时，先切到「本机 · 用户」作用域，再由列表加载后挂载目标行消费
  useEffect(() => {
    if (
      locateRequest?.section === 'connections' &&
      locateRequest.scope === 'user' &&
      !locateRequest.consumed &&
      baseScope.selectValue !== 'user'
    ) {
      baseScope.pick('user')
    }
  }, [locateRequest, baseScope])

  const scopeState: ProjectScope = {
    ...baseScope,
    pick: (value) => {
      if (locateRequest?.section === 'connections') {
        clearLocate(locateRequest.token)
      }
      baseScope.pick(value)
    },
  }

  const scopeKey = JSON.stringify([scopeState.selectValue, scopeState.projectCwd])
  return <McpScope key={scopeKey} scopeKey={scopeKey} scopeState={scopeState} />
}

/** 列表和弹窗跟随作用域实例，写请求仍由发起时的项目处理。 */
function McpScope({ scopeState, scopeKey }: { scopeState: ProjectScope; scopeKey: string }) {
  /** null = 加载中（仅该作用域首次访问、缓存未命中时短暂出现） */
  const [servers, setServers] = useState<McpServerSummary[] | null>(() => serversCache.get(scopeKey) ?? null)
  const [fileErrors, setFileErrors] = useState<string[]>([])
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [editing, setEditing] = useState<McpServerDef | null>(null)
  const [query, setQuery] = useState('')
  const [pendingTrust, setPendingTrust] = useState<McpPendingTrustFile[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loginServer, setLoginServer] = useState<string | null>(null)
  const active = useRef(false)
  const latestRead = useRef<symbol | null>(null)

  /**
   * 作用域选择：本机·用户 / 任一项目（useProjectScope，默认跟随活跃
   * 会话归属的项目，手动挑过即固定）；项目档 cwd = 该项目主根 cwds[0]
   */
  const { scope, projectCwd, project } = scopeState
  const projectId = project?.id
  const rpcScope: McpScope = scope === 'project' ? { cwd: projectCwd, projectId } : {}

  const refresh = useCallback(async () => {
    if (!active.current) return
    const read = Symbol(scopeKey)
    latestRead.current = read
    try {
      const r = await window.cogent.engineRequest('mcp.list', scope === 'project' ? { cwd: projectCwd, projectId } : {})
      if (latestRead.current !== read) return
      serversCache.set(scopeKey, r.servers)
      setServers(r.servers)
      setFileErrors(r.errors)
      setPendingTrust(r.pendingTrustFiles ?? [])
    } catch (error) {
      if (latestRead.current === read) setActionError(messageOf(error))
    }
  }, [scope, projectCwd, projectId, scopeKey])

  useLayoutEffect(() => {
    active.current = true
    void refresh()
    return () => { active.current = false; latestRead.current = null }
  }, [refresh])

  useEffect(() => window.cogent.onEngineEvent((event) => {
    if (event.method !== 'mcp.statusChanged') return
    if (scope === 'user') {
      if (event.params.projectId !== undefined || event.params.cwd !== undefined) return
    } else if (event.params.projectId !== projectId || event.params.cwd !== projectCwd) return
    setServers((current) => {
      if (current === null) return current
      const next = current.map((server) => {
        const runtime = event.params.servers.find((status) => status.name === server.name && (server.runtime === undefined || status.poolKey === server.runtime.poolKey))
        return runtime === undefined ? server : { ...server, runtime }
      })
      serversCache.set(scopeKey, next)
      return next
    })
    for (const server of event.params.servers) if (server.state === 'connected') setLoginServer((current) => current === server.name ? null : current)
  }), [scope, projectCwd, projectId, scopeKey])

  const write = async (operation: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true)
    try {
      await operation()
      // 用户定义会影响全部项目视图，项目覆盖只影响自己的缓存。
      if (scope === 'user') serversCache.clear()
      else serversCache.delete(scopeKey)
      if (active.current) {
        setActionError(null)
        await refresh()
      }
      return true
    } catch (error) {
      const message = messageOf(error)
      if (active.current) setActionError(message)
      else showErrorToast(`${scopeState.project?.name ?? '本机 · 用户'}的 MCP 设置：${message}`)
      return false
    } finally {
      if (active.current) setBusy(false)
    }
  }

  const sync = (next: McpServerDef[]) => write(() => window.cogent.engineRequest('mcp.sync', { servers: next }))

  /** 项目 override 写入（项目作用域写路径）：全量替换该项 override */
  const applyOverride = async (
    name: string,
    patch: { enabled?: boolean; exposure?: McpExposure; toolExposure?: Record<string, McpExposure> }
  ): Promise<void> => {
    if (projectCwd === undefined) return
    await write(() => window.cogent.engineRequest('mcp.override', { cwd: projectCwd, name, ...patch }))
  }

  const saveFromDialog = async (def: McpServerDef, originalName: string | null): Promise<boolean> => {
    // 替换同名条目（编辑）或追加（新增）—— mcp.sync 是全量替换，重名以表单为准
    const next = [
      ...(servers ?? [])
        .filter((s) => s.name !== def.name && s.name !== originalName)
        .map((s) => s.def),
      def
    ]
    const saved = await sync(next)
    if (saved && active.current) setDialogOpen(false)
    return saved
  }

  /** 导入合并：重名覆盖（导入值是用户刚确认的最新意图），其余保留，新增追加 */
  const importFromDialog = async (defs: McpServerDef[]): Promise<boolean> => {
    const merged = new Map((servers ?? []).map((s) => [s.name, s.def]))
    for (const def of defs) merged.set(def.name, def)
    return sync([...merged.values()])
  }

  const toggle = (summary: McpServerSummary, enabled: boolean): void => {
    if (scope === 'project') {
      // 项目档开关 = override（保留同项的另一键，全量替换语义）
      void applyOverride(summary.name, {
        ...summary.override,
        enabled,
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

  const changeExposure = (summary: McpServerSummary, tool: string | undefined, exposure: McpExposure): void => {
    const patch = tool === undefined ? { exposure } : { toolExposure: { ...summary.toolExposure, [tool]: exposure } }
    if (scope === 'project') void applyOverride(summary.name, { ...summary.override, ...patch })
    else void sync((servers ?? []).map((server) => server.name === summary.name ? { ...server.def, ...patch } : server.def))
  }

  const trust = (file: McpPendingTrustFile, decision: 'trust' | 'reject'): void => {
    if (projectId === undefined || projectCwd === undefined) return
    void write(() => window.cogent.engineRequest('mcp.trust.decide', { projectId, cwd: projectCwd, filePath: file.filePath, sha256: file.sha256, decision }))
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
        <div className="flex w-full flex-wrap items-center gap-2">
          <ScopeMenu state={scopeState} />
          {/* 总计数（zcode 同位：竖分隔线 + 「服务器 N」） */}
          <div className="h-4 w-px bg-border" />
          <div className="shrink-0 whitespace-nowrap text-sm">
            服务器 <span className="text-muted-foreground">{count}</span>
          </div>
          {/* 搜索框：与侧栏同款裸 input 手搭（黑 5% 软叠底）；圆角 lg 档与表单控件统一 */}
          <div className="ml-auto flex h-8 min-w-0 flex-1 basis-52 items-center gap-2 rounded-lg bg-accent-foreground/5 px-3">
            <IconSearch className="size-4 shrink-0 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索 MCP 服务器"
              className="h-full w-full min-w-0 bg-transparent text-sm text-foreground outline-none placeholder:text-placeholder"
            />
          </div>
        </div>
      }
    >
      {pendingTrust.map((file) => <div key={file.filePath} className="mt-6 flex flex-col gap-3 rounded-lg border border-border p-4">
        <p className="text-sm font-medium">审阅项目 MCP 配置</p><p className="break-all text-xs text-muted-foreground">{file.filePath}</p>
        {file.servers.map((server) => <div key={server.name}><p className="text-sm">{server.name} · {server.type}</p><code className="block break-all text-xs">{server.command ?? server.url}</code><p className="text-xs text-muted-foreground">环境变量：{server.envKeys.join('、') || '无'} · 请求头：{server.headerKeys.join('、') || '无'}</p></div>)}
        <div className="flex gap-2"><Button size="xs" disabled={busy || projectId === undefined} onClick={() => trust(file, 'trust')}>信任并启用</Button><Button variant="outline" size="xs" disabled={busy || projectId === undefined} onClick={() => trust(file, 'reject')}>拒绝</Button></div>
      </div>)}
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
            <div key={s.name}><div className="flex flex-wrap items-center gap-3 px-5 py-4">
              <div className="flex min-w-0 flex-1 basis-56 items-center gap-3">
              {/* 传输图标与连接状态分开，远程 SSE/HTTP 共用网络图标。 */}
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
                {s.type !== 'stdio' ? (
                  <IconWorld className="size-[18px] text-muted-foreground" />
                ) : (
                  <IconTerminal2 className="size-[18px] text-muted-foreground" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span aria-label={`${s.name} 状态：${s.runtime?.state ?? (s.enabled ? 'disconnected' : 'disabled')}`} className={`size-2 shrink-0 rounded-full ${s.runtime?.state === 'connected' ? 'bg-emerald-500' : s.runtime?.state === 'connecting' ? 'animate-pulse bg-blue-500' : s.runtime?.state === 'failed' ? 'bg-destructive' : s.runtime?.state === 'needs-auth' || s.runtime?.state === 'untrusted' ? 'bg-amber-500' : 'bg-muted-foreground/50'}`} />
                  <span className="truncate text-sm font-medium">{s.name}</span>
                  {!s.enabled && <span className={`${BADGE} shrink-0 whitespace-nowrap`}>已禁用</span>}
                  <span className={`${BADGE} shrink-0 whitespace-nowrap`}>{s.exposure}</span>
                  {s.overrideApplied === true && <span className={`${BADGE} shrink-0 whitespace-nowrap`}>项目覆盖</span>}
                  {s.origin !== undefined && s.origin !== 'user' && <span className={`${BADGE} shrink-0 whitespace-nowrap`}>{s.origin === 'project-file' ? '项目 .mcp.json' : '项目 .cogent'}</span>}
                  {s.runtime !== undefined && <span className={`${BADGE} shrink-0 whitespace-nowrap`}>{s.runtime.tools.length} 工具</span>}
                  {s.runtime?.latencyMs !== undefined && <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">{s.runtime.latencyMs} ms</span>}
                </div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                  {s.detail}
                  {s.description !== undefined ? ` · ${s.description}` : ''}
                </div>
              </div>
              </div>
              <div className="ml-auto flex max-w-full shrink-0 flex-wrap items-center gap-1">
                {s.runtime?.state === 'needs-auth' && <Button variant="outline" size="xs" disabled={busy} onClick={() => setLoginServer(s.name)}>登录</Button>}
                {s.runtime?.oauthAuthorized === true && <Button variant="ghost" size="xs" disabled={busy} onClick={() => void write(() => window.cogent.engineRequest('mcp.oauth.logout', { ...rpcScope, name: s.name }))}>登出</Button>}
                <Button variant="ghost" size="xs" disabled={busy || !s.enabled || s.trusted === false} onClick={() => void write(() => window.cogent.engineRequest('mcp.reconnect', { ...rpcScope, name: s.name }))} aria-label={`重连 ${s.name}`}><IconRefresh className="size-4" /></Button>
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
                <Button variant="ghost" size="xs" aria-expanded={expanded.has(s.name)} aria-label={`详情 ${s.name}`} onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(s.name)) next.delete(s.name); else next.add(s.name); return next })}>{expanded.has(s.name) ? <IconChevronDown className="size-4" /> : <IconChevronRight className="size-4" />}</Button>
              </div>
            </div>{expanded.has(s.name) && <McpServerDetails server={s} scope={rpcScope} busy={busy} onExposure={(tool, exposure) => changeExposure(s, tool, exposure)} />}</div>
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
        <div role="alert" className="mt-4 rounded-lg border border-destructive/30 px-4 py-3 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <McpServerDialog open={dialogOpen} initial={editing} scope={rpcScope} onClose={() => setDialogOpen(false)} onSave={saveFromDialog} />
      <McpImportDialog open={importOpen} onClose={() => setImportOpen(false)} onImport={importFromDialog} />
      <McpOAuthDialog server={loginServer} scope={rpcScope} onClose={() => setLoginServer(null)} onComplete={() => void refresh()} />
    </SettingsPage>
  )
}
