/**
 * 自定义供应商详情卡（2026-11-10 从 ModelsSection.tsx 拆出）：ModelsSection
 * master-detail 右栏的自定义分支。字段组成：名称（头部行内编辑）/ Base URL /
 * API 格式 / API Key / 模型列表 / 供应商兼容设置；模型行复用
 * ProviderModelRow（与内置详情共享），增改走 ModelDialog。
 */
import { useMemo, useState } from 'react'
import { IconChevronDown, IconDots, IconDownload, IconTrash } from '@tabler/icons-react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { ProviderLogo } from '@/components/ProviderLogo'
import { useEngineStore } from '@/stores/engine'
import type { CustomProviderDef, ModelDef } from '@/env.d'
import { ApiKeyField } from './ApiKeyField'
import { CompatFields } from './CompatFields'
import { FormatSelect } from './FormatSelect'
import { ModelDialog } from './ModelDialog'
import { ModelDiscoveryDialog } from './ModelDiscoveryDialog'
import {
  AddModelButton,
  disabledAfterRename,
  ProviderModelRow,
  toggleDisabledModel,
} from './ProviderModelRow'
import { FIELD_GAP, FIELD_LABEL } from './models-recipes'

/** 自定义供应商详情。文本输入本地编辑、失焦提交（每次修改即时全量保存，见
    ModelsSection.tsx 文件头"保存语义"）；模型行 = ModelDef 文本 + hover 动作簇 +
    常驻启用开关，增改走对话框 */
