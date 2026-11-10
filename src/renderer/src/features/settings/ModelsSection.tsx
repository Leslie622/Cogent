/**
 * 设置 · 模型设置分区（引擎数据接线件；2026-11-08 布局改版 master-detail）：
 * 左栏供应商清单（内置 / 自定义两组，行带状态点：绿 = 已配 Key 且未禁用），
 * 右栏所选供应商详情 ——
 * - 自定义：名称（头部行内编辑）/ Base URL / API 格式 / API Key / 模型列表
 *   （ModelDef 行：对话框增改、启用开关、删除）
 * - 内置：API Key + Base URL 覆盖 + 模型列表 = pi 目录 ∪ 用户新增。目录行也
 *   可编辑（改值/改 id = 覆盖目录同名项，走 override.models 通道；删除覆盖 =
 *   还原目录值），目录快照滞后 / 缺模型由用户补齐
 * 模型增改统一走 ModelDialog（扁平字段：ID / 上下文滑杆 / 最大输出 / 输入类型 /
 *   思考模式 / 思考等级；id 命中目录自动预填）。
 * 保存语义：每次修改即时全量保存（saveProviders：落盘 + 引擎 sync + 目录重拉），
 *   文本输入失焦提交；key 走 credentials 域单独通道 —— 写 setApiKey / 读
 *   getApiKey（全量回显），状态位走 listApiKeys。
 * 2026-11-10 拆分：详情卡与表单件移居同目录独立文件（CustomProviderDetail /
 *   BuiltinProviderDetail / ModelDialog / ContextWindowSlider / ApiKeyField /
 *   FormatSelect / ProviderModelRow，共用配方在 models-recipes），本文件只剩
 *   页头 + master-detail 骨架；同批接两条新 IPC —— 挂载查 getCredentialsStatus
 *   （凭据降级横幅，见 CredentialsBanner），ApiKeyField 增「清除」动作
 *   （removeApiKey）。
 */
import { useEffect, useState } from 'react'
import { IconPlus, IconRefresh } from '@tabler/icons-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { ProviderLogo } from '@/components/ProviderLogo'
import { useEngineStore } from '@/stores/engine'
import type { CustomProviderDef, ProviderOverrideDef } from '@/env.d'
import { BuiltinProviderDetail } from './BuiltinProviderDetail'
import { CustomProviderDetail } from './CustomProviderDetail'

/** 内置 provider 精选清单：模型目录 40+ 家全列太长，只放常用 7 家（含 Z.AI）。
    完整目录经 models.list 可见；key 状态与覆盖走同一套存储 */
const BUILTIN_PROVIDERS: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'openai', name: 'OpenAI' },
  { id: 'google', name: 'Google' },
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'openrouter', name: 'OpenRouter' },
  { id: 'xai', name: 'xAI' },
  { id: 'zai', name: 'Z.AI' },
]

/** 左栏清单行：品牌标 + 名称 + 状态点（hover 黑 5% 软叠，active = 常驻 hover 色） */
function ProviderNavRow({
  active,
  providerId,
  name,
  ok,
  onClick,
}: {
  active: boolean
  providerId: string
  name: string
  ok: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-[13px] text-foreground',
        'hover:bg-accent-foreground/5',
        active && 'bg-accent-foreground/5'
      )}
    >
      <ProviderLogo providerId={providerId} name={name} size={20} />
      <span className="min-w-0 flex-1 truncate text-left">{name}</span>
      <span
        aria-label={ok ? '已就绪' : '待配置'}
        className={cn('size-1.5 shrink-0 rounded-full', ok ? 'bg-emerald-500' : 'bg-warning')}
      />
    </button>
  )
}

/** 凭据链路降级横幅（样式口径同 App.tsx 的 EngineFailureBanner：destructive
    实色文字 + /30 边 + /5 底，不用透明度文字色）：getCredentialsStatus 的
    error 非 null = 凭据文件不可读，key 的读写都会绕行降级。文案给自救路径：
    重存任意 key 即以全新文件恢复 */
function CredentialsBanner({ error }: { error: string }) {
  return (
    <div className="mt-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-2.5">
      <p className="text-[13px] font-medium text-destructive">
        凭据文件不可读（如跨机器拷贝 ~/.cogent 后的加密不匹配），重新保存任意 API key 即会以全新文件恢复
      </p>
      <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">{error}</p>
    </div>
  )
}

