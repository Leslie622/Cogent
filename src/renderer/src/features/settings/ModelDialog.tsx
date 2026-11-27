/**
 * 模型添加/编辑对话框（2026-11-10 从 ModelsSection.tsx 拆出，2026-11-28 对标主流升级）：
 * 被自定义与内置两个 provider 详情共用。
 * - 支持全 7 档（含 Off 禁关）与协议值自定义映射（thinkingLevelMap）；
 * - 编辑内置模型时从 catalog ModelSummary 无损回显有效档位与能力；
 * - 新增时按「内置目录 → 主流模型家族预设 → 保守基线（Off/Low/Medium/High）」智能预填；
 * - 基础 / 思考 / 兼容分区复用 shadcn Tabs；思考高级项共用轻量折叠入口。
 */
import { useEffect, useId, useState } from 'react'
import { IconAlertCircle, IconCheck, IconChevronDown, IconLock, IconSparkles } from '@tabler/icons-react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Toggle } from '@/components/ui/toggle'
import {
  buildClosedThinkingMap,
  DEFAULT_REASONING_MAP,
  matchModelPreset,
  NON_OFF_THINKING_LEVELS,
  THINKING_LEVEL_LABELS,
  THINKING_ORDER,
  THINKING_PRESETS,
} from '@shared/model-presets'
import type {
  CustomProviderDef,
  ModelDef,
  ModelSummary,
  ProviderCompatDef,
  ThinkingBudgetsOverride,
  ThinkingLevelMap,
  ThinkingLevelWithOff,
} from '@/env.d'
import { CompatFields } from './CompatFields'
import { ContextWindowSlider } from './ContextWindowSlider'
import { FIELD_LABEL, formatContext } from './models-recipes'

type ApiFormat = NonNullable<CustomProviderDef['apiFormat']>

interface ThinkingDraft {
  enabled: Record<ThinkingLevelWithOff, boolean>
  wire: Record<ThinkingLevelWithOff, string>
}

const BUDGET_LEVELS = ['minimal', 'low', 'medium', 'high'] as const
const BUDGET_PLACEHOLDER: Record<(typeof BUDGET_LEVELS)[number], string> = {
  minimal: '1024',
  low: '2048',
  medium: '8192',
  high: '16384',
}

const THINKING_PRESET_ITEMS = [
  { value: '__custom__', label: '自定义' },
  ...THINKING_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })),
]

function draftFromMap(map?: ThinkingLevelMap, fallbackLevels?: readonly ThinkingLevelWithOff[]): ThinkingDraft {
  const enabled: Record<ThinkingLevelWithOff, boolean> = {
    off: true,
    minimal: false,
    low: true,
    medium: true,
    high: true,
    xhigh: false,
    max: false,
  }
  const wire: Record<ThinkingLevelWithOff, string> = {
    off: '',
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'max',
  }

  if (map !== undefined) {
    enabled.off = map.off !== null
    wire.off = typeof map.off === 'string' ? map.off : ''
    for (const level of NON_OFF_THINKING_LEVELS) {
      const val = map[level]
      if (level === 'xhigh' || level === 'max') {
        enabled[level] = typeof val === 'string'
      } else {
        // pi 目录中未显式置 null 的标准四档（minimal/low/medium/high）默认视为可用
        enabled[level] = val !== null
      }
      wire[level] = typeof val === 'string' ? val : level
    }
    return { enabled, wire }
  }

  if (fallbackLevels && fallbackLevels.length > 0) {
    for (const level of THINKING_ORDER) {
      enabled[level] = fallbackLevels.includes(level)
    }
    return { enabled, wire }
  }

  return draftFromMap(DEFAULT_REASONING_MAP)
}

function resolveInitialThinking(initial: ModelDef | null, hit: ModelSummary | undefined): ThinkingDraft {
  if (initial?.thinkingLevelMap !== undefined) {
    return draftFromMap(initial.thinkingLevelMap)
  }
  if (initial?.thinkingLevels !== undefined) {
    return draftFromMap(undefined, ['off', ...initial.thinkingLevels])
  }
  if (hit?.thinkingLevelMap !== undefined) {
    return draftFromMap(hit.thinkingLevelMap, hit.thinkingLevels)
  }
  if (hit?.thinkingLevels !== undefined) {
    return draftFromMap(undefined, hit.thinkingLevels)
  }
  return draftFromMap(DEFAULT_REASONING_MAP)
}

