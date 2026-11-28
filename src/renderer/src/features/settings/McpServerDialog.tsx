/**
 * MCP 服务器新增/编辑弹窗（自 McpSection 拆出，2026-11-17 会话状态重构 P6）。
 * 编辑态锁 name 与 type（改类型 = 换一个 server，走删除+新增更诚实；JSON 模式
 * 的名字 = JSON 键，改名同样拒绝）；保存时由父组件整表 mcp.sync。
 * 表单 / JSON 双模式：JSON 直编生态形状，可改表单未暴露的字段（timeout 等）；
 * 模式互切带双向换算，坏 JSON 不放行切换。序列化/解析在 mcp-import.ts。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { unwrapIpcError } from '@/lib/ipc'
import { FIELD_GAP, FIELD_LABEL } from './models-recipes'
import { defToJsonText, entriesOf, JSON_TEMPLATE, linesOf, parseEntries, parseImport, parseLines } from './mcp-import'
import type { McpExposure, McpServerDef, McpScope } from '@shared/mcp'

/** 原 codemode 配置保留于 JSON；表单按当前可用的延迟暴露显示。 */
const EXPOSURES = [
  { value: 'deferred', label: 'deferred · 按需搜索工具' },
  { value: 'direct', label: 'direct · 工具直接给模型' },
  { value: 'hidden', label: 'hidden · 隐藏工具' }
] as const

const TYPES = [
  { value: 'stdio', label: 'stdio · 本地命令' },
  { value: 'http', label: 'http · Streamable HTTP' },
  { value: 'sse', label: 'sse · Legacy SSE' }
] as const