export function CustomProviderDetail({
  def,
  onChange,
  onDelete,
}: {
  def: CustomProviderDef
  onChange: (def: CustomProviderDef) => void
  onDelete: (id: string) => void
}) {
  const [name, setName] = useState(def.name)
  const [baseUrl, setBaseUrl] = useState(def.baseUrl)
  const models = useEngineStore((s) => s.models)
  // 目录里本 provider 的模型（sync 成功后才有）→ 智能预填数据源
  const catalog = useMemo(
    () => new Map(models.filter((m) => m.provider === def.id).map((m) => [m.id, m])),
    [models, def.id]
  )
  const modelRows = useMemo(() => {
    const defs = def.modelDefs ?? []
    const defIds = new Set(defs.map((d) => d.id))
    return [...defs, ...def.models.filter((id) => !defIds.has(id)).map((id): ModelDef => ({ id }))]
  }, [def])
  const existingIds = useMemo(() => new Set(modelRows.map((m) => m.id)), [modelRows])
  const [dialog, setDialog] = useState<{ initial: ModelDef | null } | null>(null)
  const [discoverOpen, setDiscoverOpen] = useState(false)
  const apiFormat = def.apiFormat ?? 'openai-completions'

  const patch = (partial: Partial<CustomProviderDef>): void => onChange({ ...def, ...partial })
  const disabled = new Set(def.disabledModels ?? [])
  // 开关的禁用集增删与"改名清旧禁用记录"与内置详情同语义，收敛在
  // ProviderModelRow 的共享 helper 里，此处只负责接 CustomProviderDef 的字段
  const toggleModel = (modelId: string, on: boolean): void =>
    patch({ disabledModels: toggleDisabledModel(def.disabledModels ?? [], modelId, on) })
  // 保存：id 升级为完整定义（从简写 models 移出，避免双处出现）；改名时旧禁用
  // 记录清理（disabledAfterRename）
  const saveModel = (model: ModelDef, originalId: string | null): void => {
    patch({
      models: def.models.filter((m) => m !== model.id && m !== originalId),
      modelDefs: [
        ...(def.modelDefs ?? []).filter((d) => d.id !== originalId && d.id !== model.id),
        model
      ],
      disabledModels: disabledAfterRename(def.disabledModels, originalId, model.id)
    })
  }
  const deleteModel = (modelId: string): void => {
    patch({
      models: def.models.filter((m) => m !== modelId),
      modelDefs: (def.modelDefs ?? []).filter((d) => d.id !== modelId),
      disabledModels: (def.disabledModels ?? []).filter((id) => id !== modelId)
    })
  }
  const applyDiscovered = (addedDefs: ModelDef[]): void => {
    if (addedDefs.length === 0) return
    const addedIds = new Set(addedDefs.map((d) => d.id))
    patch({
      models: def.models.filter((id) => !addedIds.has(id)),
      modelDefs: [...(def.modelDefs ?? []), ...addedDefs]
    })
  }

  return (
    <>
      {/* 头部：品牌标 + 名称（行内编辑）+ [启用开关 / 更多菜单] */}
      <header className="flex items-center gap-3">
        <ProviderLogo providerId={def.id} name={name} size={28} className="rounded-lg" />
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => name.trim() !== def.name && patch({ name: name.trim() })}
          aria-label="Provider 名称"
          className="h-8 min-w-0 flex-1 rounded-md bg-transparent px-1.5 text-base font-semibold outline-none hover:bg-accent-foreground/5 focus-visible:bg-accent-foreground/5"
        />
        <Switch
          checked={def.disabled !== true}
          onCheckedChange={(on) => patch({ disabled: on ? undefined : true })}
          aria-label={def.disabled === true ? '启用 Provider' : '禁用 Provider'}
        />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="default"
                aria-label="更多操作"
              />
            }
          >
            <IconDots className="size-4" />
          </DropdownMenuTrigger>
          {/* w-auto 覆盖面板默认的锚宽跟随（w-(--anchor-width)）—— 触发钮是
              「⋯」小钮，锚宽面板会把「删除 Provider」压折行 */}
          <DropdownMenuContent align="end" className="w-auto min-w-36">
            <DropdownMenuItem onClick={() => onDelete(def.id)} className="text-destructive">
              <IconTrash className="size-4" />
              删除 Provider
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div className={FIELD_GAP}>
        <label className={FIELD_LABEL}>Base URL</label>
        <Input
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          onBlur={() => baseUrl.trim() !== def.baseUrl && patch({ baseUrl: baseUrl.trim() })}
          placeholder="https://api.example.com"
          className="mt-1.5 rounded-lg text-sm"
          autoComplete="off"
        />
      </div>

      <div className={FIELD_GAP}>
        <label className={FIELD_LABEL}>API 格式</label>
        <FormatSelect value={def.apiFormat} onChange={(apiFormat) => patch({ apiFormat })} />
      </div>

      <ApiKeyField providerId={def.id} />

      {/* 模型列表：开关关 = 进 disabledModels（可逆，引擎不注册该模型） */}
      <div className={FIELD_GAP}>
        <div className="flex items-center justify-between gap-2">
          <label className={FIELD_LABEL}>模型列表</label>
          <div className="flex items-center gap-1.5">
            <Hint tip={baseUrl.trim() ? '从 /models 接口自动获取可用模型' : '请先填写 Base URL'}>
              <Button
                variant="outline"
                size="sm"
                disabled={!baseUrl.trim()}
                onClick={() => setDiscoverOpen(true)}
              >
                <IconDownload className="size-3.5" />
                获取模型列表
              </Button>
            </Hint>
            <AddModelButton onClick={() => setDialog({ initial: null })} />
          </div>
        </div>
        {modelRows.length > 0 && (
          // 限高 + 内部滚动同内置详情（max-h-96 = 8 行），多模型不推长右栏页面
          <div className="mt-2 max-h-96 divide-y divide-border overflow-y-auto rounded-lg border border-border">
            {modelRows.map((row) => (
              <ProviderModelRow
                key={row.id}
                providerId={def.id}
                def={row}
                enabled={!disabled.has(row.id)}
                onToggle={(on) => toggleModel(row.id, on)}
                onEdit={() => setDialog({ initial: row })}
                onDelete={() => deleteModel(row.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 低频兼容默认放在主要连接与模型配置之后，不打断必填路径。 */}
      <Collapsible className="mt-6">
        <CollapsibleTrigger render={<Button variant="disclosure" size="xs" className="group -ml-2" />}>
          供应商兼容设置
          <IconChevronDown className="transition-transform group-data-panel-open:rotate-180" aria-hidden="true" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-4">
            <CompatFields value={def.compat} apiFormat={apiFormat} onChange={(compat) => patch({ compat })} />
          </div>
        </CollapsibleContent>
      </Collapsible>

      <ModelDialog
        open={dialog !== null}
        initial={dialog?.initial ?? null}
        catalog={catalog}
        apiFormat={apiFormat}
        onClose={() => setDialog(null)}
        onSave={saveModel}
      />

      <ModelDiscoveryDialog
        open={discoverOpen}
        onClose={() => setDiscoverOpen(false)}
        providerId={def.id}
        baseUrl={baseUrl.trim() || def.baseUrl}
        apiFormat={apiFormat}
        existingIds={existingIds}
        catalog={catalog}
        onApply={applyDiscovered}
      />
    </>
  )
}
