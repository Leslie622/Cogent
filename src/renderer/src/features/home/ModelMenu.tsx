/**
 * 模型下拉（content-main 首页会话视图 → 底部输入卡工具行，上下文指示器右侧）：
 * 架构位置 = ChatComposer 工具行的模型选择入口；职责边界 = 读 engine store
 * 呈现可用模型（配了 key 且未禁用）并把选择写回（setActiveModel /
 * setThinkingLevel），"管理模型"跳设置页模型分区 —— 本件不发起会话、不碰
 * chat store；思考力度滑杆（ThinkingSlider）嵌在面板末段。
 */
import { useEffect, useMemo } from 'react'
import { IconCheck, IconChevronDown } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { ProviderLogo } from '@/components/ProviderLogo'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { findActiveModel, providerDisplayName, usableModels, useEngineStore } from '@/stores/engine'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import type { ModelSummary } from '@/env.d'
import { ThinkingSlider, thinkingVisuals } from './ThinkingSlider'

/** 模型菜单（对标参考稿三段联动）：厂商子列表（只列有可用模型的 = 配了 key 且
 * 未禁用，点击切换下方模型段，活动模型所在厂商打勾）→ 模型段（所选厂商的清单，
 * 点击提交为活动模型）→ 思考力度（会话级 thinkingLevel，随 agent.submit 下发）
 * → 管理模型（设置页模型分区）。数据源全部是 engine store，与设置页联动。
 * 所选厂商状态放在面板组件里：base-ui 关闭即卸载内容，每次打开重置 */
export function ModelMenu() {
  const models = useEngineStore((s) => s.models)
  const keyConfigured = useEngineStore((s) => s.keyConfigured)
  const customProviders = useEngineStore((s) => s.customProviders)
  const activeModelId = useEngineStore((s) => s.activeModelId)
  const activeProviderId = useEngineStore((s) => s.activeProviderId)
  const setActiveModel = useEngineStore((s) => s.setActiveModel)

  const usable = useMemo(() => usableModels(models, keyConfigured), [models, keyConfigured])
  const active = findActiveModel(models, keyConfigured, activeModelId, activeProviderId)

  // 回落：submit 下发的模型必须在可用集里，否则引擎侧按未知/无 key 报错。
  // 双键校验，回落顺序 = 同 provider 的首个模型（保住用户的厂商选择）→ 全局首个
  useEffect(() => {
    if (usable.length === 0) return
    if (usable.some((m) => m.id === activeModelId && m.provider === activeProviderId)) return
    const sameProvider =
      activeProviderId !== null ? usable.find((m) => m.provider === activeProviderId) : undefined
    const next = sameProvider ?? usable[0]
    setActiveModel(next.id, next.provider)
  }, [usable, activeModelId, activeProviderId, setActiveModel])

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="gap-1.5 px-2 text-[13px] text-muted-foreground has-[>svg]:px-2 hover:bg-accent-foreground/5 hover:text-foreground"
            aria-label="选择模型"
          />
        }
      >
        {/* 对标参考稿：触发钮 = 品牌标 + 当前模型 id + 箭头。显示一律 id
            （2026-11-10 定调）：目录营销名与 API id 不对应，所见即所传 */}
        {active ? (
          <>
            <ProviderLogo providerId={active.provider} name={providerDisplayName(active.provider, customProviders)} size={16} />
            {active.id}
          </>
        ) : usable.length > 0 ? (
          '选择模型'
        ) : (
          '配置模型'
        )}
        <IconChevronDown className="size-3" />
      </DropdownMenuTrigger>
      {/* w-auto 覆写原语的 w-(--anchor-width)（锚点是小圆钮，菜单会被压窄裁行） */}
      <DropdownMenuContent align="end" className="w-auto min-w-52 max-w-80">
        <ModelMenuPanel />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** 菜单面板（厂商子列表钻入 / 思考力度滑杆），随菜单关闭卸载 → 所选厂商每次
    打开重置为活动模型所在厂商 */
