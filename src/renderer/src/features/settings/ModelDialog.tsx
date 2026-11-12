/**
 * 模型添加/编辑对话框（2026-11-10 从 ModelsSection.tsx 拆出）：被自定义与
 * 内置两个 provider 详情（CustomProviderDetail / BuiltinProviderDetail）共用，
 * 扁平字段表单 + 目录智能预填，保存经 onSave 上抛由调用方写回 provider 定义。
 */
import { useEffect, useState } from 'react'
import { IconCheck, IconChevronDown } from '@tabler/icons-react'
import { cn } from 'cn'
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
import { Switch } from '@/components/ui/switch'
import { Toggle } from '@/components/ui/toggle'
import type { ModelDef, ModelSummary, ThinkingBudgetsOverride, ThinkingLevel } from '@/env.d'
import { ContextWindowSlider } from './ContextWindowSlider'
import { FIELD_LABEL, formatContext } from './models-recipes'

/** 思考等级可选项（pi 的六个非 off 等级，从低到高；off 是"关闭思考"不属"支持"）。
    label 中文给用户看，value 是透传给端点的 effort 参数值（title 里保留） */
const THINKING_LEVELS: ReadonlyArray<{ id: ThinkingLevel; label: string }> = [
  { id: 'minimal', label: '最低' },
  { id: 'low', label: '低' },
  { id: 'medium', label: '中' },
  { id: 'high', label: '高' },
  { id: 'xhigh', label: '极高' },
  { id: 'max', label: '最大' },
]

/** 思考预算四档的中文标签与占位（占位 = pi 内建默认表的量级示意，仅提示不承诺） */
const BUDGET_LABEL: Record<'minimal' | 'low' | 'medium' | 'high', string> = {
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高'
}
const BUDGET_PLACEHOLDER: Record<'minimal' | 'low' | 'medium' | 'high', string> = {
  minimal: '1024',
  low: '2048',
  medium: '8192',
  high: '16384'
}

/** 对话框 chip 统一配方：13px 中文 400 字重（小号中文禁 500，组件默认 500 要压掉）
    + 选中黑 10% 软叠（三组 chip 同款） */
const CHIP_BASE = 'text-[13px] font-normal'
const CHIP_PRESSED = 'aria-pressed:bg-foreground/10 aria-pressed:text-foreground'

/** 添加/编辑模型对话框（扁平字段）：模型 ID / 上下文窗口（滑杆）/ 最大输出
    Token / 输入类型（pi 仅支持 文本|图片 两态）/ 思考模式 + 思考等级（选中集
    → thinkingLevelMap，留空 = 跟随端点默认）。id 命中目录时自动预填其余字段；
    保存经 onSave 上抛，由调用方写回 provider 定义 */
