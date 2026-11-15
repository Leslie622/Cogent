/**
 * 设置 · MCP 服务器分区（阶段 4a-2，2026-11-15 按 zcode 参考稿重排 + 作用域）：
 * 数据真源 = 引擎的 ~/.cogent/mcp.json（mcp.list / mcp.sync / mcp.override
 * 经 engine:request 通用代理 —— 引擎独占写者，无壳侧双写）。全量替换语义：
 * 每次改动整表 mcp.sync；页头明示「变更新会话生效」（会话装配时快照定格）。
 * 作用域（zcode 对齐）：本机·用户 = 全局定义面（增删改/导入）；
 * 本项目 = 合并视图 + 项目 override 写入（开关落工作区 .cogent/mcp.json，
 * 只影响该项目；重置 = 清除 override 回落用户级）——项目 cwd 取当前活跃
 * 会话的工作区。搜索 = 本地过滤（名称/命令行·URL/描述）。
 * 连接状态点（zcode 绿/红）无数据面 —— Host 是 headless，连接状态在 pi
 * 会话内部，需协议扩展才能暴露（后续候选，见 模块/MCP座.md 边界）。
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
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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

/** IPC / 解析错误 → 文案（engine:request 直抛 Error，失败原样呈现给用户） */
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const isStringRecord = (value: unknown): value is Record<string, string> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) &&
  Object.values(value).every((v) => typeof v === 'string')

/** 普通对象判定（值未知；server 条目必须是它） */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * 导入载荷 → defs（renderer 侧结构提取；值域校验在引擎 mcp.sync 入口）。
 * 接受两种形状：`{ "mcpServers": { … } }`（生态通用形状，剪贴板互拷）或直接
 * `{ "名字": { command/url… } }` 的 map。缺 command/url 的条目记名报错。
 */
function parseImport(text: string): { defs: McpServerDef[]; errors: string[] } {
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed)) {
    throw new Error('导入内容需要是 JSON 对象（{"mcpServers": { … }}）')
  }
  const map = isRecord(parsed.mcpServers) ? parsed.mcpServers : parsed
  const defs: McpServerDef[] = []
  const errors: string[] = []
  for (const [name, raw] of Object.entries(map)) {
    if (name.trim().length === 0) {
      // 空键直接拒绝：序列化半填表单会出现 ""，落到通用缺字段文案会变成
      // 悬空引号开头的一串（"… 缺少 …"），单独给明确的键名提示
      errors.push('服务器名称不能为空（JSON 键）')
      continue
    }
    if (!isRecord(raw)) {
      errors.push(`"${name}" 不是对象`)
      continue
    }
    const cfg = raw
    const shared = {
      ...(typeof cfg.description === 'string' && { description: cfg.description }),
      ...(cfg.enabled !== undefined && { enabled: cfg.enabled === true }),
      ...(typeof cfg.exposure === 'string' && { exposure: cfg.exposure as McpExposure }),
      ...(typeof cfg.timeout === 'number' && { timeout: cfg.timeout })
    }
    if (typeof cfg.url === 'string' && cfg.url.length > 0) {
      defs.push({ name, type: 'http', url: cfg.url, ...(isStringRecord(cfg.headers) && { headers: cfg.headers }), ...shared })
    } else if (typeof cfg.command === 'string' && cfg.command.length > 0) {
      defs.push({
        name,
        type: 'stdio',
        command: cfg.command,
        ...(Array.isArray(cfg.args) && { args: cfg.args as string[] }),
        ...(isStringRecord(cfg.env) && { env: cfg.env }),
        ...shared
      })
    } else {
      errors.push(`"${name}" 缺少 command 或 url`)
    }
  }
  return { defs, errors }
}

/**
 * def → JSON 模式文本（zcode 表单/JSON 双模式对齐）：单条生态互拷形状
 * `{ "名字": { …条目… } }`；type 由 command/url 推断（parseImport 同款），
 * 不写入 —— 与 pi / Claude Desktop 等的 mcpServers 形状一致。
 */
const defToJsonText = (def: McpServerDef): string => {
  const { name, type: _type, ...entry } = def
  return JSON.stringify({ [name]: entry }, null, 2)
}

/** JSON 模式起手模板（空表单切入时给样例，直接改 / 粘贴覆盖） */
const JSON_TEMPLATE =
  '{\n  "filesystem": {\n    "command": "npx",\n    "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]\n  }\n}'

