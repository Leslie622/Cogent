/**
 * 设置 · 模型设置分区（引擎数据接线件；2026-11-08 布局改版 master-detail）：
 * 左栏供应商清单（内置 / 自定义两组，行带状态点：绿 = 已配 Key 且未禁用；
 * 像素宽可拖拽 176–320、拖过下限折成 48px 图标栏，宽与折叠态 localStorage
 * 记忆 —— use-provider-rail-split），右栏所选供应商详情 ——
 * - 自定义：名称（头部行内编辑）/ Base URL / API 格式 / API Key / 模型列表
 *   （ModelDef 行：对话框增改、启用开关、删除）
 * - 内置：API Key + Base URL（留空走官方端点，填值即覆盖）+ 模型列表 =
 *   pi 目录 ∪ 用户新增。目录行也
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
import { useEffect, useMemo, useState } from 'react'
import { IconChevronDown, IconPlus, IconRefresh } from '@tabler/icons-react'
import { cn } from 'cn'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { ProviderLogo } from '@/components/ProviderLogo'
import { SidebarResizeHandle } from '@/components/SidebarResizeHandle'
import { providerDisplayName, useEngineStore } from '@/stores/engine'
import type { CustomProviderDef, ProviderOverrideDef } from '@/env.d'
import { BuiltinProviderDetail } from './BuiltinProviderDetail'
import { CustomProviderDetail } from './CustomProviderDetail'
import { SettingsHeader } from './SettingsParts'
import {
  RAIL_COLLAPSED,
  RAIL_WIDTH_MAX,
  RAIL_WIDTH_MIN,
  useProviderRailSplit,
} from './use-provider-rail-split'

/** 内置 provider 精选清单：模型目录 40+ 家全列太长，只放常用 7 家（含 Z.AI）。
    完整目录经 models.list 可见；key 状态与覆盖走同一套存储。
    DeepSeek / Z.AI 置顶（2026-11-20 用户指令）：主力在用，其余保持原相对序 */
const BUILTIN_PROVIDERS: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'zai', name: 'Z.AI' },
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'openai', name: 'OpenAI' },
  { id: 'google', name: 'Google' },
  { id: 'openrouter', name: 'OpenRouter' },
  { id: 'xai', name: 'xAI' },
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
        'flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-sm text-foreground',
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

/** 图标栏态行：品牌标钮居中，右上角标状态点（背景色描边在 logo 上抠出轮廓），
    title 原生提示补回被折叠掉的名字；无障碍标签把状态并进按钮名一并读出 */
function ProviderIconButton({
  active,
  providerId,
  name,
  ok,
  onClick
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
      title={name}
      aria-current={active ? 'true' : undefined}
      aria-label={`${name}（${ok ? '已就绪' : '待配置'}）`}
      className={cn(
        'relative flex h-9 w-9 items-center justify-center rounded-lg text-foreground',
        'hover:bg-accent-foreground/5',
        active && 'bg-accent-foreground/5'
      )}
    >
      <ProviderLogo providerId={providerId} name={name} size={20} />
      <span
        aria-hidden
        className={cn(
          'absolute right-1 top-1 size-1.5 rounded-full outline-2 outline-background',
          ok ? 'bg-emerald-500' : 'bg-warning'
        )}
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
    <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2.5">
      <p className="text-sm font-medium text-destructive">
        凭据文件不可读（如跨机器拷贝 ~/.cogent 后的加密不匹配），重新保存任意 API key 即会以全新文件恢复
      </p>
      <p className="mt-0.5 text-xs leading-normal text-muted-foreground">{error}</p>
    </div>
  )
}

