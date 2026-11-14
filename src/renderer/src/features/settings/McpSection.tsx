/**
 * 设置 · 连接分区（MCP 服务器管理，阶段 4a-2）：数据真源 = 引擎的
 * ~/.cogent/mcp.json（mcp.list / mcp.sync 经 engine:request 通用代理 ——
 * 引擎独占写者，无壳侧双写）。全量替换语义：每次改动整表 mcp.sync；
 * 页面明示「变更新会话生效」（会话装配时快照定格，进行中会话不受影响）。
 * 工具进循环后仍走审批链（exec 档默认询问），此处只管配置。
 */
import { useCallback, useEffect, useState } from 'react'
import { IconPencil, IconPlus, IconTrash } from '@tabler/icons-react'
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SettingsGroup, SettingsRow } from './SettingsParts'
import { BADGE, FIELD_GAP, FIELD_LABEL } from './models-recipes'
import type { McpExposure, McpServerDef, McpServerSummary } from '@/env.d'

/** 暴露档下拉（Cogent 只用 direct，其余档供手改配置的忠实回显） */
const EXPOSURES = [
  { value: 'direct', label: 'direct · 工具直接给模型' },
  { value: 'codemode', label: 'codemode · 仅脚本可调（Cogent 未装载）' },
  { value: 'deferred', label: 'deferred · 经 tool_search（Cogent 未装载）' },
  { value: 'hidden', label: 'hidden · 注册但不可达' }
] as const

const TYPES = [
  { value: 'stdio', label: 'stdio · 本地命令' },
  { value: 'http', label: 'http · Streamable HTTP' }
] as const

// ———— 表单文本态的序列化（数组/记录 ↔ 多行文本，带空格参数无需引号转义） ——

const linesOf = (arr: string[] | undefined): string => (arr ?? []).join('\n')

const parseLines = (text: string): string[] =>
  text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)

const entriesOf = (record: Record<string, string> | undefined, sep: string): string =>
  Object.entries(record ?? {}).map(([k, v]) => `${k}${sep}${v}`).join('\n')

const parseEntries = (text: string, sep: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const line of parseLines(text)) {
    const at = line.indexOf(sep)
    if (at <= 0) continue // 无分隔符的行静默丢弃（表单占位文案已给格式样例）
    out[line.slice(0, at).trim()] = line.slice(at + sep.length).trim()
  }
  return out
}

/** IPC 错误 → 文案（engine:request 直抛 Error，同步失败原样呈现给用户） */
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * 新增/编辑表单弹窗。编辑态锁 name 与 type（改类型 = 换一个 server，
 * 走删除+新增更诚实）；保存时由父组件整表 mcp.sync。
 */
