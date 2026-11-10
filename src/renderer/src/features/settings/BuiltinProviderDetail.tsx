/**
 * 内置供应商详情卡（2026-11-10 从 ModelsSection.tsx 拆出）：ModelsSection
 * master-detail 右栏的内置分支。模型列表 = pi 目录 ∪ 用户新增（override.models
 * 按同 id 覆盖目录值）；模型行复用 ProviderModelRow（与自定义详情共享），
 * 增改走 ModelDialog。
 */
import { useMemo, useState } from 'react'
import { Input } from '@/components/ui/input'
import { ProviderLogo } from '@/components/ProviderLogo'
import { useEngineStore } from '@/stores/engine'
import type { ModelDef, ProviderOverrideDef } from '@/env.d'
import { ApiKeyField } from './ApiKeyField'
import { ModelDialog } from './ModelDialog'
import {
  AddModelButton,
  disabledAfterRename,
  ProviderModelRow,
  toggleDisabledModel,
} from './ProviderModelRow'
import { FIELD_GAP, FIELD_LABEL } from './models-recipes'

/** 内置供应商详情：模型列表 = pi 目录 ∪ 用户新增（override.models 按同 id 覆盖
    目录值）。目录行可编辑（生成覆盖 = "改配置"）、可禁用（disabledModels）；
    被覆盖行可删除（还原目录值），未动过的目录行只能禁用 */