export function ModelDialog({
  open,
  onClose,
  initial,
  catalog,
  onSave,
}: {
  open: boolean
  onClose: () => void
  /** 编辑态传既有定义（区分"改 id"），新增传 null */
  initial: ModelDef | null
  /** 目录模型按 id 查（智能预填数据源；无目录传空表） */
  catalog: Map<string, ModelSummary>
  onSave: (def: ModelDef, originalId: string | null) => void
}) {
  const [id, setId] = useState('')
  const [context, setContext] = useState(131072)
  const [maxTokens, setMaxTokens] = useState('')
  const [imageInput, setImageInput] = useState(false)
  const [reasoning, setReasoning] = useState(false)
  const [thinkingLevels, setThinkingLevels] = useState<ThinkingLevel[]>([])
  // 高级面（完备化 R1/R7）：压缩参数 + 思考预算，文本输入 → 保存时解析，
  // 空串 = 不覆盖（走引擎默认 / pi 内建预算表）
  const [compactionRatio, setCompactionRatio] = useState('')
  const [compactionRoom, setCompactionRoom] = useState('')
  const [budgets, setBudgets] = useState<Record<'minimal' | 'low' | 'medium' | 'high', string>>({
    minimal: '',
    low: '',
    medium: '',
    high: ''
  })

  // 当前 id 的目录命中（编辑/新增通用，改 id 实时跟随）：默认模型锁定的判定源
  const catalogHit = catalog.get(id.trim())
  // 编辑默认（目录原生）模型时 id 只读：id 是目录身份与覆盖匹配键，改 id 等于
  // 把"删目录模型 + 新增自定义模型"伪装成一次编辑（语义混乱），要新 id 走
  // 「添加模型」。目录命中且 userDefined !== true = 目录原生；用户添加的模型
  // （含全部自定义供应商条目）不锁 —— id 输什么是什么，调不调得通用户自负责
  const lockId = initial !== null && catalogHit !== undefined && catalogHit.userDefined !== true

  // 每次打开重置表单（initial 区分新增/编辑；目录精确值原样带入，拖动滑杆才吸附）
  useEffect(() => {
    if (!open) return
    setId(initial?.id ?? '')
    setContext(initial?.contextWindow ?? 200000)
    setMaxTokens(initial?.maxTokens !== undefined ? String(initial.maxTokens) : '')
    setImageInput(initial?.input?.includes('image') === true)
    setReasoning(initial?.reasoning === true)
    setThinkingLevels(initial?.thinkingLevels ?? [])
    setCompactionRatio(initial?.compaction?.thresholdRatio !== undefined ? String(initial.compaction.thresholdRatio) : '')
    setCompactionRoom(initial?.compaction?.roomFloorTokens !== undefined ? String(initial.compaction.roomFloorTokens) : '')
    setBudgets({
      minimal: initial?.thinkingBudgets?.minimal !== undefined ? String(initial.thinkingBudgets.minimal) : '',
      low: initial?.thinkingBudgets?.low !== undefined ? String(initial.thinkingBudgets.low) : '',
      medium: initial?.thinkingBudgets?.medium !== undefined ? String(initial.thinkingBudgets.medium) : '',
      high: initial?.thinkingBudgets?.high !== undefined ? String(initial.thinkingBudgets.high) : ''
    })
  }, [open, initial])

  // 智能预填：新增态下 id 命中目录 → 用目录元数据补齐（编辑态不动已有值）。
  // 目录 ModelSummary 不含输入模态/思考等级，图片与等级保持默认
  const prefillFromCatalog = (modelId: string): void => {
    if (initial) return
    const hit = catalog.get(modelId.trim())
    if (!hit) return
    setContext(hit.contextWindow)
    setMaxTokens(String(hit.maxTokens))
    setReasoning(hit.reasoning)
  }

  const save = (): void => {
    const trimmed = id.trim()
    if (!trimmed) return
    const parseCount = (raw: string): number | undefined => {
      const n = Number(raw)
      return raw.trim().length > 0 && Number.isFinite(n) && n > 0 ? n : undefined
    }
    const maxTokensValue = parseCount(maxTokens)
    // 高级面解析：空 = 不覆盖。压缩占比额外夹 (0,1]（越界值按缺省处理，不静默
    // 存脏 —— 引擎公式对 0 或负占比无意义）
    const ratioValue = parseCount(compactionRatio)
    const ratio = ratioValue !== undefined && ratioValue <= 1 ? ratioValue : undefined
    const roomValue = parseCount(compactionRoom)
    const budgetEntries = (Object.entries(budgets) as Array<['minimal' | 'low' | 'medium' | 'high', string]>)
      .map(([level, raw]) => [level, parseCount(raw)] as const)
      .filter(([, n]) => n !== undefined)
    const budgetOverride: ThinkingBudgetsOverride = Object.fromEntries(budgetEntries)
    onSave(
      {
        id: trimmed,
        contextWindow: context,
        ...(maxTokensValue !== undefined && { maxTokens: maxTokensValue }),
        // 文本恒含；仅当勾了图片才落 input（['text'] 是引擎默认值，不必写）
        ...(imageInput && { input: ['text', 'image'] as Array<'text' | 'image'> }),
        ...(reasoning && { reasoning: true }),
        ...(reasoning && thinkingLevels.length > 0 && { thinkingLevels }),
        ...((ratio !== undefined || roomValue !== undefined) && {
          compaction: {
            ...(ratio !== undefined && { thresholdRatio: ratio }),
            ...(roomValue !== undefined && { roomFloorTokens: roomValue })
          }
        }),
        ...(Object.keys(budgetOverride).length > 0 && { thinkingBudgets: budgetOverride })
      },
      initial?.id ?? null
    )
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      {/* initialFocus=false：关掉 base-ui"自动聚焦第一个可聚焦元素"的默认行为；
          sm:max-w-lg 同变体反制 DialogContent 自带的 sm:max-w-md（裸 max-w-lg 压不住） */}
      <DialogContent className="sm:max-w-lg" initialFocus={false}>
        <DialogHeader>
          <DialogTitle>{initial ? '编辑模型' : '添加模型'}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div>
            {/* 字段如实标"模型 ID"：id 是发给端点的请求体 model 值，也是覆盖
                匹配键；显示层一律用 id（2026-11-10 定调，name 不参与呈现） */}
            <label className={FIELD_LABEL}>模型 ID</label>
            <Input
              value={id}
              onChange={(event) => setId(event.target.value)}
              onBlur={() => prefillFromCatalog(id)}
              placeholder="如 deepseek-chat"
              className="mt-1.5 rounded-lg text-[13px]"
              autoComplete="off"
              disabled={lockId}
            />
            {lockId && (
              <p className="mt-1.5 text-xs text-muted-foreground">
                默认模型不可修改 ID，仅调整配置；需要其他 ID 请用「添加模型」
              </p>
            )}
          </div>
          <div>
            <div className="flex items-center justify-between">
              <label className={FIELD_LABEL}>上下文窗口</label>
              <span className="text-xs text-muted-foreground">{formatContext(context)}</span>
            </div>
            <div className="mt-1.5">
              <ContextWindowSlider value={context} onChange={setContext} />
            </div>
          </div>
          <div>
            <label className={FIELD_LABEL}>最大输出 Token</label>
            <Input
              value={maxTokens}
              onChange={(event) => setMaxTokens(event.target.value)}
              placeholder="如 8192"
              inputMode="numeric"
              className="mt-1.5 rounded-lg text-[13px]"
              autoComplete="off"
            />
          </div>
          <div>
            <label className={FIELD_LABEL}>输入类型</label>
            <div className="mt-1.5 flex gap-2">
              {/* 文本恒选（聊天模型的前提，不可取消）；图片可开关 */}
              <Toggle variant="outline" size="sm" pressed disabled className={cn(CHIP_BASE, 'gap-1.5', CHIP_PRESSED)}>
                <IconCheck className="size-3.5" />
                文本
              </Toggle>
              <Toggle
                variant="outline"
                size="sm"
                pressed={imageInput}
                onPressedChange={setImageInput}
                className={cn(CHIP_BASE, 'gap-1.5', CHIP_PRESSED, !imageInput && 'text-muted-foreground')}
              >
                {imageInput && <IconCheck className="size-3.5" />}
                图片
              </Toggle>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <label className={FIELD_LABEL}>思考模式</label>
            <Switch checked={reasoning} onCheckedChange={setReasoning} aria-label="思考模式" />
          </div>
          {reasoning && (
            <div>
              <label className={FIELD_LABEL}>思考等级</label>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {THINKING_LEVELS.map((level) => (
                  <Toggle
                    key={level.id}
                    variant="outline"
                    size="sm"
                    title={level.id}
                    pressed={thinkingLevels.includes(level.id)}
                    onPressedChange={(on) =>
                      setThinkingLevels((levels) =>
                        on ? [...levels, level.id] : levels.filter((l) => l !== level.id)
                      )
                    }
                    className={cn(CHIP_BASE, CHIP_PRESSED)}
                  >
                    {level.label}
                  </Toggle>
                ))}
              </div>
            </div>
          )}
          {/* 高级折叠（完备化 R1/R7）：压缩参数 + 思考预算 —— 懂端点/懂窗口的
              用户面，默认收起；空 = 不覆盖（引擎默认 0.9/8192、pi 内建预算表） */}
          <Collapsible>
            <CollapsibleTrigger
              className={
                '-ml-2 flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted-foreground ' +
                'hover:bg-accent-foreground/5 hover:text-foreground'
              }
            >
              <IconChevronDown className="size-3.5 transition-transform duration-200 [[data-state=closed]_&]:rotate-180" aria-hidden="true" />
              高级（压缩参数{reasoning ? ' / 思考预算' : ''}）
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-2 flex flex-col gap-3 border-t pt-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={FIELD_LABEL}>压缩触发占比</label>
                    <Input
                      value={compactionRatio}
                      onChange={(event) => setCompactionRatio(event.target.value)}
                      placeholder="默认 0.9"
                      inputMode="decimal"
                      className="mt-1.5 rounded-lg text-[13px]"
                      autoComplete="off"
                    />
                  </div>
                  <div>
                    <label className={FIELD_LABEL}>余量下限（token）</label>
                    <Input
                      value={compactionRoom}
                      onChange={(event) => setCompactionRoom(event.target.value)}
                      placeholder="默认 8192"
                      inputMode="numeric"
                      className="mt-1.5 rounded-lg text-[13px]"
                      autoComplete="off"
                    />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  触发线 = max(半窗兜底, min(占比, 窗口−余量))；小窗口模型可调低让压缩更早发生
                </p>
                {reasoning && (
                  <div>
                    <label className={FIELD_LABEL}>思考预算（token，按档位）</label>
                    <div className="mt-1.5 grid grid-cols-4 gap-2">
                      {(['minimal', 'low', 'medium', 'high'] as const).map((level) => (
                        <div key={level}>
                          <Input
                            value={budgets[level]}
                            onChange={(event) => setBudgets((b) => ({ ...b, [level]: event.target.value }))}
                            placeholder={BUDGET_PLACEHOLDER[level]}
                            inputMode="numeric"
                            className="rounded-lg text-[13px]"
                            autoComplete="off"
                          />
                          <p className="mt-1 text-center text-xs text-muted-foreground">
                            {BUDGET_LABEL[level]}
                          </p>
                        </div>
                      ))}
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      推理模型的思考硬上限（空 = 引擎内建表）；预算随档位下发并夹到输出余量，防小窗被思考吃光。极高/最大档按「高」计
                    </p>
                  </div>
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button onClick={save}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