function ServerDialog({
  open,
  initial,
  onClose,
  onSave
}: {
  open: boolean
  /** 编辑态传既有定义；新增传 null */
  initial: McpServerDef | null
  onClose: () => void
  onSave: (def: McpServerDef, originalName: string | null) => void
}) {
  const [name, setName] = useState('')
  const [type, setType] = useState<'stdio' | 'http'>('stdio')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [env, setEnv] = useState('')
  const [url, setUrl] = useState('')
  const [headers, setHeaders] = useState('')
  const [description, setDescription] = useState('')
  const [exposure, setExposure] = useState<McpExposure>('direct')
  const [formError, setFormError] = useState<string | null>(null)

  // 每次打开重置（initial 区分新增/编辑）
  useEffect(() => {
    if (!open) return
    setName(initial?.name ?? '')
    setType(initial?.type ?? 'stdio')
    setCommand(initial?.type === 'stdio' ? initial.command : '')
    setArgs(linesOf(initial?.type === 'stdio' ? initial.args : undefined))
    setEnv(entriesOf(initial?.type === 'stdio' ? initial.env : undefined, '='))
    setUrl(initial?.type === 'http' ? initial.url : '')
    setHeaders(entriesOf(initial?.type === 'http' ? initial.headers : undefined, ':'))
    setDescription(initial?.description ?? '')
    setExposure(initial?.exposure ?? 'direct')
    setFormError(null)
  }, [open, initial])

  const save = (): void => {
    const trimmed = name.trim()
    if (trimmed.length === 0) {
      setFormError('名称必填（字母 / 数字 / _ / -）')
      return
    }
    if (type === 'stdio' && command.trim().length === 0) {
      setFormError('stdio 服务器需要启动命令')
      return
    }
    if (type === 'http' && url.trim().length === 0) {
      setFormError('http 服务器需要 URL')
      return
    }
    const parsedArgs = parseLines(args)
    const parsedEnv = parseEntries(env, '=')
    const parsedHeaders = parseEntries(headers, ':')
    const shared = {
      ...(description.trim().length > 0 && { description: description.trim() }),
      // enabled 编辑时保留原值（表单不管启停 —— 列表行开关管）
      ...(initial?.enabled !== undefined && { enabled: initial.enabled }),
      exposure
    }
    onSave(
      type === 'stdio'
        ? {
            name: trimmed,
            type,
            command: command.trim(),
            ...(parsedArgs.length > 0 && { args: parsedArgs }),
            ...(Object.keys(parsedEnv).length > 0 && { env: parsedEnv }),
            ...shared
          }
        : {
            name: trimmed,
            type,
            url: url.trim(),
            ...(Object.keys(parsedHeaders).length > 0 && { headers: parsedHeaders }),
            ...shared
          },
      initial?.name ?? null
    )
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{initial !== null ? '编辑 MCP 服务器' : '添加 MCP 服务器'}</DialogTitle>
        </DialogHeader>

        <div>
          <div className={FIELD_LABEL}>名称</div>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如 filesystem"
            disabled={initial !== null}
            className="mt-1.5"
          />
        </div>

        <div className={FIELD_GAP}>
          <div className={FIELD_LABEL}>类型</div>
          <Select
            value={type}
            items={TYPES}
            onValueChange={(next) => {
              if (next !== null) setType(next)
            }}
          >
            <SelectTrigger aria-label="类型" disabled={initial !== null} className="mt-1.5 h-9 w-full rounded-lg">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {type === 'stdio' ? (
          <>
            <div className={FIELD_GAP}>
              <div className={FIELD_LABEL}>启动命令</div>
              <Input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="如 npx"
                className="mt-1.5"
              />
            </div>
            <div className={FIELD_GAP}>
              <div className={FIELD_LABEL}>参数（一行一个）</div>
              <Textarea
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder={'-y\n@modelcontextprotocol/server-filesystem\n.'}
                rows={3}
                className="mt-1.5"
              />
            </div>
            <div className={FIELD_GAP}>
              <div className={FIELD_LABEL}>环境变量（一行一条 KEY=VALUE）</div>
              <Textarea
                value={env}
                onChange={(e) => setEnv(e.target.value)}
                placeholder="API_BASE=https://example.com"
                rows={2}
                className="mt-1.5"
              />
            </div>
          </>
        ) : (
          <>
            <div className={FIELD_GAP}>
              <div className={FIELD_LABEL}>URL</div>
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/mcp"
                className="mt-1.5"
              />
            </div>
            <div className={FIELD_GAP}>
              <div className={FIELD_LABEL}>请求头（一行一条 名称: 值）</div>
              <Textarea
                value={headers}
                onChange={(e) => setHeaders(e.target.value)}
                placeholder="Authorization: Bearer ..."
                rows={2}
                className="mt-1.5"
              />
            </div>
          </>
        )}

        <div className={FIELD_GAP}>
          <div className={FIELD_LABEL}>描述（可选，一句话说明它提供什么）</div>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} className="mt-1.5" />
        </div>

        <div className={FIELD_GAP}>
          <div className={FIELD_LABEL}>暴露档</div>
          <Select
            value={exposure}
            items={EXPOSURES}
            onValueChange={(next) => {
              if (next !== null) setExposure(next)
            }}
          >
            <SelectTrigger aria-label="暴露档" className="mt-1.5 h-9 w-full rounded-lg">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EXPOSURES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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

export function McpSection() {
  /** null = 加载中（首拉未返回） */
  const [servers, setServers] = useState<McpServerSummary[] | null>(null)
  const [fileErrors, setFileErrors] = useState<string[]>([])
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<McpServerDef | null>(null)

  const refresh = useCallback(async () => {
    try {
      const r = await window.cogent.engineRequest('mcp.list', {})
      setServers(r.servers)
      setFileErrors(r.errors)
    } catch (error) {
      setActionError(messageOf(error))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** 全量同步（替换语义）：成功后重拉；引擎校验失败原样呈现（如非法名字） */
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

  const toggle = (summary: McpServerSummary, enabled: boolean): void => {
    const next = (servers ?? []).map((s) =>
      s.name === summary.name ? { ...s.def, enabled } : s.def
    )
    void sync(next)
  }

  const remove = (summary: McpServerSummary): void => {
    const next = (servers ?? []).filter((s) => s.name !== summary.name).map((s) => s.def)
    void sync(next)
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-10 py-8">
      <h2 className="text-2xl font-semibold">连接</h2>
      <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
        MCP 服务器：外部工具经 Model Context Protocol 直接进入 Agent 循环（工具调用仍走审批）。
        配置存储于用户级 ~/.cogent/mcp.json，变更<strong>新会话生效</strong>（进行中的会话不受影响）；
        项目可在工作区 .cogent/mcp.json 里按 server 覆盖启停与暴露档。
      </p>

      <SettingsGroup label="MCP 服务器">
        {servers === null ? (
          <div className="px-5 py-4 text-[13px] text-muted-foreground">加载中…</div>
        ) : servers.length === 0 ? (
          <div className="px-5 py-4 text-[13px] text-muted-foreground">
            尚未配置 MCP 服务器 —— 添加一个，让 Agent 用上外部工具。
          </div>
        ) : (
          servers.map((s) => (
            <SettingsRow
              key={s.name}
              title={
                <span className="flex items-center gap-2">
                  {s.name}
                  <span className={BADGE}>{s.type}</span>
                  <span className={BADGE}>{s.exposure}</span>
                </span>
              }
              desc={s.detail + (s.description !== undefined ? ` —— ${s.description}` : '')}
            >
              <div className="flex items-center gap-1">
                <Switch
                  checked={s.enabled}
                  disabled={busy}
                  onCheckedChange={(checked: boolean) => toggle(s, checked)}
                  aria-label={`${s.name} 启用`}
                />
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={busy}
                  onClick={() => {
                    setEditing(s.def)
                    setDialogOpen(true)
                  }}
                  aria-label={`编辑 ${s.name}`}
                >
                  <IconPencil className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={busy}
                  onClick={() => remove(s)}
                  aria-label={`删除 ${s.name}`}
                >
                  <IconTrash className="size-4" />
                </Button>
              </div>
            </SettingsRow>
          ))
        )}
        {/* 添加行：卡片尾部常驻入口（新增态 initial=null） */}
        <div className="flex items-center px-5 py-3">
          <Button
            variant="ghost"
            size="xs"
            disabled={busy}
            onClick={() => {
              setEditing(null)
              setDialogOpen(true)
            }}
          >
            <IconPlus className="size-4" />
            添加服务器
          </Button>
        </div>
      </SettingsGroup>

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

      <ServerDialog
        open={dialogOpen}
        initial={editing}
        onClose={() => setDialogOpen(false)}
        onSave={saveFromDialog}
      />
    </div>
  )
}