export function ModelsSection() {
  const models = useEngineStore((s) => s.models)
  const providers = useEngineStore((s) => s.customProviders)
  const overrides = useEngineStore((s) => s.overrides)
  const saveProviders = useEngineStore((s) => s.saveProviders)
  const refreshKeys = useEngineStore((s) => s.refreshKeys)
  const refreshModels = useEngineStore((s) => s.refreshModels)
  const keyConfigured = useEngineStore((s) => s.keyConfigured)

  const [selectedId, setSelectedId] = useState(BUILTIN_PROVIDERS[0].id)
  // 左栏分栏：像素宽状态机 + localStorage 记忆，机制同 content-sidebar
  const rail = useProviderRailSplit()
  // 凭据链路健康位：挂载查一次（error 非 null → 页头下方横幅；恢复动作是
  // 重存 key，横幅不提供按钮，等下一次 setApiKey 后用户手动刷新即可见）
  const [credentialsError, setCredentialsError] = useState<string | null>(null)
  useEffect(() => {
    void window.cogent.getCredentialsStatus().then((status) => setCredentialsError(status.error))
  }, [])

  const extraBuiltinProviders = useMemo(() => {
    const pinned = new Set(BUILTIN_PROVIDERS.map((p) => p.id))
    const seen = new Set<string>()
    for (const m of models) {
      if (!m.provider.startsWith('custom/') && !pinned.has(m.provider)) {
        seen.add(m.provider)
      }
    }
    for (const id of Object.keys(overrides)) {
      if (!id.startsWith('custom/') && !pinned.has(id)) {
        seen.add(id)
      }
    }
    return [...seen]
      .map((id) => ({ id, name: providerDisplayName(id, providers) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [models, overrides, providers])

  const selectedDef = providers.find((p) => p.id === selectedId)
  const selectedBuiltin =
    BUILTIN_PROVIDERS.find((b) => b.id === selectedId) ??
    extraBuiltinProviders.find((b) => b.id === selectedId)
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
    // 已有未动过的空壳时不再叠新条目：连点「添加」只会跳到那条空壳上（空壳 =
    // 与新建初始态逐字段相等；zcode 官方是模板弹窗选完才建，本页是行内编辑流，
    // 取最小修 —— 复用空壳，避免左栏堆一排「新 Provider」）
    const untouched = providers.find(
      (p) =>
        p.name === '新 Provider' &&
        p.baseUrl === '' &&
        p.models.length === 0 &&
        (p.modelDefs ?? []).length === 0 &&
        (p.apiFormat ?? 'openai-completions') === 'openai-completions' &&
        (p.disabledModels ?? []).length === 0 &&
        p.disabled !== true &&
        p.compat === undefined
    )
    if (untouched) {
      setSelectedId(untouched.id)
      return
    }
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
      {/* 页头走 SettingsHeader 共用模板（同列位同边距，切页标题不跳位）；
          主体卡与页头同列（max-w-3xl px-10 同容器量，卡片边 = 列边） */}
      <div className="mx-auto w-full shrink-0 max-w-3xl px-10 pt-8">
        <SettingsHeader
          title="模型设置"
          desc="管理自定义模型供应商与密钥配置，配置后可在聊天时选择使用。"
          toolbar={
            <div className="ml-auto flex items-center gap-2">
              <Hint tip="刷新模型目录" side="bottom">
                {/* 圆角随 Button 默认 lg 档（2026-11-20 用户定调），与旁边「添加供应商」同排一致 */}
                <Button
                  variant="outline"
                  size="default"
                  aria-label="刷新"
                  onClick={() => {
                    void refreshKeys()
                    void refreshModels()
                  }}
                >
                  <IconRefresh className="size-4" />
                </Button>
              </Hint>
              <Button size="default" className="gap-1 rounded-lg text-sm" onClick={addProvider}>
                <IconPlus className="size-4" />
                添加供应商
              </Button>
            </div>
          }
        />
        {credentialsError !== null && <CredentialsBanner error={credentialsError} />}
      </div>

      {/* 主体卡收进页头同列（mx-auto max-w-3xl px-10，卡片边 = 列边）：与其余
          分区组卡同对齐语言；zcode 官方 master-detail 亦与页头同容器无限宽例外
          （2026-11-20 撤「全宽自撑」旧例外）。卡内：左清单（可拖宽 / 折成
          图标栏）+ 右详情（各自滚动，卡身撑满剩余高度）。拖拽杀过渡（同
          AppShell 手法）：把手 active 期间栏宽过渡失效 —— 拖拽直写要跟手；
          唯一例外是换挡瞬间（rail 打 data-snap），折叠/展开的 200ms 收拢动画
          在拖拽中也要放行 */}
      <div className="mx-auto flex w-full min-h-0 max-w-3xl flex-1 flex-col px-10">
        {/* mt-4（16px）≠ 全分区「页头→组卡」的 mt-8 模板量：本页唯一一张整高卡，
            32px 空当显虚；取 zcode SectionLayout space-y-4 同量 */}
        <div className="mb-8 mt-4 flex min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-background [&:has([data-separator=active])>[data-provider-rail]:not([data-snap])]:transition-none">
          {/* 左栏 = 裁剪窗（宽度承载收拢动画）+ 双层内容：清单层保宽被裁（拖拽中
              行不逐帧回流）、图标层淡入接管 —— 两层随折叠态交叉淡出 + inert 断交互 */}
          <aside
            ref={rail.railRef}
            data-provider-rail
            /* 分隔线由拖拽条独占（1px + 悬停光带），aside 不再叠 border-r 双线 */
            className="relative shrink-0 overflow-hidden transition-[width] duration-200 ease-out"
            style={{ width: rail.collapsed ? RAIL_COLLAPSED : rail.widthPx }}
          >
            <div
              ref={rail.listRef}
              inert={rail.collapsed ? true : undefined}
              className={cn(
                'absolute inset-y-0 left-0 min-w-44 overflow-y-auto px-3 pb-3 transition-opacity duration-200 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
                rail.collapsed && 'opacity-0'
              )}
              style={{ width: rail.widthPx }}
            >
              <section className="flex flex-col gap-0.5">
                <div className="sticky top-0 z-10 bg-background pt-3 pb-1">
                  <div className="flex h-6 items-center px-2 text-xs text-muted-foreground">内置供应商</div>
                </div>
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
              {extraBuiltinProviders.length > 0 && (
                <section className="mt-1 flex flex-col gap-0.5">
                  <Collapsible defaultOpen={extraBuiltinProviders.some((p) => keyConfigured[p.id] === true || p.id === selectedId)}>
                    <div className="sticky top-0 z-10 bg-background py-1">
                      <CollapsibleTrigger className="flex h-7 w-full items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground hover:bg-accent-foreground/5 hover:text-foreground">
                        <IconChevronDown className="size-3.5 transition-transform duration-200 [[data-state=closed]_&]:-rotate-90" />
                        <span>更多内置供应商（{extraBuiltinProviders.length}）</span>
                      </CollapsibleTrigger>
                    </div>
                    <CollapsibleContent className="flex flex-col gap-0.5 pt-0.5">
                      {extraBuiltinProviders.map((provider) => (
                        <ProviderNavRow
                          key={provider.id}
                          active={selectedDef === undefined && activeBuiltin.id === provider.id}
                          providerId={provider.id}
                          name={provider.name}
                          ok={keyConfigured[provider.id] === true}
                          onClick={() => setSelectedId(provider.id)}
                        />
                      ))}
                    </CollapsibleContent>
                  </Collapsible>
                </section>
              )}
              <section className="mt-1 flex flex-col gap-0.5">
                <div className="sticky top-0 z-10 bg-background pt-3 pb-1">
                  <div className="flex h-6 items-center px-2 text-xs text-muted-foreground">自定义供应商</div>
                </div>
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
            </div>
            <div
              inert={!rail.collapsed ? true : undefined}
              className={cn(
                'absolute inset-y-0 left-0 w-12 overflow-y-auto transition-opacity duration-200 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
                !rail.collapsed && 'opacity-0'
              )}
            >
              <div className="flex flex-col items-center gap-1 p-1.5">
                {BUILTIN_PROVIDERS.map((provider) => (
                  <ProviderIconButton
                    key={provider.id}
                    active={selectedDef === undefined && activeBuiltin.id === provider.id}
                    providerId={provider.id}
                    name={provider.name}
                    ok={keyConfigured[provider.id] === true}
                    onClick={() => setSelectedId(provider.id)}
                  />
                ))}
                {extraBuiltinProviders
                  .filter((p) => keyConfigured[p.id] === true || p.id === selectedId)
                  .map((provider) => (
                    <ProviderIconButton
                      key={provider.id}
                      active={selectedDef === undefined && activeBuiltin.id === provider.id}
                      providerId={provider.id}
                      name={provider.name}
                      ok={keyConfigured[provider.id] === true}
                      onClick={() => setSelectedId(provider.id)}
                    />
                  ))}
                <div aria-hidden className="my-1.5 h-px w-6 bg-border" />
                {providers.map((def) => (
                  <ProviderIconButton
                    key={def.id}
                    active={selectedDef?.id === def.id}
                    providerId={def.id}
                    name={def.name}
                    ok={def.disabled !== true && keyConfigured[def.id] === true}
                    onClick={() => setSelectedId(def.id)}
                  />
                ))}
              </div>
            </div>
          </aside>

          {/* 自绘拖拽条（1px 线 + 把手胶囊 + 悬停光带，同 content-sidebar 形态）：
              向左拖过下限阻力区折成图标栏、向右拖出恢复；键盘 ←/→ 微调、双击回默认宽 */}
          <SidebarResizeHandle
            min={RAIL_WIDTH_MIN}
            max={RAIL_WIDTH_MAX}
            collapsedWidth={RAIL_COLLAPSED}
            readWidth={rail.readWidth}
            writeWidth={rail.writeWidth}
            onCommit={rail.commit}
            onReset={rail.reset}
          />

          <div className="min-w-0 flex-1 overflow-y-auto">
            {/* key 挂详情：切换供应商时重置本地草稿态；上边距 24px 比下边距
                收小一档（详情头自带视觉重量，等距显得头重脚空） */}
            <div className="mx-auto max-w-2xl px-8 pt-6 pb-8">
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
    </div>
  )
}