function ModelMenuPanel() {
  const models = useEngineStore((s) => s.models)
  const keyConfigured = useEngineStore((s) => s.keyConfigured)
  const customProviders = useEngineStore((s) => s.customProviders)
  const activeModelId = useEngineStore((s) => s.activeModelId)
  const activeProviderId = useEngineStore((s) => s.activeProviderId)
  const setActiveModel = useEngineStore((s) => s.setActiveModel)
  const thinkingLevel = useEngineStore((s) => s.thinkingLevel)
  const setThinkingLevel = useEngineStore((s) => s.setThinkingLevel)
  const setView = useUiStore((s) => s.setView)
  const setSection = useSettingsStore((s) => s.setSection)

  const groups = useMemo(() => {
    const map = new Map<string, ModelSummary[]>()
    for (const model of usableModels(models, keyConfigured)) {
      const list = map.get(model.provider)
      if (list) list.push(model)
      else map.set(model.provider, [model])
    }
    return [...map.entries()]
  }, [models, keyConfigured])

  // 双键查活动模型（findActiveModel 语义；此处 groups 已是可用集，就地查）。
  // shownProviderId = 面板展示的厂商段：活动模型的 provider，无活动模型回落首个
  const active = groups
    .flatMap(([, list]) => list)
    .find((m) => m.id === activeModelId && m.provider === activeProviderId)
  const shownProviderId = active?.provider ?? groups.at(0)?.[0] ?? null
  const activeProviderEntry = groups.find(([p]) => p === shownProviderId)
  const activeProviderName = activeProviderEntry
    ? providerDisplayName(activeProviderEntry[0], customProviders)
    : '配置模型'

  return (
    <>
      {/* 厂商行：钻入厂商子列表（配了 key 的厂商 + 管理模型）。点选厂商 = 活动模型
          切到该厂商的第一个模型，模型列表随之更新 */}
      <DropdownMenuSub>
        <DropdownMenuSubTrigger className="gap-2">
          {activeProviderEntry && (
            <ProviderLogo providerId={activeProviderEntry[0]} name={activeProviderName} size={16} />
          )}
          <span className="min-w-0 flex-1 truncate">{activeProviderName}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {groups.map(([providerId, list]) => (
            // closeOnClick=false：选厂商只是中途步，用户紧接着要挑该厂商下的具体
            // 模型，不关菜单（模型行/管理模型才关）。子列表保持打开，悬停到下方
            // 模型行时 base-ui 浮层树自动让位换出模型列表
            <DropdownMenuItem
              key={providerId}
              closeOnClick={false}
              onClick={() => setActiveModel(list[0].id, providerId)}
            >
              <ProviderLogo providerId={providerId} name={providerDisplayName(providerId, customProviders)} size={16} />
              <span className="min-w-0 flex-1 truncate">{providerDisplayName(providerId, customProviders)}</span>
              {shownProviderId === providerId && <IconCheck className="ml-auto size-3.5" />}
            </DropdownMenuItem>
          ))}
          {groups.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuItem
            onClick={() => {
              setView('settings')
              setSection('models')
            }}
          >
            管理模型
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
      {/* 模型行：钻入选当前厂商的模型（厂商先行，模型列表跟着厂商走） */}
      <DropdownMenuSub>
        <DropdownMenuSubTrigger className="gap-2">
          <span className="min-w-0 flex-1 truncate">
            {active?.id ?? (groups.length > 0 ? '选择模型' : '配置模型')}
          </span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {(activeProviderEntry?.[1] ?? []).map((model) => (
            <DropdownMenuItem key={model.id} onClick={() => setActiveModel(model.id, model.provider)}>
              <span className="min-w-0 flex-1 truncate">{model.id}</span>
              {model.id === activeModelId && <IconCheck className="ml-auto size-3.5" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
      {/* 思考力度：会话级 thinkingLevel，渐变滑杆（对标参考稿）。
          标签值文字色与滑杆填充同取坡道色（实色，无透明度文字） */}
      <DropdownMenuGroup>
        <DropdownMenuLabel className="flex items-center justify-between">
          思考力度
          <span
            className="text-xs font-normal transition-colors duration-200"
            style={{ color: thinkingVisuals(thinkingLevel, active?.thinkingLevels).text }}
          >
            {thinkingVisuals(thinkingLevel, active?.thinkingLevels).label}
          </span>
        </DropdownMenuLabel>
        {/* supportedLevels 依当前活动模型（pi 目录判定的真实可用档）；
            无模型信息时不传 → 滑杆走全档兼容口径 */}
        <ThinkingSlider
          value={thinkingLevel}
          supportedLevels={active?.thinkingLevels}
          onChange={(level) => setThinkingLevel(level)}
        />
      </DropdownMenuGroup>
    </>
  )
}
