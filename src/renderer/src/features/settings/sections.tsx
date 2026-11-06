/**
 * 设置页内容区：id → 分区组件。
 * 「常规」按图2 卡片行样式演示（Card + Select/Switch/Input）；
 * 「模型设置」接真数据（provider key 配置）；其余分区统一占位，随各设置项落地逐个替换。
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { SettingRow } from '@/components/SettingRow'
import { useEngineStore } from '@/stores/engine'

export type SettingsSectionId =
  | 'general'
  | 'appearance'
  | 'models'
  | 'shortcuts'
  | 'persona'
  | 'memory'
  | 'subagents'
  | 'plugins'
  | 'mcp'
  | 'skills'
  | 'hooks'
  | 'usage'
  | 'projects'
  | 'sessions'
  | 'automation'
  | 'browser'
  | 'boxes'

/** 「常规」分区：演示卡片行，设置项均为展示占位（持久化等 storage/凭据落地） */
function GeneralSection() {
  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold">常规</h1>
      <Card>
        <CardContent className="divide-y px-4">
          <SettingRow title="界面语言" desc="选择应用 UI 的显示语言。">
            <Select defaultValue="system">
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="system">系统默认</SelectItem>
                <SelectItem value="zh-CN">简体中文</SelectItem>
                <SelectItem value="en">English</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingRow title="界面模式" desc="简洁模式只看摘要与结果；详细模式显示命令、输出和代码变更详情。">
            <Select defaultValue="detail">
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="simple">简洁模式</SelectItem>
                <SelectItem value="detail">详细模式</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingRow title="主动任务推荐" desc="仅在简洁模式下支持。">
            <Switch />
          </SettingRow>
          <SettingRow title="终端字体" desc="留空时自动探测系统终端配置。">
            <div className="flex items-center gap-2">
              <Input placeholder="留空自动继承" className="w-56" />
              <Button variant="secondary" size="sm">
                保存
              </Button>
            </div>
          </SettingRow>
        </CardContent>
      </Card>
    </>
  )
}

/**
 * 模型设置分区：内置 provider 的 key/baseUrl 配置 + 自定义 provider 管理。
 * 内置只铺常用几家（目录 41 家全铺没法用）；自定义 provider（中转站/网关/Ollama）
 * 走 custom-providers 全量保存（落盘 + 推引擎 sync）。
 */
/** 设置页展示的内置 provider 白名单（其余目录 provider 有 key 也会在下拉生效，只是不铺 UI） */
const FEATURED_PROVIDERS = ['anthropic', 'openai', 'google', 'deepseek', 'openrouter', 'zai'] as const

function ModelsSection() {
  const keyConfigured = useEngineStore((s) => s.keyConfigured)
  const customProviders = useEngineStore((s) => s.customProviders)
  const overrides = useEngineStore((s) => s.overrides)
  const refreshKeys = useEngineStore((s) => s.refreshKeys)
  const saveProviders = useEngineStore((s) => s.saveProviders)

  const setOverride = (providerId: string, baseUrl: string) => {
    const next = { ...overrides }
    if (baseUrl.trim().length > 0) next[providerId] = baseUrl.trim()
    else delete next[providerId]
    void saveProviders(customProviders, Object.entries(next).map(([providerId, baseUrl]) => ({ providerId, baseUrl })))
  }

  return (
    <>
      <h1 className="mb-2 text-2xl font-semibold">模型设置</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        为模型供应商配置 API key（本机加密存储，不会上传）。聊天页模型下拉只展示已配置 key 的供应商。
      </p>
      <Card>
        <CardContent className="divide-y px-4">
          {FEATURED_PROVIDERS.map((providerId) => (
            <ProviderKeyRow
              key={providerId}
              providerId={providerId}
              configured={keyConfigured[providerId] === true}
              baseUrl={overrides[providerId]}
              onKeySaved={() => void refreshKeys()}
              onBaseUrlChange={(baseUrl) => setOverride(providerId, baseUrl)}
            />
          ))}
        </CardContent>
      </Card>
      <CustomProvidersCard />
    </>
  )
}

