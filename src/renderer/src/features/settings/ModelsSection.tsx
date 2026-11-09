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
 * 思考模式 / 思考等级；id 命中目录自动预填）。
 * 保存语义：每次修改即时全量保存（saveProviders：落盘 + 引擎 sync + 目录重拉），
 *   文本输入失焦提交；key 走 credentials 域单独通道 —— 写 setApiKey / 读
 *   getApiKey（全量回显），状态位走 listApiKeys。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  IconCheck,
  IconChevronDown,
  IconDots,
  IconEye,
  IconEyeOff,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconTrash,
} from '@tabler/icons-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
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
import { ProviderLogo } from '@/components/ProviderLogo'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useEngineStore } from '@/stores/engine'
import type {
  CustomProviderDef,
  ModelDef,
  ModelSummary,
  ProviderOverrideDef,
  ThinkingLevel,
} from '@/env.d'

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

/** API 方言两档（协议 CustomProviderDef.apiFormat 的 UI 侧文案） */
const API_FORMATS = [
  { value: 'openai-completions', label: 'OpenAI Chat Completions (/v1/chat/completions)' },
  { value: 'anthropic-messages', label: 'Anthropic Messages (/v1/messages)' },
] as const

const FIELD_LABEL = 'text-[13px]'
const FIELD_GAP = 'mt-5'

/** 列表行/徽标共用配方（行容器 divide-y 分隔，圆角由外层容器裁） */
const BADGE = 'rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground'