function hasAnyNonOffLevel(draft: ThinkingDraft): boolean {
  return NON_OFF_THINKING_LEVELS.some((level) => draft.enabled[level])
}

function draftToMap(draft: ThinkingDraft): ThinkingLevelMap {
  const enabledWires: Partial<Record<ThinkingLevelWithOff, string | undefined>> = {}
  if (draft.enabled.off && draft.wire.off.trim().length > 0) {
    enabledWires.off = draft.wire.off.trim()
  }
  for (const level of NON_OFF_THINKING_LEVELS) {
    if (draft.enabled[level]) {
      enabledWires[level] = draft.wire[level].trim() || level
    }
  }
  return buildClosedThinkingMap(enabledWires, draft.enabled.off)
}

export function ModelDialog({
  open,
  onClose,
  initial,
  catalog,
  apiFormat,
  onSave,
}: {
  open: boolean
  onClose: () => void
  /** 编辑态传既有定义，新增传 null */
  initial: ModelDef | null
  /** 目录模型按 id 查（智能预填与无损回显数据源） */
  catalog: Map<string, ModelSummary>
  /** 当前供应商 API 格式（用于匹配家族预设与过滤 compat 选项） */
  apiFormat?: ApiFormat
  onSave: (def: ModelDef, originalId: string | null) => void
}) {
  const fieldId = useId()
  const [tab, setTab] = useState('basic')
  const [id, setId] = useState('')
  const [context, setContext] = useState(200_000)
  const [maxTokens, setMaxTokens] = useState('')
  const [imageInput, setImageInput] = useState(false)
  const [reasoning, setReasoning] = useState(false)
  const [thinking, setThinking] = useState<ThinkingDraft>(() => draftFromMap(DEFAULT_REASONING_MAP))
  const [compat, setCompat] = useState<ProviderCompatDef | undefined>(undefined)
  const [budgets, setBudgets] = useState<Record<(typeof BUDGET_LEVELS)[number], string>>({
    minimal: '',
    low: '',
    medium: '',
    high: '',
  })

  const trimmedId = id.trim()
  const catalogHit = catalog.get(trimmedId)
  const presetHit = catalogHit === undefined ? matchModelPreset(trimmedId, apiFormat) : undefined
  const lockId = initial !== null && catalogHit !== undefined && catalogHit.userDefined !== true
  const lockOffDisabled = lockId && !catalogHit.thinkingLevels.includes('off')

  useEffect(() => {
    if (!open) return
    setTab('basic')
    const hit = initial ? catalog.get(initial.id) : undefined
    setId(initial?.id ?? '')
    setContext(initial?.contextWindow ?? hit?.contextWindow ?? 200_000)
    const effectiveMaxTokens = initial?.maxTokens ?? hit?.maxTokens
    setMaxTokens(effectiveMaxTokens !== undefined ? String(effectiveMaxTokens) : '')
    setImageInput((initial?.input ?? hit?.input)?.includes('image') === true)
    setReasoning(initial?.reasoning ?? hit?.reasoning ?? false)
    setThinking(resolveInitialThinking(initial, hit))
    setCompat(initial?.compat)
    setBudgets({
      minimal: initial?.thinkingBudgets?.minimal !== undefined ? String(initial.thinkingBudgets.minimal) : '',
      low: initial?.thinkingBudgets?.low !== undefined ? String(initial.thinkingBudgets.low) : '',
      medium: initial?.thinkingBudgets?.medium !== undefined ? String(initial.thinkingBudgets.medium) : '',
      high: initial?.thinkingBudgets?.high !== undefined ? String(initial.thinkingBudgets.high) : '',
    })
  }, [open, initial, catalog])

  const applyPrefill = (modelId: string, force = false): void => {
    if (initial && !force) return
    const key = modelId.trim()
    if (!key) return
    const hit = catalog.get(key)
    if (hit) {
      setContext(hit.contextWindow)
      setMaxTokens(String(hit.maxTokens))
      setReasoning(hit.reasoning)
      setImageInput(hit.input?.includes('image') === true)
      setThinking(resolveInitialThinking(null, hit))
      return
    }
    const preset = matchModelPreset(key, apiFormat)
    if (!preset) return
    setContext(preset.contextWindow)
    setMaxTokens(String(preset.maxTokens))
    setReasoning(preset.reasoning)
    setImageInput(preset.input.includes('image'))
    if (preset.thinkingLevelMap) {
      setThinking(draftFromMap(preset.thinkingLevelMap))
    }
    if (preset.compat) {
      setCompat(preset.compat)
    }
  }

  const toggleReasoning = (checked: boolean): void => {
    setReasoning(checked)
    if (checked && !hasAnyNonOffLevel(thinking)) {
      if (catalogHit) {
        setThinking(resolveInitialThinking(null, catalogHit))
      } else if (presetHit?.thinkingLevelMap) {
        setThinking(draftFromMap(presetHit.thinkingLevelMap))
      } else {
        setThinking(draftFromMap(DEFAULT_REASONING_MAP))
      }
    }
  }

  const toggleLevel = (level: ThinkingLevelWithOff, pressed: boolean): void => {
    setThinking((prev) => ({
      ...prev,
      enabled: { ...prev.enabled, [level]: pressed },
    }))
  }

  const updateWire = (level: ThinkingLevelWithOff, value: string): void => {
    setThinking((prev) => ({
      ...prev,
      wire: { ...prev.wire, [level]: value },
    }))
  }

  const missingThinkingLevel = reasoning && !hasAnyNonOffLevel(thinking)
  const canSave = trimmedId.length > 0 && !missingThinkingLevel

  const save = (): void => {
    if (!canSave) return
    const parseCount = (raw: string): number | undefined => {
      const n = Number(raw)
      return raw.trim().length > 0 && Number.isFinite(n) && n > 0 ? n : undefined
    }
    const maxTokensValue = parseCount(maxTokens)
    const budgetEntries = BUDGET_LEVELS
      .map((level) => [level, parseCount(budgets[level])] as const)
      .filter(([, n]) => n !== undefined)
    const budgetOverride: ThinkingBudgetsOverride = Object.fromEntries(budgetEntries)
    onSave(
      {
        id: trimmedId,
        contextWindow: context,
        ...(maxTokensValue !== undefined && { maxTokens: maxTokensValue }),
        // 显式 text 覆盖目录 image；省略会重新继承，无法真正关闭图片。
        input: imageInput ? ['text', 'image'] : ['text'],
        ...(reasoning && { reasoning: true }),
        ...(reasoning && { thinkingLevelMap: draftToMap(thinking) }),
        ...(Object.keys(budgetOverride).length > 0 && { thinkingBudgets: budgetOverride }),
        ...(compat !== undefined && { compat }),
      },
      initial?.id ?? null
    )
    onClose()
  }

  const enabledLevels = THINKING_ORDER.filter((level) => thinking.enabled[level])
  const thinkingPreset = THINKING_PRESETS.find((preset) => {
    const draft = draftFromMap(preset.map)
    return THINKING_ORDER.every((level) =>
      thinking.enabled[level] === draft.enabled[level] &&
      (!thinking.enabled[level] || thinking.wire[level] === draft.wire[level])
    )
  })?.id ?? '__custom__'
  const hasThinkingOverrides = enabledLevels.some((level) =>
    thinking.wire[level].trim().length > 0 && thinking.wire[level].trim() !== level
  ) || BUDGET_LEVELS.some((level) => budgets[level].trim().length > 0)

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="h-[min(42rem,calc(100%-2rem))] p-6 sm:max-w-xl" initialFocus={false}>
        <DialogHeader>
          <DialogTitle>{initial ? '编辑模型' : '添加模型'}</DialogTitle>
        </DialogHeader>
        <div className="grid shrink-0 gap-2 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center sm:gap-3">
          <label htmlFor={lockId ? undefined : `${fieldId}-id`} className="text-xs text-muted-foreground">模型 ID</label>
          {lockId ? (
            <span className="min-w-0 break-all text-sm select-text">{id}</span>
          ) : (
            <Input
              id={`${fieldId}-id`}
              value={id}
              onChange={(event) => setId(event.target.value)}
              onBlur={() => applyPrefill(id)}
              placeholder="如 deepseek-v4-pro / gpt-5.4 / claude-opus-4-7"
              autoComplete="off"
            />
          )}
          {lockId ? (
            <Hint tip="内置模型 ID 不可修改；需要其他 ID 请添加模型">
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <IconLock className="size-3.5" aria-hidden="true" />
                内置
              </span>
            </Hint>
          ) : (catalogHit || presetHit) && (
            <Button type="button" variant="ghost" size="xs" onClick={() => applyPrefill(id, true)}>
              <IconSparkles aria-hidden="true" />
              套用{catalogHit ? '目录' : '家族'}预设
            </Button>
          )}
        </div>
        <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-5">
          <TabsList variant="line" className="-ml-px shrink-0 gap-6 p-0">
            <TabsTrigger value="basic" className="px-0">基础设置</TabsTrigger>
            <TabsTrigger value="thinking" className="px-0">
              思考配置
              {missingThinkingLevel && <IconAlertCircle className="text-destructive" aria-hidden="true" />}
            </TabsTrigger>
            <TabsTrigger value="compat" className="px-0">端点兼容</TabsTrigger>
          </TabsList>
          <TabsContent value="basic" keepMounted className="-mx-6 min-h-0 overflow-y-auto px-6 pb-2">
            <div className="flex flex-col gap-5">
              <section className="flex flex-col gap-5" aria-labelledby={`${fieldId}-capacity`}>
                <h3 id={`${fieldId}-capacity`} className="text-xs text-muted-foreground">容量</h3>
                <div>
                  <div className="flex items-center justify-between">
                    <span className={FIELD_LABEL}>上下文窗口</span>
                    <span className="text-xs text-muted-foreground">{formatContext(context)}</span>
                  </div>
                  <div className="mt-1.5">
                    <ContextWindowSlider value={context} onChange={setContext} />
                  </div>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <label htmlFor={`${fieldId}-max-output`} className={FIELD_LABEL}>最大输出 Token</label>
                  </div>
                  <Input
                    id={`${fieldId}-max-output`}
                    value={maxTokens}
                    onChange={(event) => setMaxTokens(event.target.value)}
                    placeholder="默认"
                    inputMode="numeric"
                    className="w-36 shrink-0 sm:w-40"
                    autoComplete="off"
                  />
                </div>
              </section>
              <Separator />
              <section className="flex flex-col gap-5" aria-labelledby={`${fieldId}-input`}>
                <h3 id={`${fieldId}-input`} className="text-xs text-muted-foreground">输入能力</h3>
                <div className="flex items-center justify-between gap-4">
                  <span className={FIELD_LABEL}>文本输入</span>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <IconCheck className="size-3.5" aria-hidden="true" />
                    始终支持
                  </span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <label htmlFor={`${fieldId}-image`} className={FIELD_LABEL}>支持图片输入</label>
                  <Switch id={`${fieldId}-image`} checked={imageInput} onCheckedChange={setImageInput} />
                </div>
              </section>
            </div>
          </TabsContent>
          <TabsContent value="thinking" keepMounted className="-mx-6 min-h-0 overflow-y-auto px-6 pb-2">
            <div className="flex flex-col gap-5">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <label htmlFor={`${fieldId}-reasoning`} className={FIELD_LABEL}>支持思考</label>
                </div>
                <Switch id={`${fieldId}-reasoning`} checked={reasoning} onCheckedChange={toggleReasoning} />
              </div>
              {reasoning && (
                <>
                  <div className="flex items-center justify-between gap-4">
                    <label htmlFor={`${fieldId}-preset`} className={FIELD_LABEL}>档位预设</label>
                    <Select
                      value={thinkingPreset}
                      items={THINKING_PRESET_ITEMS}
                      onValueChange={(next) => {
                        const preset = THINKING_PRESETS.find((item) => item.id === next)
                        if (preset) setThinking(draftFromMap(preset.map))
                      }}
                    >
                      <SelectTrigger id={`${fieldId}-preset`} className="w-44 sm:w-48">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent align="end" alignItemWithTrigger={false}>
                        <SelectGroup>
                          {THINKING_PRESET_ITEMS.map((item) => (
                            <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <label htmlFor={`${fieldId}-off`} className={FIELD_LABEL}>允许 Off 档位</label>
                      {lockOffDisabled && <p className="mt-1 text-xs text-muted-foreground">此内置模型不支持 Off</p>}
                    </div>
                    <Switch
                      id={`${fieldId}-off`}
                      checked={thinking.enabled.off}
                      disabled={lockOffDisabled}
                      onCheckedChange={(on) => toggleLevel('off', on)}
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-2">
                      <span id={`${fieldId}-levels`} className={FIELD_LABEL}>可用思考档位</span>
                      <span className="text-xs text-muted-foreground">可多选</span>
                    </div>
                    <div role="group" aria-labelledby={`${fieldId}-levels`} className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
                      {NON_OFF_THINKING_LEVELS.map((level) => (
                        <Hint key={level} tip={`启用后允许下发 ${level}`} side="bottom">
                          <Toggle variant="outline" size="sm" pressed={thinking.enabled[level]} onPressedChange={(on) => toggleLevel(level, on)} className="min-w-0">
                            {thinking.enabled[level] && <IconCheck aria-hidden="true" />}
                            {THINKING_LEVEL_LABELS[level]}
                          </Toggle>
                        </Hint>
                      ))}
                    </div>
                    {missingThinkingLevel && <p className="text-xs text-destructive">请至少启用一个思考档位（Minimal ~ Max）。</p>}
                  </div>
                  <Collapsible>
                    <div className="flex items-center gap-2">
                      <CollapsibleTrigger render={<Button type="button" variant="disclosure" size="xs" className="group -ml-2" />}>
                        高级设置
                        <IconChevronDown className="transition-transform group-data-panel-open:rotate-180" aria-hidden="true" />
                      </CollapsibleTrigger>
                      {hasThinkingOverrides && <span className="text-xs text-muted-foreground">已自定义</span>}
                    </div>
                    <CollapsibleContent keepMounted>
                      <div className="mt-3 ml-1 flex flex-col gap-5 border-l pl-3">
                        <section className="flex flex-col gap-2" aria-labelledby={`${fieldId}-mapping`}>
                          <h3 id={`${fieldId}-mapping`} className="text-xs text-muted-foreground">协议映射</h3>
                          {enabledLevels.map((level) => (
                            <div key={level} className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-3">
                              <label htmlFor={`${fieldId}-wire-${level}`} className="text-xs text-muted-foreground">{THINKING_LEVEL_LABELS[level]}</label>
                              <Input id={`${fieldId}-wire-${level}`} value={thinking.wire[level]} onChange={(event) => updateWire(level, event.target.value)} placeholder={level === 'off' ? '留空，按默认方式关闭' : level} aria-label={`${THINKING_LEVEL_LABELS[level]} 协议值`} autoComplete="off" />
                            </div>
                          ))}
                        </section>
                        <section className="flex flex-col gap-2" aria-labelledby={`${fieldId}-budgets`}>
                          <h3 id={`${fieldId}-budgets`} className="text-xs text-muted-foreground">思考预算（Token）</h3>
                          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                            {BUDGET_LEVELS.map((level) => (
                              <div key={level} className="flex flex-col gap-1.5">
                                <label htmlFor={`${fieldId}-budget-${level}`} className="text-xs text-muted-foreground">{THINKING_LEVEL_LABELS[level]}</label>
                                <Input id={`${fieldId}-budget-${level}`} value={budgets[level]} onChange={(event) => setBudgets((current) => ({ ...current, [level]: event.target.value }))} placeholder={BUDGET_PLACEHOLDER[level]} aria-label={`${THINKING_LEVEL_LABELS[level]} 思考预算`} inputMode="numeric" autoComplete="off" />
                              </div>
                            ))}
                          </div>
                          <p className="text-xs text-muted-foreground">XHigh / Max 沿用 High 预算。</p>
                        </section>
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                </>
              )}
            </div>
          </TabsContent>
          <TabsContent value="compat" keepMounted className="-mx-6 min-h-0 overflow-y-auto px-6 pb-2">
            <div className="flex flex-col gap-5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">
                  {apiFormat === 'anthropic-messages' ? 'Anthropic Messages' : apiFormat === 'openai-responses' ? 'OpenAI Responses' : 'OpenAI Chat Completions'}
                </span>
                <Button type="button" variant="ghost" size="xs" disabled={compat === undefined} onClick={() => setCompat(undefined)}>恢复自动</Button>
              </div>
              <CompatFields value={compat} apiFormat={apiFormat} onChange={setCompat} />
            </div>
          </TabsContent>
        </Tabs>
        <DialogFooter className="-mx-6 -mb-6 px-6">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button onClick={save} disabled={!canSave}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