export function BuiltinProviderDetail({
  providerId,
  name,
  override,
  onPatchOverride,
}: {
  providerId: string
  name: string
  override: ProviderOverrideDef | null
  onPatchOverride: (providerId: string, next: ProviderOverrideDef | null) => void
}) {
  const [value, setValue] = useState(override?.baseUrl ?? '')
  const models = useEngineStore((s) => s.models)
  const catalog = useMemo(
    () => models.filter((m) => m.provider === providerId),
    [models, providerId]
  )
  // 目录只展示前 8 个 + 尾行计数（部分厂商上百个模型全渲染没有意义）
  const shown = catalog.slice(0, 8)
  const catalogMap = useMemo(() => new Map(catalog.map((m) => [m.id, m])), [catalog])
  const customModels = override?.models ?? []
  const disabledIds = override?.disabledModels ?? []
  const disabled = new Set(disabledIds)
  const [dialog, setDialog] = useState<{ initial: ModelDef | null } | null>(null)

  // 合并行：目录（被覆盖项的值取 override.models）+ 目录外新增 + 已禁用的目录 id，
  // 最后统一按 id 排序 —— 行序必须与开关状态解耦（2026-11-10 用户反馈：禁用/启用
  // 会让行从目录位跳到末尾裸 id 行再跳回，来回搬家容易点错）。
  // 禁用行必须复活展示：引擎不注册被禁模型 → 它从 models.list/catalog 消失，
  // 但开关语义是可逆的 —— 行也跟着消失的话就永远打不开了（裸 id 行，无标签；
  // 重新打开后模型回到 models.list，完整信息随 catalog 回来，位置不动）。
  // 显示一律用 id（2026-11-10 定调）：目录营销名（DeepSeek V4 Pro 之类）与
  // API id 不对应，所见即所传；name 不参与呈现（2026-11-09 的目录名统一已废弃）
  const merged = useMemo(() => {
    const rows: Array<{ def: ModelDef; shadowed: boolean }> = shown.map((m) => {
      const shadow = customModels.find((x) => x.id === m.id)
      return {
        def: shadow ?? { id: m.id, contextWindow: m.contextWindow, reasoning: m.reasoning },
        shadowed: shadow !== undefined
      }
    })
    rows.push(
      ...customModels
        .filter((x) => !catalog.some((m) => m.id === x.id))
        .map((m) => ({ def: m, shadowed: true }))
    )
    // 已禁用且不在 catalog（被引擎滤掉）也不被 override.models 接管的 id；
    // 引擎未应用的窗口期（旧进程）id 仍在 catalog → 上面已渲染，这里跳过防重复
    rows.push(
      ...disabledIds
        .filter((id) => !catalogMap.has(id) && !customModels.some((x) => x.id === id))
        .map((id) => ({ def: { id }, shadowed: false }))
    )
    return rows.sort((a, b) => a.def.id.localeCompare(b.def.id))
  }, [shown, customModels, catalog, catalogMap, disabledIds])

  // 空调整（无 baseUrl / 无自定义模型 / 无禁用）= 撤掉整条 override 通道
  const commitOverride = (next: ProviderOverrideDef): void => {
    const empty =
      next.baseUrl.length === 0 &&
      (next.models?.length ?? 0) === 0 &&
      (next.disabledModels?.length ?? 0) === 0
    onPatchOverride(providerId, empty ? null : next)
  }

  // 开关的禁用集增删与"改名清旧禁用记录"与自定义详情同语义，收敛在
  // ProviderModelRow 的共享 helper 里，此处只负责组 override 提交
  const toggleModel = (modelId: string, on: boolean): void => {
    commitOverride({
      providerId,
      baseUrl: value,
      models: override?.models,
      disabledModels: toggleDisabledModel(disabledIds, modelId, on)
    })
  }
  // 保存：目录行编辑 → 覆盖（shadow）；改名时旧禁用记录清理（disabledAfterRename）
  const saveModel = (model: ModelDef, originalId: string | null): void => {
    commitOverride({
      providerId,
      baseUrl: value,
      models: [...(override?.models ?? []).filter((m) => m.id !== originalId && m.id !== model.id), model],
      disabledModels: disabledAfterRename(override?.disabledModels, originalId, model.id)
    })
  }
  // 删除 = 移除覆盖（被覆盖的目录模型还原目录值；目录外新增则移除）
  const deleteModel = (modelId: string): void => {
    commitOverride({
      providerId,
      baseUrl: value,
      models: customModels.filter((m) => m.id !== modelId),
      disabledModels: (override?.disabledModels ?? []).filter((id) => id !== modelId)
    })
  }

  return (
    <>
      <header className="flex items-center gap-3">
        <ProviderLogo providerId={providerId} size={28} className="rounded-lg" />
        <span className="min-w-0 flex-1 truncate text-base font-semibold">{name}</span>
      </header>

      <ApiKeyField providerId={providerId} />

      <div className={FIELD_GAP}>
        <label className={FIELD_LABEL}>Base URL 覆盖</label>
        <Input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() =>
            value.trim() !== (override?.baseUrl ?? '') &&
            commitOverride({
              providerId,
              baseUrl: value.trim(),
              models: override?.models,
              disabledModels: override?.disabledModels
            })
          }
          placeholder="留空走官方端点；填中转/代理地址覆盖"
          className="mt-1.5 rounded-lg text-[13px]"
          autoComplete="off"
        />
      </div>

      {/* 模型列表：目录行（编辑=覆盖 / 开关=禁用）+ 新增行（可删） */}
      <div className={FIELD_GAP}>
        <div className="flex items-center justify-between">
          <label className={FIELD_LABEL}>模型列表</label>
          <AddModelButton onClick={() => setDialog({ initial: null })} />
        </div>
        <div className="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border">
          {merged.map(({ def: row, shadowed }) => (
            <ProviderModelRow
              key={row.id}
              def={row}
              enabled={!disabled.has(row.id)}
              onToggle={(on) => toggleModel(row.id, on)}
              onEdit={() => setDialog({ initial: row })}
              onDelete={shadowed ? () => deleteModel(row.id) : undefined}
            />
          ))}
          {catalog.length > shown.length && (
            <div className="flex h-10 items-center justify-center text-xs text-muted-foreground">
              还有 {catalog.length - shown.length} 个目录模型
            </div>
          )}
          {catalog.length === 0 && (
            <div className="flex h-10 items-center justify-center text-xs text-muted-foreground">
              目录中暂无该供应商的模型，可手动添加
            </div>
          )}
        </div>
      </div>

      <ModelDialog
        open={dialog !== null}
        initial={dialog?.initial ?? null}
        catalog={catalogMap}
        onClose={() => setDialog(null)}
        onSave={saveModel}
      />
    </>
  )
}
