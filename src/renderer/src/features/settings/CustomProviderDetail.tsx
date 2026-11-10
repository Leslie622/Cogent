/**
 * 自定义供应商详情卡（2026-11-10 从 ModelsSection.tsx 拆出）：ModelsSection
 * master-detail 右栏的自定义分支。字段组成：名称（头部行内编辑）/ Base URL /
 * API 格式 / API Key / 模型列表；模型行复用 ProviderModelRow（与内置详情共享），
 * 增改走 ModelDialog。
 */
import { useMemo, useState } from 'react'
import { IconDots, IconTrash } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
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
import { FormatSelect } from './FormatSelect'
import { ModelDialog } from './ModelDialog'
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
  const [dialog, setDialog] = useState<{ initial: ModelDef | null } | null>(null)

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
                size="icon-sm"
                className="text-muted-foreground hover:bg-accent-foreground/5 hover:text-foreground"
                aria-label="更多操作"
              />
            }
          >
            <IconDots className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
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
          className="mt-1.5 rounded-lg text-[13px]"
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
        <div className="flex items-center justify-between">
          <label className={FIELD_LABEL}>模型列表</label>
          <AddModelButton onClick={() => setDialog({ initial: null })} />
        </div>
        {modelRows.length === 0 ? (
          <p className="mt-2 text-[13px] text-muted-foreground">
            添加端点上可用的模型，配置后才会出现在聊天的模型菜单里。
          </p>
        ) : (
          <div className="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border">
            {modelRows.map((row) => (
              <ProviderModelRow
                key={row.id}
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

      <ModelDialog
        open={dialog !== null}
        initial={dialog?.initial ?? null}
        catalog={catalog}
        onClose={() => setDialog(null)}
        onSave={saveModel}
      />
    </>
  )
}