/**
 * 新增/编辑表单弹窗。编辑态锁 name 与 type（改类型 = 换一个 server，
 * 走删除+新增更诚实；JSON 模式的名字 = JSON 键，改名同样拒绝）；保存时由
 * 父组件整表 mcp.sync。表单 / JSON 双模式：JSON 直编生态形状，可改表单
 * 未暴露的字段（timeout 等）；模式互切带双向换算，坏 JSON 不放行切换。
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
  const [mode, setMode] = useState<'form' | 'json'>('form')
  const [jsonText, setJsonText] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  /** def → 表单态（打开重置与 JSON→表单切换共用；useCallback 稳定引用供 effect 依赖） */
  const applyDef = useCallback((d: McpServerDef | null): void => {
    setName(d?.name ?? '')
    setType(d?.type ?? 'stdio')
    setCommand(d?.type === 'stdio' ? d.command : '')
    setArgs(linesOf(d?.type === 'stdio' ? d.args : undefined))
    setEnv(entriesOf(d?.type === 'stdio' ? d.env : undefined, '='))
    setUrl(d?.type === 'http' ? d.url : '')
    setHeaders(entriesOf(d?.type === 'http' ? d.headers : undefined, ':'))
    setDescription(d?.description ?? '')
    setExposure(d?.exposure ?? 'direct')
  }, [])

  // 每次打开重置（initial 区分新增/编辑），恒回表单模式
  useEffect(() => {
    if (!open) return
    applyDef(initial)
    setMode('form')
    setJsonText('')
    setFormError(null)
  }, [open, initial, applyDef])

  /** 表单态 → def（空可选字段省略；不做校验 —— JSON 序列化半成品也要能出，校验在保存） */
  const buildDef = (): McpServerDef => {
    const parsedArgs = parseLines(args)
    const parsedEnv = parseEntries(env, '=')
    const parsedHeaders = parseEntries(headers, ':')
    const shared = {
      ...(description.trim().length > 0 && { description: description.trim() }),
      // enabled 编辑时保留原值（表单不管启停 —— 列表行开关管；JSON 模式写入的
      // 显式值会经 parseImport 原样带回 —— 直编即用户意图）
      ...(initial?.enabled !== undefined && { enabled: initial.enabled }),
      exposure
    }
    return type === 'stdio'
      ? {
          name: name.trim(),
          type,
          command: command.trim(),
          ...(parsedArgs.length > 0 && { args: parsedArgs }),
          ...(Object.keys(parsedEnv).length > 0 && { env: parsedEnv }),
          ...shared
        }
      : {
          name: name.trim(),
          type,
          url: url.trim(),
          ...(Object.keys(parsedHeaders).length > 0 && { headers: parsedHeaders }),
          ...shared
        }
  }

  /** JSON 文本 → 单条 def；非法 / 条目数≠1 / 编辑态改名 → 带文案的 null（模式切换与保存共用） */
  const parseJsonDef = (): { def: McpServerDef | null; error: string | null } => {
    try {
      const { defs, errors } = parseImport(jsonText)
      if (defs.length !== 1) {
        return {
          def: null,
          error: errors.length > 0 ? errors.join('；') : `JSON 需要恰好一个服务器条目（当前 ${defs.length} 个，多个走「导入」）`
        }
      }
      if (initial !== null && defs[0].name !== initial.name) {
        return { def: null, error: '编辑时名称不可改（表单模式中已锁定）' }
      }
      return { def: defs[0], error: null }
    } catch (error) {
      return { def: null, error: messageOf(error) }
    }
  }

  const switchMode = (next: 'form' | 'json'): void => {
    if (next === mode) return
    if (next === 'json') {
      // 表单 → JSON：全新空表单给起手模板（直接改 / 粘贴覆盖）；
      // 半填表单原样序列化（空名键留在 JSON 里改）
      const d = buildDef()
      const blank = d.name === '' && (d.type === 'stdio' ? d.command : d.url).trim() === ''
      setJsonText(blank ? JSON_TEMPLATE : defToJsonText(d))
      setMode('json')
      setFormError(null)
      return
    }
    // JSON → 表单：换算失败留在 JSON 态报错（坏 JSON 不进表单）
    const { def, error } = parseJsonDef()
    if (def === null) {
      setFormError(error)
      return
    }
    applyDef(def)
    setMode('form')
    setFormError(null)
  }

  const save = (): void => {
    if (mode === 'json') {
      if (jsonText.trim().length === 0) {
        setFormError('粘贴或编辑服务器 JSON')
        return
      }
      const { def, error } = parseJsonDef()
      if (def === null) {
        setFormError(error)
        return
      }
      onSave(def, initial?.name ?? null)
      return
    }
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
    onSave(buildDef(), initial?.name ?? null)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{initial !== null ? '编辑 MCP 服务器' : '添加 MCP 服务器'}</DialogTitle>
        </DialogHeader>

        {/* 表单/JSON 双模式（zcode 同款）：Tabs 胶囊分段；坏 JSON 不放行切回表单 */}
        <Tabs
          value={mode}
          onValueChange={(v: string) => { if (v === 'form' || v === 'json') switchMode(v) }}
          className="min-h-0 flex-1 gap-4"
        >
          <TabsList>
            <TabsTrigger value="form">表单</TabsTrigger>
            <TabsTrigger value="json">JSON</TabsTrigger>
          </TabsList>
          {/* 中段滚动区（ui/dialog DialogContent 注释的长内容弹窗形态）：头/尾
              钉住；-mx-4 px-4 全出血 → 滚动条贴右缘（头尾在外，轨道不穿圆角） */}
          <div className="-mx-4 flex min-h-0 flex-1 flex-col overflow-y-auto px-4">
            <TabsContent value="form" className="flex flex-col gap-4">
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
                <Select value={type} items={TYPES} onValueChange={(next) => next !== null && setType(next)}>
                  <SelectTrigger aria-label="类型" disabled={initial !== null} className="mt-1.5 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="start" className="min-w-56">
                    <SelectGroup>
                      {TYPES.map((t) => (
                        <SelectItem key={t.value} value={t.value}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>

              {type === 'stdio' ? (
                <>
                  <div className={FIELD_GAP}>
                    <div className={FIELD_LABEL}>启动命令</div>
                    <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="如 npx" className="mt-1.5" />
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
                    <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" className="mt-1.5" />
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
                <Select value={exposure} items={EXPOSURES} onValueChange={(next) => next !== null && setExposure(next)}>
                  <SelectTrigger aria-label="暴露档" className="mt-1.5 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="start" className="min-w-64">
                    <SelectGroup>
                      {EXPOSURES.map((t) => (
                        <SelectItem key={t.value} value={t.value}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            </TabsContent>

            <TabsContent value="json">
              <div>
                <div className={FIELD_LABEL}>服务器 JSON（生态互拷形状，单个条目；可编辑表单未暴露的字段）</div>
                <Textarea
                  value={jsonText}
                  onChange={(e) => {
                    setJsonText(e.target.value)
                    setFormError(null) // 输入即清错，红字不跨编辑残留
                  }}
                  placeholder={'{\n  "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }\n}'}
                  rows={12}
                  className="mt-1.5 font-mono text-[12px]"
                />
              </div>
            </TabsContent>
          </div>
        </Tabs>

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
            className="mt-1.5 font-mono text-[12px]"
          />
        </div>
        {formError !== null && <div className="mt-3 text-[13px] leading-relaxed text-destructive">{formError}</div>}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button size="sm" onClick={run}>
            导入
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 作用域两档（zcode「本机 · 用户」下拉同位） */
const SCOPES = [
  { value: 'user', label: '本机 · 用户' },
  { value: 'project', label: '本项目' }
] as const

type McpScope = (typeof SCOPES)[number]['value']

export function McpSection() {
  /** null = 加载中（首拉未返回） */
  const [servers, setServers] = useState<McpServerSummary[] | null>(null)
  const [fileErrors, setFileErrors] = useState<string[]>([])
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [editing, setEditing] = useState<McpServerDef | null>(null)
  const [scope, setScope] = useState<McpScope>('user')
  const [query, setQuery] = useState('')

  /** 项目作用域的 cwd：当前活跃会话的工作区（无绑定会话 = 项目档不可用） */
  const projectCwd = useChatStore((s) => s.sessions.find((x) => x.id === s.activeSessionId)?.cwd)

  const refresh = useCallback(async () => {
    if (scope === 'project' && projectCwd === undefined) {
      setServers([])
      return
    }
    try {
      const r = await window.cogent.engineRequest('mcp.list', scope === 'project' ? { cwd: projectCwd } : {})
      setServers(r.servers)
      setFileErrors(r.errors)
    } catch (error) {
      setActionError(messageOf(error))
    }
  }, [scope, projectCwd])

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
      desc={
        userScope ? (
          <>
            外部工具经 Model Context Protocol 直接进入 Agent 循环（工具调用仍走审批）。
            配置存储于用户级 ~/.cogent/mcp.json，变更<strong>新会话生效</strong>（进行中的会话不受影响）；
            项目可在「本项目」作用域按 server 覆盖启停与暴露档。
          </>
        ) : (
          <>
            项目作用域 = 工作区 <span className="font-mono">{projectCwd ?? '—'}</span> 下的 .cogent/mcp.json：
            开关只影响本项目的会话（覆盖用户级），「重置」清除覆盖回落用户级；
            server 的定义与增删改在「本机 · 用户」作用域操作。
          </>
        )
      }
      toolbar={
        <>
          <Select value={scope} items={SCOPES} onValueChange={(next) => next !== null && setScope(next)}>
            <SelectTrigger aria-label="作用域">
              <SelectValue />
            </SelectTrigger>
            {/* 左对齐即可：弹层宽度约束在 ui/select 本体（min-w=锚宽，见其
                注释），调用处不再打宽度补丁（组件原生形态方针）。
                items 必须包 SelectGroup：Group 自带 p-1 内衬，是官方形态的
                一部分（官方全部示例皆如此包裹）；裸塞 items 会让内容贴边、
                高亮条顶到弹层边框（2026-11-15 MCP 页"弹层不对"的根因） */}
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
          {/* 搜索框：与侧栏同款裸 input 手搭（黑 5% 软叠胶囊底） */}
          <div className="ml-auto flex h-8 w-56 items-center gap-2 rounded-full bg-accent-foreground/5 px-3">
            <IconSearch className="size-4 shrink-0 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索 MCP 服务器"
              className="h-full w-full min-w-0 bg-transparent text-[13px] text-foreground outline-none placeholder:text-placeholder"
            />
          </div>
          <Button variant="outline" size="icon-sm" disabled={busy} onClick={() => void refresh()} aria-label="刷新">
            <IconRefresh className="size-4" />
          </Button>
          <Button
            size="sm"
            disabled={busy || !userScope}
            onClick={() => {
              setEditing(null)
              setDialogOpen(true)
            }}
          >
            <IconPlus className="size-4" />
            新建
          </Button>
        </>
      }
    >
      {servers === null ? (
        <div className="mt-3 rounded-xl border border-border px-5 py-4 text-[13px] text-muted-foreground">加载中…</div>
      ) : !userScope && projectCwd === undefined ? (
        /* 项目档但无工作区：指引切会话 */
        <div className="mt-3 rounded-xl border border-dashed border-border px-6 py-10 text-center text-[13px] text-muted-foreground">
          当前没有绑定工作区的活跃会话 —— 在聊天里选中一个项目会话后，这里显示该项目的覆盖设置。
        </div>
      ) : count === 0 ? (
        userScope ? (
          /* 空态（zcode 形态）：虚线卡 + 主副文案 + 新建/导入双入口 */
          <div className="mt-3 flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-12 text-center">
            <div className="text-sm font-medium">尚未安装 MCP 服务器</div>
            <div className="text-[13px] text-muted-foreground">手动新建服务器，或导入已有配置。</div>
            <div className="mt-2 flex items-center gap-2">
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  setEditing(null)
                  setDialogOpen(true)
                }}
              >
                <IconPlus className="size-4" />
                新建 MCP 服务器
              </Button>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => setImportOpen(true)}>
                <IconDownload className="size-4" />
                导入
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-3 rounded-xl border border-dashed border-border px-6 py-10 text-center text-[13px] text-muted-foreground">
            没有可覆盖的服务器 —— 先在「本机 · 用户」作用域添加 MCP 服务器。
          </div>
        )
      ) : visible.length === 0 ? (
        <div className="mt-3 rounded-xl border border-border px-5 py-4 text-[13px] text-muted-foreground">
          没有匹配「{query.trim()}」的服务器
        </div>
      ) : (
        <SettingsGroup label="">
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
                <div className="mt-0.5 truncate text-[13px] text-muted-foreground">
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
                    <Button variant="ghost" size="icon-xs" disabled={busy} onClick={() => remove(s)} aria-label={`删除 ${s.name}`}>
                      <IconTrash className="size-4" />
                    </Button>
                  </>
                ) : (
                  s.overrideApplied === true && (
                    /* 项目档专属：清除覆盖（空 patch = 回落用户级） */
                    <Button
                      variant="ghost"
                      size="icon-xs"
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

      <ServerDialog open={dialogOpen} initial={editing} onClose={() => setDialogOpen(false)} onSave={saveFromDialog} />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} onImport={importFromDialog} />
    </SettingsPage>
  )
}