export function ModelsSection() {
  const providers = useEngineStore((s) => s.customProviders)
  const overrides = useEngineStore((s) => s.overrides)
  const saveProviders = useEngineStore((s) => s.saveProviders)
  const refreshKeys = useEngineStore((s) => s.refreshKeys)
  const refreshModels = useEngineStore((s) => s.refreshModels)
  const keyConfigured = useEngineStore((s) => s.keyConfigured)

  const [selectedId, setSelectedId] = useState(BUILTIN_PROVIDERS[0].id)
  // 凭据链路健康位：挂载查一次（error 非 null → 页头下方横幅；恢复动作是
  // 重存 key，横幅不提供按钮，等下一次 setApiKey 后用户手动刷新即可见）
  const [credentialsError, setCredentialsError] = useState<string | null>(null)
  useEffect(() => {
    void window.cogent.getCredentialsStatus().then((status) => setCredentialsError(status.error))
  }, [])

  const selectedDef = providers.find((p) => p.id === selectedId)
  const selectedBuiltin = BUILTIN_PROVIDERS.find((b) => b.id === selectedId)
  // 选中项被删时回落首个内置：派生值，无需同步逻辑
  const activeBuiltin = selectedBuiltin ?? BUILTIN_PROVIDERS[0]

  /** overrides 表 → 协议数组（空 baseUrl 合法 = 不覆盖端点、只做模型调整） */
  const overrideEntries = (): ProviderOverrideDef[] => Object.values(overrides)

  const updateProvider = (def: CustomProviderDef): void => {
    void saveProviders(
      providers.map((p) => (p.id === def.id ? def : p)),
      overrideEntries()
    )
  }

  const deleteProvider = (id: string): void => {
    void saveProviders(
      providers.filter((p) => p.id !== id),
      overrideEntries()
    )
    if (selectedId === id) setSelectedId(BUILTIN_PROVIDERS[0].id)
  }

  const addProvider = (): void => {
    // id 即刻生成后不再随改名变化（key/覆盖绑定在 id 上，漂移等于换 provider）
    const id = `custom/p-${crypto.randomUUID().slice(0, 8)}`
    void saveProviders(
      [
        ...providers,
        { id, name: '新 Provider', baseUrl: '', models: [], apiFormat: 'openai-completions' },
      ],
      overrideEntries()
    )
    setSelectedId(id)
  }

  /** 内置 provider 的调整写回：next = null 表示撤掉整条 override（还原原实例） */
  const patchOverride = (providerId: string, next: ProviderOverrideDef | null): void => {
    const map = { ...overrides }
    if (next) map[providerId] = next
    else delete map[providerId]
    void saveProviders(providers, Object.values(map))
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 页头：标题 + 描述行（右挂刷新 / 添加供应商） */}
      <div className="shrink-0 px-10 pt-8">
        <h2 className="text-2xl font-semibold">模型设置</h2>
        <div className="mt-3 flex items-center justify-between gap-4">
          <p className="text-[13px] text-muted-foreground">
            管理自定义模型供应商与密钥配置，配置后可在聊天时选择使用。
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="icon-sm"
              className="rounded-full"
              title="重新拉取密钥状态与模型目录"
              aria-label="刷新"
              onClick={() => {
                void refreshKeys()
                void refreshModels()
              }}
            >
              <IconRefresh className="size-4" />
            </Button>
            <Button size="sm" className="gap-1 rounded-lg text-[13px]" onClick={addProvider}>
              <IconPlus className="size-4" />
              添加供应商
            </Button>
          </div>
        </div>
        {credentialsError !== null && <CredentialsBanner error={credentialsError} />}
      </div>

      {/* 主体卡：左清单 + 右详情（各自滚动，卡身撑满剩余高度） */}
      <div className="mx-10 mb-8 mt-4 flex min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-background">
        <aside className="w-72 shrink-0 overflow-y-auto border-r border-border p-3">
          <section className="flex flex-col gap-0.5">
            <div className="flex h-7 items-center px-2 text-xs text-muted-foreground">内置供应商</div>
            {BUILTIN_PROVIDERS.map((provider) => (
              <ProviderNavRow
                key={provider.id}
                active={selectedDef === undefined && activeBuiltin.id === provider.id}
                providerId={provider.id}
                name={provider.name}
                ok={keyConfigured[provider.id] === true}
                onClick={() => setSelectedId(provider.id)}
              />
            ))}
          </section>
          <section className="mt-4 flex flex-col gap-0.5">
            <div className="flex h-7 items-center px-2 text-xs text-muted-foreground">自定义供应商</div>
            {providers.length === 0 ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">尚无自定义供应商</p>
            ) : (
              providers.map((def) => (
                <ProviderNavRow
                  key={def.id}
                  active={selectedDef?.id === def.id}
                  providerId={def.id}
                  name={def.name}
                  ok={def.disabled !== true && keyConfigured[def.id] === true}
                  onClick={() => setSelectedId(def.id)}
                />
              ))
            )}
          </section>
        </aside>

        <div className="min-w-0 flex-1 overflow-y-auto">
          {/* key 挂详情：切换供应商时重置本地草稿态 */}
          <div className="mx-auto max-w-2xl px-8 py-8">
            {selectedDef ? (
              <CustomProviderDetail
                key={selectedDef.id}
                def={selectedDef}
                onChange={updateProvider}
                onDelete={deleteProvider}
              />
            ) : (
              <BuiltinProviderDetail
                key={activeBuiltin.id}
                providerId={activeBuiltin.id}
                name={activeBuiltin.name}
                override={overrides[activeBuiltin.id] ?? null}
                onPatchOverride={patchOverride}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