export function McpServerDialog({
  open,
  initial,
  onClose,
  onSave,
  scope = {}
}: {
  open: boolean
  /** 编辑态传既有定义；新增传 null */
  initial: McpServerDef | null
  onClose: () => void
  onSave: (def: McpServerDef, originalName: string | null) => void | boolean | Promise<void | boolean>
  scope?: McpScope
}) {
  const [name, setName] = useState('')
  const [type, setType] = useState<'stdio' | 'http' | 'sse'>('stdio')
  const [draft, setDraft] = useState<McpServerDef | null>(null)
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [env, setEnv] = useState('')
  const [url, setUrl] = useState('')
  const [headers, setHeaders] = useState('')
  const [description, setDescription] = useState('')
  const [exposure, setExposure] = useState<McpExposure>('deferred')
  const [cwd, setCwd] = useState('')
  const [timeout, setTimeoutValue] = useState('')
  const [sanitizeHostEnv, setSanitizeHostEnv] = useState(true)
  const [oauth, setOauth] = useState('')
  const [pending, setPending] = useState(false)
  const [probeResult, setProbeResult] = useState<string | null>(null)
  const generation = useRef(0)
  const [mode, setMode] = useState<'form' | 'json'>('form')
  const [jsonText, setJsonText] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  /** def → 表单态（打开重置与 JSON→表单切换共用；useCallback 稳定引用供 effect 依赖） */
  const applyDef = useCallback((d: McpServerDef | null): void => {
    setDraft(d)
    setName(d?.name ?? '')
    setType(d?.type ?? 'stdio')
    setCommand(d?.type === 'stdio' ? d.command : '')
    setArgs(linesOf(d?.type === 'stdio' ? d.args : undefined))
    setEnv(entriesOf(d?.type === 'stdio' ? d.env : undefined, '='))
    setUrl(d !== null && d.type !== 'stdio' ? d.url : '')
    setHeaders(entriesOf(d !== null && d.type !== 'stdio' ? d.headers : undefined, ':'))
    setDescription(d?.description ?? '')
    setExposure(d?.exposure === 'codemode' ? 'deferred' : d?.exposure ?? 'deferred')
    setCwd(d?.type === 'stdio' ? d.cwd ?? '' : '')
    setSanitizeHostEnv(d?.type === 'stdio' ? d.sanitizeHostEnv !== false : true)
    setTimeoutValue(d?.timeout === undefined ? '' : String(d.timeout))
    setOauth(d !== null && d.type !== 'stdio' && d.oauth !== undefined ? JSON.stringify(d.oauth, null, 2) : '')
  }, [])

  // 每次打开重置（initial 区分新增/编辑），恒回表单模式
  useEffect(() => {
    generation.current++
    if (!open) return
    applyDef(initial)
    setMode('form')
    setJsonText('')
    setFormError(null)
    setProbeResult(null)
    setPending(false)
  }, [open, initial, applyDef])

  /** 表单态 → def（空可选字段省略；不做校验 —— JSON 序列化半成品也要能出，校验在保存） */
  const buildDef = (): McpServerDef => {
    const parsedArgs = parseLines(args)
    const parsedEnv = type === 'stdio' ? parseEntries(env, '=') : {}
    const parsedHeaders = type === 'stdio' ? {} : parseEntries(headers, ':')
    const seconds = timeout.trim() === '' ? undefined : Number(timeout)
    if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0)) throw new Error('超时需要大于 0 的秒数')
    const parsedOauth: unknown = type === 'stdio' || oauth.trim() === '' ? undefined : JSON.parse(oauth)
    if (parsedOauth !== undefined && (typeof parsedOauth !== 'object' || parsedOauth === null || Array.isArray(parsedOauth))) throw new Error('OAuth 配置需要 JSON 对象')
    const shared = {
      ...(description.trim().length > 0 && { description: description.trim() }),
      // enabled 编辑时保留原值（表单不管启停 —— 列表行开关管；JSON 模式写入的
      // 显式值会经 parseImport 原样带回 —— 直编即用户意图）
      ...(draft?.enabled !== undefined && { enabled: draft.enabled }),
      ...(draft?.toolExposure !== undefined && { toolExposure: draft.toolExposure }),
      ...(draft?.extraFields !== undefined && { extraFields: draft.extraFields }),
      ...(seconds !== undefined && { timeout: seconds }),
      exposure
    }
    return type === 'stdio'
      ? {
          name: name.trim(),
          type,
          command: command.trim(),
          ...(parsedArgs.length > 0 && { args: parsedArgs }),
          ...(Object.keys(parsedEnv).length > 0 && { env: parsedEnv }),
          ...(cwd.trim() !== '' && { cwd: cwd.trim() }),
          sanitizeHostEnv,
          ...shared
        }
      : {
          name: name.trim(),
          type,
          url: url.trim(),
          ...(Object.keys(parsedHeaders).length > 0 && { headers: parsedHeaders }),
          ...(parsedOauth !== undefined && { oauth: parsedOauth }),
          ...shared
        }
  }

  /** JSON 文本 → 单条 def；非法 / 条目数≠1 / 编辑态改名 → 带文案的 null（模式切换与保存共用） */
  const parseJsonDef = (): { def: McpServerDef | null; error: string | null } => {
    try {
      const { defs, errors } = parseImport(jsonText)
      if (defs.length !== 1 || errors.length > 0) {
        return {
          def: null,
          error: errors.length > 0 ? errors.join('；') : `JSON 需要恰好一个服务器条目（当前 ${defs.length} 个，多个走「导入」）`
        }
      }
      if (initial !== null && defs[0].name !== initial.name) {
        return { def: null, error: '编辑时名称不可改（表单模式中已锁定）' }
      }
      if (initial !== null && defs[0].type !== initial.type) return { def: null, error: '编辑时传输类型不可改' }
      return { def: defs[0], error: null }
    } catch (error) {
      return { def: null, error: unwrapIpcError(error) }
    }
  }

  const switchMode = (next: 'form' | 'json'): void => {
    if (next === mode) return
    if (next === 'json') {
      // 表单 → JSON：全新空表单给起手模板（直接改 / 粘贴覆盖）；
      // 半填表单原样序列化（空名键留在 JSON 里改）
      let d: McpServerDef
      try { d = buildDef() } catch (error) { setFormError(unwrapIpcError(error)); return }
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

  const save = async (): Promise<void> => {
    const operation = generation.current
    setPending(true)
    try {
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
      await onSave(def, initial?.name ?? null)
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
    if (type !== 'stdio' && url.trim().length === 0) {
      setFormError('远程服务器需要 URL')
      return
    }
    await onSave(buildDef(), initial?.name ?? null)
    } catch (error) { if (generation.current === operation) setFormError(unwrapIpcError(error)) }
    finally { if (generation.current === operation) setPending(false) }
  }

  const probe = async (): Promise<void> => {
    const operation = generation.current
    setPending(true); setFormError(null); setProbeResult(null)
    try {
      const parsed = mode === 'json' ? parseJsonDef() : { def: buildDef(), error: null }
      if (parsed.def === null) throw new Error(parsed.error ?? '配置无效')
      const result = await window.cogent.engineRequest('mcp.probe', { ...scope, def: parsed.def })
      if (generation.current !== operation) return
      setProbeResult(result.state === 'connected' ? `连接成功 · ${result.tools.length} 个工具${result.latencyMs === undefined ? '' : ` · ${result.latencyMs} ms`}` : result.error ?? (result.state === 'needs-auth' ? '服务器需要 OAuth 登录，保存后可登录' : '连接未就绪'))
    } catch (error) { if (generation.current === operation) setFormError(unwrapIpcError(error)) }
    finally { if (generation.current === operation) setPending(false) }
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
              <Collapsible>
                <CollapsibleTrigger render={<Button variant="disclosure" size="xs" />}>高级选项</CollapsibleTrigger>
                <CollapsibleContent className="flex flex-col gap-4 pt-4">
                  <label className="flex flex-col gap-1.5">请求超时（秒）<Input aria-label="请求超时（秒）" inputMode="decimal" value={timeout} onChange={(event) => setTimeoutValue(event.target.value)} placeholder="60" /></label>
                  {type === 'stdio' ? <>
                    <label className="flex flex-col gap-1.5">工作目录<Input aria-label="工作目录" value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="${workspaceFolder}" /></label>
                    <label className="flex items-center justify-between gap-3">隔离宿主敏感环境变量<Switch aria-label="隔离宿主敏感环境变量" checked={sanitizeHostEnv} onCheckedChange={setSanitizeHostEnv} /></label>
                  </> : <label className="flex flex-col gap-1.5">OAuth 配置（JSON，可选）<Textarea aria-label="OAuth 配置" value={oauth} onChange={(event) => setOauth(event.target.value)} rows={5} className="font-mono text-xs" placeholder={'{ "clientId": "...", "clientSecret": "${env:MCP_CLIENT_SECRET}" }'} /></label>}
                </CollapsibleContent>
              </Collapsible>
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
                  className="mt-1.5 font-mono text-xs"
                />
              </div>
            </TabsContent>
          </div>
        </Tabs>

        {formError !== null && <div className="mt-3 text-sm text-destructive">{formError}</div>}
        {probeResult !== null && <p role="status" className="text-sm text-muted-foreground">{probeResult}</p>}

        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => void probe()}>测试连接</Button>
          <Button variant="ghost" size="default" disabled={pending} onClick={onClose}>
            取消
          </Button>
          <Button size="default" disabled={pending} onClick={() => void save()}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
