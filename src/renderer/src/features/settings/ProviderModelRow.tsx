/**
 * 共享模型行家族（2026-11-10 从 ModelsSection.tsx 拆出）：自定义/内置两个
 * provider 详情里成对重复的模型行 UI（原块 A/B）与 disabledModels 数据语义
 * helper 的收敛处 —— ModelBadges / ModelRowActions / ProviderModelRow /
 * AddModelButton 四个展示件 + toggleDisabledModel / disabledAfterRename 两个
 * 纯函数（原 toggleModel 与 saveModel 改名清理的两份重复实现不再各持一份）。
 */
import { IconPencil, IconPlus, IconTrash } from '@tabler/icons-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { ModelVisionBadge } from '@/components/ModelVisionBadge'
import { useEngineStore } from '@/stores/engine'
import type { ModelDef } from '@/env.d'
import { BADGE, formatContext } from './models-recipes'

/** 模型行徽标：上下文窗口 + 推理（ModelDef / 目录摘要通用） */
function ModelBadges({ def }: { def: ModelDef }) {
  return (
    <>
      {def.contextWindow !== undefined && (
        <span className={cn(BADGE, 'shrink-0')}>{formatContext(def.contextWindow)}</span>
      )}
      {def.reasoning && <span className={cn(BADGE, 'shrink-0')}>思考</span>}
    </>
  )
}

/** 模型行的通用动作簇：绝对定位悬浮于开关左侧（2026-11-20 改 —— 原流内
    w-20 占位在徽标与开关间留 80px 死区；悬浮零占位、悬停不推挤开关）。
    onDelete 缺省 = 无删除语义（未改过的目录模型不能删，只能禁用） */
function ModelRowActions({
  modelId,
  onEdit,
  onDelete,
}: {
  modelId: string
  onEdit: () => void
  onDelete?: () => void
}) {
  return (
    // right-13 = 行右内距 16 + 开关 32 + 缝 4：簇右缘贴开关左侧；
    // 不加分组胶囊底（2026-11-20 用户定调）—— 两颗钮裸浮于行上
    <div className="absolute right-13 flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
      <Button
        variant="ghost"
        size="sm"
        aria-label={`编辑模型 ${modelId}`}
        onClick={onEdit}
      >
        <IconPencil className="size-3.5" />
      </Button>
      {onDelete && (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`删除模型 ${modelId}`}
          onClick={onDelete}
        >
          <IconTrash className="size-3.5" />
        </Button>
      )}
    </div>
  )
}

/** 共享模型行（原自定义/内置详情里成对重复的 h-12 行收敛）：id 文本 + 徽标 +
    hover 动作簇 + 常驻启用开关；行容器 divide-y 分隔，圆角由外层容器裁 */
export function ProviderModelRow({
  providerId,
  def,
  enabled,
  onToggle,
  onEdit,
  onDelete,
}: {
  providerId: string
  def: ModelDef
  /** 开关语义 = 启用（off 才进 disabledModels） */
  enabled: boolean
  onToggle: (on: boolean) => void
  onEdit: () => void
  /** 缺省 = 无删除语义（未改过的目录模型不能删，只能禁用） */
  onDelete?: () => void
}) {
  const input = useEngineStore((s) => s.models.find((m) => m.provider === providerId && m.id === def.id)?.input)
  return (
    /* relative 供动作簇绝对定位锚定 */
    <div className="group relative flex h-12 min-w-0 items-center gap-2 px-4">
      {/* 显示一律 id（2026-11-10 定调，同聊天页模型菜单口径）：目录营销名与
          API id 不对应，所见即所传；自定义条目更是 id 输什么是什么 —— name 不参与呈现 */}
      <span className="min-w-0 shrink truncate text-sm">{def.id}</span>
      <ModelVisionBadge input={input} size="default" />
      <ModelBadges def={def} />
      <ModelRowActions modelId={def.id} onEdit={onEdit} onDelete={onDelete} />
      <Switch checked={enabled} onCheckedChange={onToggle} aria-label={`${def.id} 启用`} className="ml-auto" />
    </div>
  )
}

/** 「添加模型」按钮在两种供应商详情中共用（2026-11-20 用户定调降 sm 档，
    与字段标签行的小号视觉量级协调）。 */
export function AddModelButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={onClick}
    >
      <IconPlus className="size-3.5" />
      添加模型
    </Button>
  )
}

/** toggleModel 的共享核心（原自定义/内置两份重复收敛）：disabledModels 的
    集合增删 —— on = 启用（移出禁用集），off = 禁用（加入） */
export function toggleDisabledModel(
  disabled: ReadonlyArray<string>,
  modelId: string,
  on: boolean
): string[] {
  const next = new Set(disabled)
  if (on) next.delete(modelId)
  else next.add(modelId)
  return [...next]
}

/** saveModel 改名时的旧禁用记录清理（原两份重复收敛）：id 变了，旧 id 的禁用
    记录随之失效（留着 = 裸 id 死记录，内置详情还会把它当被禁行复活展示）；
    未改名（originalId === nextId）时保留该记录，禁用态不丢 */
export function disabledAfterRename(
  disabled: ReadonlyArray<string> | undefined,
  originalId: string | null,
  nextId: string
): string[] {
  return (disabled ?? []).filter((id) => id !== originalId || id === nextId)
}