/** 上下文窗口徽标文案：200000 → 200K，1048576 → 1M */
function formatContext(tokens: number): string {
  return tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(1))}M` : `${Math.floor(tokens / 1000)}K`
}

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

/** 上下文窗口滑杆档位：只认 200K / 400K / 1M 三档（线性轴 0~1M，1M 顶格对标参考稿） */
const CONTEXT_STOPS = [200000, 400000, 1048576] as const
const CONTEXT_MIN = CONTEXT_STOPS[0]
const CONTEXT_MAX = CONTEXT_STOPS[CONTEXT_STOPS.length - 1]
/** 均匀小刻度数量（纯装饰） */
const CONTEXT_TICKS = 25

/** 上下文窗口滑杆（对标参考稿）：线性轴 0~1M，三档 200K/400K/1M（落在 20%/
    40%/100%），滑块只在档位间停留 + 移动动画。值不在档位上时（目录精确值）
    滑块显示最近档位，但只在用户真正拖动后才改写数值 —— 不静默篡改目录值；
    键盘 ←→ 在档位间移动；选中档位的刻度/标签变色 */
function ContextWindowSlider({
  value,
  onChange,
}: {
  value: number
  onChange: (v: number) => void
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)

  const nearestStop = (tokens: number): (typeof CONTEXT_STOPS)[number] =>
    CONTEXT_STOPS.reduce((best, stop) => (Math.abs(stop - tokens) < Math.abs(best - tokens) ? stop : best))
  const activeStop = nearestStop(value)
  // 滑块位置 = 所在档位的线性位置（200K/400K/1M → 20%/40%/100%）
  const pos = activeStop / CONTEXT_MAX

  const pickFromClientX = (clientX: number): void => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect) return
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    onChange(nearestStop(ratio * CONTEXT_MAX))
  }

  return (
    <div>
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="上下文窗口"
        aria-valuemin={CONTEXT_MIN}
        aria-valuemax={CONTEXT_MAX}
        aria-valuenow={value}
        aria-valuetext={formatContext(value)}
        onKeyDown={(event) => {
          const index = CONTEXT_STOPS.indexOf(nearestStop(value))
          if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
            event.preventDefault()
            onChange(CONTEXT_STOPS[Math.min(index + 1, CONTEXT_STOPS.length - 1)])
          } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
            event.preventDefault()
            onChange(CONTEXT_STOPS[Math.max(index - 1, 0)])
          }
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          setDragging(true)
          pickFromClientX(event.clientX)
        }}
        onPointerMove={(event) => dragging && pickFromClientX(event.clientX)}
        onPointerUp={(event) => {
          setDragging(false)
          event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        className="relative h-5 cursor-pointer touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-offset-2"
      >
        {/* 轨道 + 已填充段 + 滑块（拖动中关闭过渡跟手，松手/键盘步进带动画） */}
        <div className="absolute top-1/2 h-2 w-full -translate-y-1/2 rounded-full bg-muted" />
        <div
          className={cn(
            'absolute top-1/2 h-2 -translate-y-1/2 rounded-full bg-foreground/20',
            !dragging && 'transition-[width] duration-200'
          )}
          style={{ width: `${pos * 100}%` }}
        />
        <div
          className={cn(
            'absolute top-1/2 h-4 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/45 transition-colors',
            !dragging && 'transition-[left,color] duration-200',
            dragging && 'bg-foreground/65'
          )}
          style={{ left: `${pos * 100}%` }}
        />
      </div>
      {/* 均匀小刻度（装饰）+ 三档刻度/标签（选中的那档变色） */}
      <div className="relative mt-0.5 h-7">
        {Array.from({ length: CONTEXT_TICKS }, (_, i) => (
          <span
            key={i}
            className="absolute top-0 h-1.5 w-px bg-border"
            style={{ left: `${(i / (CONTEXT_TICKS - 1)) * 100}%` }}
          />
        ))}
        {CONTEXT_STOPS.map((stop) => {
          const selected = activeStop === stop
          return (
            <div
              key={stop}
              className="absolute top-0 flex -translate-x-1/2 flex-col items-center"
              style={{ left: `${(stop / CONTEXT_MAX) * 100}%` }}
            >
              <span
                className={cn(
                  'h-2 w-0.5 transition-colors duration-200',
                  selected ? 'bg-foreground' : 'bg-border'
                )}
              />
              <span
                className={cn(
                  'pt-1.5 text-[10px] leading-none transition-colors duration-200',
                  selected ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                {formatContext(stop)}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

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

/** 对话框 chip 统一配方：13px 中文 400 字重（小号中文禁 500，组件默认 500 要压掉）
    + 选中黑 10% 软叠（三组 chip 同款） */
const CHIP_BASE = 'text-[13px] font-normal'
const CHIP_PRESSED = 'aria-pressed:bg-foreground/10 aria-pressed:text-foreground'

/** 添加/编辑模型对话框（扁平字段）：模型 ID / 上下文窗口（滑杆）/ 最大输出
    Token / 输入类型（pi 仅支持 文本|图片 两态）/ 思考模式 + 思考等级（选中集
    → thinkingLevelMap，留空 = 跟随端点默认）。id 命中目录时自动预填其余字段；
    保存经 onSave 上抛，由调用方写回 provider 定义 */
function ModelDialog({
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

  // 每次打开重置表单（initial 区分新增/编辑；目录精确值原样带入，拖动滑杆才吸附）
  useEffect(() => {
    if (!open) return
    setId(initial?.id ?? '')
    setContext(initial?.contextWindow ?? 200000)
    setMaxTokens(initial?.maxTokens !== undefined ? String(initial.maxTokens) : '')
    setImageInput(initial?.input?.includes('image') === true)
    setReasoning(initial?.reasoning === true)
    setThinkingLevels(initial?.thinkingLevels ?? [])
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
    onSave(
      {
        id: trimmed,
        contextWindow: context,
        ...(maxTokensValue !== undefined && { maxTokens: maxTokensValue }),
        // 文本恒含；仅当勾了图片才落 input（['text'] 是引擎默认值，不必写）
        ...(imageInput && { input: ['text', 'image'] as Array<'text' | 'image'> }),
        ...(reasoning && { reasoning: true }),
        ...(reasoning && thinkingLevels.length > 0 && { thinkingLevels })
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
            <label className={FIELD_LABEL}>模型名称</label>
            <Input
              value={id}
              onChange={(event) => setId(event.target.value)}
              onBlur={() => prefillFromCatalog(id)}
              placeholder="如 deepseek-chat"
              className="mt-1.5 rounded-lg text-[13px]"
              autoComplete="off"
            />
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

/** API Key 字段：全量回显存量 key（挂载即经 credentials:get 拉入），默认密文态、
    点眼睛看明文 —— 眼睛钮 mousedown 不抢焦点，查看不打断输入。失焦/Enter 提交
    有变化的值，清空后提交 = 写空串 = 清除（credentials 链路 has() 按非空判定） */
function ApiKeyField({ providerId }: { providerId: string }) {
  const [value, setValue] = useState('')
  const [committed, setCommitted] = useState('')
  const [show, setShow] = useState(false)
  const refreshKeys = useEngineStore((s) => s.refreshKeys)

  useEffect(() => {
    void window.cogent.getApiKey(providerId).then((apiKey) => {
      setValue(apiKey)
      setCommitted(apiKey)
    })
  }, [providerId])

  const commit = async () => {
    const key = value.trim()
    if (key === committed) return
    await window.cogent.setApiKey(providerId, key)
    setCommitted(key)
    await refreshKeys()
  }

  return (
    <div className={FIELD_GAP}>
      <label className={FIELD_LABEL}>API Key</label>
      <div className="relative mt-1.5">
        <Input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(event) => event.key === 'Enter' && void commit()}
          placeholder="输入 API Key"
          className="rounded-lg pr-9 text-[13px]"
          autoComplete="off"
        />
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setShow((v) => !v)}
          aria-label={show ? '隐藏 Key' : '显示 Key'}
          className="absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          {show ? <IconEyeOff className="size-4" /> : <IconEye className="size-4" />}
        </button>
      </div>
    </div>
  )
}

/** API 格式下拉：方言决定引擎用哪套请求实现，anthropic 时 baseUrl 填根地址
    （SDK 自拼 /v1/messages） */
function FormatSelect({
  value,
  onChange,
}: {
  value: CustomProviderDef['apiFormat']
  onChange: (format: CustomProviderDef['apiFormat']) => void
}) {
  const current = API_FORMATS.find((f) => f.value === (value ?? 'openai-completions'))
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="mt-1.5 h-9 w-full justify-between rounded-lg border border-border px-3 text-[13px] font-normal text-foreground has-[>svg]:px-3 hover:bg-accent-foreground/5"
            aria-label="API 格式"
          />
        }
      >
        {current?.label}
        <IconChevronDown className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-72">
        {API_FORMATS.map((format) => (
          <DropdownMenuItem key={format.value} onClick={() => onChange(format.value)}>
            <span>{format.label}</span>
            {/* 选中项打勾右挂；非选中也占位对齐（菜单项宽度一致） */}
            <span className="ml-auto">
              {current?.value === format.value && <IconCheck className="size-3.5" />}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** 模型行的通用动作簇：hover 显形（占位防跳动）。onDelete 缺省 = 无删除语义
    （未改过的目录模型不能删，只能禁用） */
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
    <div className="ml-auto flex w-13 shrink-0 items-center justify-end gap-0.5 opacity-0 group-hover:opacity-100">
      <Button
        variant="ghost"
        size="icon-xs"
        className="size-6 text-muted-foreground hover:bg-accent-foreground/15 hover:text-foreground"
        aria-label={`编辑模型 ${modelId}`}
        onClick={onEdit}
      >
        <IconPencil className="size-3.5" />
      </Button>
      {onDelete && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="size-6 text-muted-foreground hover:bg-accent-foreground/15 hover:text-foreground"
          aria-label={`删除模型 ${modelId}`}
          onClick={onDelete}
        >
          <IconTrash className="size-3.5" />
        </Button>
      )}
    </div>
  )
}

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

/** 自定义供应商详情。文本输入本地编辑、失焦提交（每次修改即时全量保存，见文件头
    "保存语义"）；模型行 = ModelDef 文本 + hover 动作簇 + 常驻启用开关，增改走对话框 */
function CustomProviderDetail({
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
    return [...defs, ...def.models.filter((id) => !defIds.has(id)).map((id) => ({ id }))]
  }, [def])
  const [dialog, setDialog] = useState<{ initial: ModelDef | null } | null>(null)

  const patch = (partial: Partial<CustomProviderDef>): void => onChange({ ...def, ...partial })
  const disabled = new Set(def.disabledModels ?? [])
  const toggleModel = (modelId: string, on: boolean): void => {
    const next = new Set(disabled)
    if (on) next.delete(modelId)
    else next.add(modelId)
    patch({ disabledModels: [...next] })
  }
  // 保存：id 升级为完整定义（从简写 models 移出，避免双处出现）；改名时旧禁用记录清理
  const saveModel = (model: ModelDef, originalId: string | null): void => {
    patch({
      models: def.models.filter((m) => m !== model.id && m !== originalId),
      modelDefs: [
        ...(def.modelDefs ?? []).filter((d) => d.id !== originalId && d.id !== model.id),
        model
      ],
      disabledModels: (def.disabledModels ?? []).filter((id) => id !== originalId || id === model.id)
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
          <Button
            variant="secondary"
            size="xs"
            className="h-7 gap-0.5 rounded-lg px-2.5 text-xs has-[>svg]:px-2 hover:bg-secondary/80"
            onClick={() => setDialog({ initial: null })}
          >
            <IconPlus className="size-3.5" />
            添加模型
          </Button>
        </div>
        {modelRows.length === 0 ? (
          <p className="mt-2 text-[13px] text-muted-foreground">
            添加端点上可用的模型，配置后才会出现在聊天的模型菜单里。
          </p>
        ) : (
          <div className="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border">
            {modelRows.map((row) => (
              <div key={row.id} className="group flex h-12 min-w-0 items-center gap-2 px-4">
                <span className="min-w-0 shrink truncate text-[13px]">{row.id}</span>
                <ModelBadges def={row} />
                <ModelRowActions
                  modelId={row.id}
                  onEdit={() => setDialog({ initial: row })}
                  onDelete={() => deleteModel(row.id)}
                />
                <Switch
                  checked={!disabled.has(row.id)}
                  onCheckedChange={(on) => toggleModel(row.id, on)}
                  aria-label={`${row.id} 启用`}
                />
              </div>
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

/** 内置供应商详情：模型列表 = pi 目录 ∪ 用户新增（override.models 按同 id 覆盖
    目录值）。目录行可编辑（生成覆盖 = "改配置"）、可禁用（disabledModels）；
    被覆盖行可删除（还原目录值），未动过的目录行只能禁用 */
function BuiltinProviderDetail({
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
  const disabled = new Set(override?.disabledModels ?? [])
  const [dialog, setDialog] = useState<{ initial: ModelDef | null } | null>(null)

  // 合并行：目录（被覆盖项的值取 override.models）+ 目录外新增。
  // 覆盖行以目录名为显示名基底（用户 def 显式 name 优先）：显示名与聊天页
  // 模型菜单统一 —— 此前覆盖行显示 id，同一模型两处名字不同（2026-11-09 统一）
  const merged = useMemo(() => {
    const rows: Array<{ def: ModelDef; shadowed: boolean }> = shown.map((m) => {
      const shadow = customModels.find((x) => x.id === m.id)
      return {
        def: shadow
          ? { name: m.name, ...shadow }
          : { id: m.id, name: m.name, contextWindow: m.contextWindow, reasoning: m.reasoning },
        shadowed: shadow !== undefined
      }
    })
    rows.push(
      ...customModels
        .filter((x) => !catalog.some((m) => m.id === x.id))
        .map((m) => ({ def: m, shadowed: true }))
    )
    return rows
  }, [shown, customModels, catalog])

  // 空调整（无 baseUrl / 无自定义模型 / 无禁用）= 撤掉整条 override 通道
  const commitOverride = (next: ProviderOverrideDef): void => {
    const empty =
      next.baseUrl.length === 0 &&
      (next.models?.length ?? 0) === 0 &&
      (next.disabledModels?.length ?? 0) === 0
    onPatchOverride(providerId, empty ? null : next)
  }

  const toggleModel = (modelId: string, on: boolean): void => {
    const next = new Set(disabled)
    if (on) next.delete(modelId)
    else next.add(modelId)
    commitOverride({
      providerId,
      baseUrl: value,
      models: override?.models,
      disabledModels: [...next]
    })
  }
  // 保存：目录行编辑 → 覆盖（shadow）；改名时旧禁用记录清理
  const saveModel = (model: ModelDef, originalId: string | null): void => {
    commitOverride({
      providerId,
      baseUrl: value,
      models: [...(override?.models ?? []).filter((m) => m.id !== originalId && m.id !== model.id), model],
      disabledModels: (override?.disabledModels ?? []).filter((id) => id !== originalId || id === model.id)
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
          <Button
            variant="secondary"
            size="xs"
            className="h-7 gap-0.5 rounded-lg px-2.5 text-xs has-[>svg]:px-2 hover:bg-secondary/80"
            onClick={() => setDialog({ initial: null })}
          >
            <IconPlus className="size-3.5" />
            添加模型
          </Button>
        </div>
        <div className="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border">
          {merged.map(({ def: row, shadowed }) => (
            <div key={row.id} className="group flex h-12 min-w-0 items-center gap-2 px-4">
              {/* 显示名统一口径（同聊天页模型菜单）：目录名/用户填写的 name 优先，
                  目录外新增的自定义模型无目录名 → 回落 id；id 恒在悬浮提示 */}
              <span
                className="min-w-0 shrink truncate text-[13px]"
                title={row.id}
              >
                {row.name ?? row.id}
              </span>
              <ModelBadges def={row} />
              <ModelRowActions
                modelId={row.id}
                onEdit={() => setDialog({ initial: row })}
                onDelete={shadowed ? () => deleteModel(row.id) : undefined}
              />
              <Switch
                checked={!disabled.has(row.id)}
                onCheckedChange={(on) => toggleModel(row.id, on)}
                aria-label={`${row.id} 启用`}
              />
            </div>
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

export function ModelsSection() {
  const providers = useEngineStore((s) => s.customProviders)
  const overrides = useEngineStore((s) => s.overrides)
  const saveProviders = useEngineStore((s) => s.saveProviders)
  const refreshKeys = useEngineStore((s) => s.refreshKeys)
  const refreshModels = useEngineStore((s) => s.refreshModels)
  const keyConfigured = useEngineStore((s) => s.keyConfigured)

  const [selectedId, setSelectedId] = useState(BUILTIN_PROVIDERS[0].id)

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