/** 单个内置 provider 行：key 输入 + 可选 baseUrl 覆盖（代理/中转） */
function ProviderKeyRow({
  providerId,
  configured,
  baseUrl,
  onKeySaved,
  onBaseUrlChange
}: {
  providerId: string
  configured: boolean
  baseUrl: string | undefined
  onKeySaved: () => void
  onBaseUrlChange: (baseUrl: string) => void
}) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await window.cogent.setApiKey(providerId, key.trim())
      setKey('')
      onKeySaved()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    // 清除 = 写入空串（引擎侧 keyConfigured 判空；文件里保留条目简化实现）
    setBusy(true)
    setError(null)
    try {
      await window.cogent.setApiKey(providerId, '')
      setKey('')
      onKeySaved()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingRow title={providerId} desc={configured ? '已配置 API key' : '未配置'}>
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-2">
          <Badge variant={configured ? 'default' : 'secondary'}>{configured ? '已配置' : '未配置'}</Badge>
          <Input
            type="password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder={configured ? '输入新 key 覆盖' : '粘贴 API key'}
            className="w-56"
            disabled={busy}
          />
          <Button variant="secondary" size="sm" disabled={busy || key.trim().length === 0} onClick={() => void save()}>
            保存
          </Button>
          {configured && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void remove()}>
              清除
            </Button>
          )}
        </div>
        <BaseUrlInput value={baseUrl} onSubmit={onBaseUrlChange} />
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </SettingRow>
  )
}

/** baseUrl 覆盖输入：非受控小输入 + 失焦/回车提交（空值 = 清除覆盖） */
function BaseUrlInput({ value, onSubmit }: { value: string | undefined; onSubmit: (baseUrl: string) => void }) {
  const [draft, setDraft] = useState(value ?? '')
  const current = draft.trim()
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">端点</span>
      <Input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => current !== (value ?? '') && onSubmit(current)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            if (current !== (value ?? '')) onSubmit(current)
          }
        }}
        placeholder="默认官方端点"
        className="h-7 w-56 text-xs"
      />
    </div>
  )
}

/** 自定义 provider 卡片：列表 + 添加表单（名称/baseUrl/key/模型列表） */
function CustomProvidersCard() {
  const keyConfigured = useEngineStore((s) => s.keyConfigured)
  const customProviders = useEngineStore((s) => s.customProviders)
  const refreshKeys = useEngineStore((s) => s.refreshKeys)
  const saveProviders = useEngineStore((s) => s.saveProviders)

  const remove = (id: string) => {
    void saveProviders(customProviders.filter((p) => p.id !== id), [])
  }

  return (
    <div className="mt-6">
      <h2 className="mb-3 text-lg font-medium">自定义 Provider</h2>
      <p className="mb-3 text-sm text-muted-foreground">
        接入 OpenAI-compatible 端点（API 中转站、公司网关、Ollama 等）。每个 provider 可挂多个模型（一行一个模型 ID）。
      </p>
      {customProviders.length > 0 && (
        <Card>
          <CardContent className="divide-y px-4">
            {customProviders.map((p) => (
              <SettingRow key={p.id} title={p.name} desc={`${p.baseUrl} · ${p.models.length} 个模型`}>
                <div className="flex items-center gap-2">
                  <Badge variant={keyConfigured[p.id] === true ? 'default' : 'secondary'}>
                    {keyConfigured[p.id] === true ? '已配置' : '未配 key'}
                  </Badge>
                  <Button variant="ghost" size="sm" onClick={() => remove(p.id)}>
                    删除
                  </Button>
                </div>
              </SettingRow>
            ))}
          </CardContent>
        </Card>
      )}
      <CustomProviderForm existingIds={customProviders.map((p) => p.id)} onSaved={() => void refreshKeys()} />
    </div>
  )
}

/** 名称 → custom/<slug>（id 唯一性：slug 撞车时提示换名） */
function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** 添加表单：一次性填名称/baseUrl/key/模型列表，保存 = 配 key + 全量写定义 */
function CustomProviderForm({ existingIds, onSaved }: { existingIds: string[]; onSaved: () => void }) {
  const customProviders = useEngineStore((s) => s.customProviders)
  const saveProviders = useEngineStore((s) => s.saveProviders)
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [key, setKey] = useState('')
  const [modelsText, setModelsText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const modelIds = modelsText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const slug = slugify(name)
      if (slug.length === 0) throw new Error('名称需要包含字母或数字')
      const id = `custom/${slug}`
      if (existingIds.includes(id)) throw new Error(`已存在同名 provider：${name}`)
      if (!/^https?:\/\//.test(baseUrl.trim())) throw new Error('端点地址需要以 http(s):// 开头')
      if (modelIds.length === 0) throw new Error('至少填一个模型 ID')
      if (key.trim().length === 0) throw new Error('API key 不能为空')
      await window.cogent.setApiKey(id, key.trim())
      await saveProviders([...customProviders, { id, name: name.trim(), baseUrl: baseUrl.trim(), models: modelIds }], [])
      setName('')
      setBaseUrl('')
      setKey('')
      setModelsText('')
      onSaved()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="mt-4">
      <CardContent className="flex flex-col gap-3 px-4 py-4">
        <div className="flex items-center gap-3">
          <span className="w-20 shrink-0 text-sm text-muted-foreground">名称</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 my-relay" className="flex-1" disabled={busy} />
        </div>
        <div className="flex items-center gap-3">
          <span className="w-20 shrink-0 text-sm text-muted-foreground">端点</span>
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://your-relay.example.com/v1"
            className="flex-1"
            disabled={busy}
          />
        </div>
        <div className="flex items-center gap-3">
          <span className="w-20 shrink-0 text-sm text-muted-foreground">API key</span>
          <Input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="粘贴 API key（加密存储）"
            className="flex-1"
            disabled={busy}
          />
        </div>
        <div className="flex items-start gap-3">
          <span className="w-20 shrink-0 pt-2 text-sm text-muted-foreground">模型列表</span>
          <textarea
            value={modelsText}
            onChange={(e) => setModelsText(e.target.value)}
            placeholder={'一行一个模型 ID，如：\ngpt-4o\ngpt-4o-mini'}
            className="h-24 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            disabled={busy}
          />
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end">
          <Button size="sm" disabled={busy} onClick={() => void save()}>
            添加 Provider
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

/** 占位分区：标题 + 待实现提示 */
function PlaceholderSection({ title }: { title: string }) {
  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold">{title}</h1>
      <p className="text-sm text-muted-foreground">该设置分区待实现。</p>
    </>
  )
}

const TITLES: Record<Exclude<SettingsSectionId, 'general' | 'models'>, string> = {
  appearance: '外观',
  shortcuts: '键盘快捷键',
  persona: '个性化',
  memory: '记忆',
  subagents: '子智能体',
  plugins: '插件',
  mcp: 'MCP 服务器',
  skills: '技能',
  hooks: '钩子',
  usage: '使用统计',
  projects: '项目',
  sessions: '会话管理',
  automation: '自动化',
  browser: '浏览器控制',
  boxes: '设备'
}

/** id → 分区组件（SettingsPage 据此渲染） */
export const settingsSections: Record<SettingsSectionId, ReactNode> = {
  general: <GeneralSection />,
  models: <ModelsSection />,
  ...Object.fromEntries(Object.entries(TITLES).map(([id, title]) => [id, <PlaceholderSection title={title} />]))
} as Record<SettingsSectionId, ReactNode>
