/**
 * 上下文窗口指示器（content-main 首页会话视图 → 底部输入卡工具行，模型下拉
 * 左侧）：架构位置 = ChatComposer 工具行的常驻只读仪表；职责边界 = 从 chat
 * store 聚合会话 usage 得占用量、从 engine store 取活动模型的 contextWindow
 * 做分母，纯展示（横条 + 百分比 + 点击悬浮卡），不发起任何写操作；分类明细
 * 与压缩预警线已随批次 4 落地（完备化 R1 起刻度 = 引擎随目录下发的有效触发
 * 占比，小窗模型前移），压缩回落 =
 * 分子切压缩条 tokensAfter（估算口径带 ≈，见下方 useMemo 注释）。
 * formatTokens 在此导出：HomeChat 的 UsageLine（消息用量行）同需 token 紧凑
 * 格式，单一实现避免两处口径漂移。
 */
import { useMemo } from 'react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useChatStore, selectCompacting } from '@/stores/chat'
import type { MessageItem } from '@/stores/chat'
import { findActiveModel, useEngineStore } from '@/stores/engine'
import type { HomeSession } from '@/stores/home'
import type { MessageUsage } from '@/env.d'

/** token 数紧凑格式：1234 → 1.2K、1.05M；千以下原样（tabular-nums 保证列对齐） */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1e6) return `${parseFloat((n / 1000).toFixed(1))}K`
  return `${parseFloat((n / 1e6).toFixed(2))}M`
}

/** 非聊天视图（新聊天）时的稳定空回退：selector 返回 undefined，若在组件体内
    写 `?? []` 字面量，每次渲染新建数组 → 下方 usage 聚合的 useMemo 全程失效
    逐帧重算。模块级常量让引用恒定（同 HomeChat 里 ChatMessages 的先例） */
// 消息联合（含工具卡行）：usage 扫描经 type 判别跳过工具行（见下方 useMemo）
const EMPTY_MESSAGES: MessageItem[] = []

/** 明细点色灰黑阶（模块级常量同 EMPTY_MESSAGES 的稳定性考量）：行序 = 占比
    降序，最深给最大段；三档对半递减保证 6px 小点上仍可分辨 */
const DOT_TONES = ['bg-foreground', 'bg-foreground/50', 'bg-foreground/25']

/**
 * 自动压缩触发线的回落值（完备化 R1 后真值随模型目录下发：ModelSummary
 * .compactionThresholdRatio，引擎按 model.compaction 覆盖与窗口解出）——
 * 仅老目录无字段时兜底 0.9。小窗模型触发线显著前移（20K 窗 ≈59%），
 * 常量镜像已废。
 */
const COMPACT_THRESHOLD_FALLBACK = 0.9

/** 明细单行：色点 + 名称 + token 数 + 占比。tokens 已按实报总量缩放（见
    breakdown）：缩放是浮点乘法，<1K 时按两位小数定长显示（K/M 走 formatTokens
    自带规格）；占比列固定 w-12 右对齐（对齐 ZCode /context）。点色 = 灰黑
    色阶随行序变浅（对标 ZCode /context 蓝色色阶的"越大越深"编码，2026-11-11
    用户定调换灰黑系：foreground 透明度阶梯即项目灰阶，不引调色板外的色；
    透明度只落在背景，合 UI 方针 3） */
function EstimateRow({
  label,
  tokens,
  pct,
  dot
}: {
  label: string
  tokens: number
  pct: number
  dot: string
}) {
  return (
    <div className="flex items-center gap-2">
      <span className={cn('size-1.5 shrink-0 rounded-full', dot)} aria-hidden="true" />
      <span className="text-xs">{label}</span>
      <span className="ml-auto text-xs text-muted-foreground tabular-nums">
        {tokens < 1000 ? tokens.toFixed(2) : formatTokens(tokens)}
      </span>
      <span className="w-12 text-right text-xs tabular-nums">{pct.toFixed(1)}%</span>
    </div>
  )
}

/** 横条本体：斜纹轨道（用户参照稿图1；透明度只落在背景，合 UI 方针 3）+ 实色填充 +
 *  可选预警线（批次 4：90% 自动压缩线，越过即下一条消息前触发压缩） */
function ContextBar({
  pct,
  tone,
  className,
  warnAt
}: {
  pct: number
  tone: string
  className?: string
  /** 预警线位置（0–1）；缺省不画 */
  warnAt?: number
}) {
  return (
    <span className={cn('relative block overflow-hidden rounded-full bg-muted', className)}>
      <span className="absolute inset-0 bg-[repeating-linear-gradient(45deg,transparent_0_3px,var(--color-border)_3px_4px)]" />
      <span
        className={cn('absolute inset-y-0 left-0 rounded-full transition-[width] duration-300', tone)}
        style={{ width: `${pct * 100}%` }}
      />
      {/* 压缩触发线：1px 实色刻度（背景层之上、填充层之下 —— 填充越线即"压过去"的视觉） */}
      {warnAt !== undefined && warnAt > 0 && warnAt < 1 && (
        <span
          className="absolute inset-y-0 w-px bg-foreground/25"
          style={{ left: `${warnAt * 100}%` }}
          aria-hidden="true"
        />
      )}
    </span>
  )
}

/**
 * 上下文窗口指示器（输入卡工具行，模型下拉左侧）+ 点击悬浮卡（用户参照稿图2
 * 骨架：标题/进度条/缓存命中率）。口径：占用 = 末条带 usage 的 assistant 消息
 * input+cacheRead+cacheWrite+output —— pi 每轮全量重发上下文，三项和即该轮
 * 实发量，加 output 为"下一轮将重发"；与 Claude Code status 同源（末轮端点
 * 实报而非实时计数，流式中保持上一轮值）。分母 = 活动模型 contextWindow
 * （不上网络的客户端元数据；自定义模型缺省 128K 偏保守 → 百分比偏高不偏低）。
 * 压缩回落（批次 4）：压缩条（role 'compaction'）比末条 usage 新 → 分子切
 * 压缩后 tokensAfter 估算（≈ 标记），下一条回复落成新 usage 切回实报。
 * MCP 工具/技能段明细待各自模块（主流对照见 技术笔记/token-usage.md §6）。
 */
export function ContextIndicator({ session }: { session: HomeSession }) {
  const messages =
    useChatStore((s) => (session.kind === 'chat' ? s.messagesBySession[session.chatId] : undefined)) ?? EMPTY_MESSAGES
  // 分母模型与 ModelMenu 同源（findActiveModel 双键）：同名模型跨 provider 收录时
  // id 单键命中错家 —— 未配 key 的收录家、或都配了 key 时目录在前的那家（后者
  // 上下文窗口大小还可能与自定义网关的那份不同，分母就错了）
  const activeModel = useEngineStore((s) =>
    findActiveModel(s.models, s.keyConfigured, s.activeModelId, s.activeProviderId)
  )
  const contextWindow = activeModel?.contextWindow ?? 0
  // 有效压缩触发占比（完备化 R1）：引擎随目录下发，预警线/变色带/说明行三处
  // 共用；老目录无字段回落 0.9
  const compactThreshold = activeModel?.compactionThresholdRatio ?? COMPACT_THRESHOLD_FALLBACK
  // 压缩进行中（完备化 D8）：手动入口的禁用位（会话级护栏，引擎侧另有一道）
  const compacting = useChatStore(selectCompacting)

  const { used, cacheHit, estimate, approximate } = useMemo(() => {
    let usage: MessageUsage | undefined
    let usageAt = 0
    let cacheRead = 0
    let cacheDen = 0
    // 从后往前扫：首条命中即"末条已完成回答"的 usage（流式中末条还没有 usage）；
    // 命中率顺路全会话聚合，分母 = input（未命中部分）+ cacheRead（命中部分）。
    // 工具卡行没有 usage，先判别跳过（消息联合见 stores/chat MessageItem）
    for (let i = messages.length - 1; i >= 0; i--) {
      const item = messages[i]
      if (item.type !== undefined) continue
      const u = item.usage
      if (!u) continue
      if (!usage) {
        usage = u
        usageAt = item.timestamp
      }
      cacheRead += u.cacheRead
      cacheDen += u.input + u.cacheRead
    }
    // 压缩回落（批次 4）：压缩条比末条 usage 新 = usage 还是压缩前的旧账（引擎侧
    // 同款守卫，pi-ai estimate 按时间戳判 usage 失效）→ 分子切压缩后估算
    // tokensAfter（估算口径，approximate 标记），明细三段随之作废不显示；
    // 下一答落成新 usage 后自然切回实报
    let compactionAfter: number | undefined
    let compactionAt = 0
    for (let i = messages.length - 1; i >= 0; i--) {
      const item = messages[i]
      if (item.type === undefined && item.role === 'compaction') {
        compactionAfter = item.compaction?.tokensAfter
        compactionAt = item.timestamp
        break
      }
    }
    const overridden =
      compactionAfter !== undefined && compactionAt > usageAt ? compactionAfter : undefined
    return {
      used:
        overridden ??
        (usage ? usage.input + usage.cacheRead + usage.cacheWrite + usage.output : 0),
      approximate: overridden !== undefined,
      // 端点不报缓存的模型 cacheRead 恒 0，"0%" 是误导 → 不显示（零值省略同 UsageLine）
      cacheHit: cacheRead > 0 && cacheDen > 0 ? cacheRead / cacheDen : undefined,
      // 明细三段（引擎粗估，随末轮 usage 落盘流转）；旧会话/引擎未算/压缩回落时
      // undefined，明细区整块不渲染（不硬造占位行）
      estimate: overridden !== undefined ? undefined : usage?.contextEstimate
    }
  }, [messages])

  const pct = contextWindow > 0 ? Math.min(used / contextWindow, 1) : 0
  // 两位小数：低占用时整数百分比信息量不足（6% 与 6.25% 是两回事）；>0 却四舍
  // 五入到 0.00 的极小占用显示 <0.01%，避免 "0.00%" 的尴尬假 0（used===0 已在
  // 下方整体不渲染，这里 pct 恒 >0）。压缩回落的分子是估算 → ≈ 前缀（实报
  // 才免标，同成本项口径）
  const pctNum = pct * 100
  const pctLabel = `${approximate ? '≈' : ''}${pctNum < 0.005 ? '<0.01' : pctNum.toFixed(2)}`
  // 三档变色只落在 bar（文字恒实色 muted）；预警带锚定有效触发线（前 0.15 起
  // 警、越线转红）—— 90% 线时与原 75/90 档一致，小窗线前移后配色跟着走，
  // 避免"线早越过了横条还黑着"
  const tone =
    pct >= compactThreshold ? 'bg-destructive' : pct >= compactThreshold - 0.15 ? 'bg-warning' : 'bg-foreground'

  // 没有对话（首答前无实报数据）整个指示器不渲染：0% 横条 + 空态悬浮卡都是
  // 噪音（用户定调），首答产出 usage 后自然出现
  if (used === 0) return null

  // 明细三段按实报总量缩放：原始估算（3.5 chars/token）对中文/JSON 系统性
  // 偏低（实测中文会话三段估算 ≈ 实报一半），直接展示会出现"三段之和 ≠ 顶部
  // 总量"的打架。修法 = 总量实报、拆分估算：按各段估算占比分摊 used，
  // 三段 token 和 === used、占比和 === 100%（估算只决定"怎么分"，不决定
  // "有多少"）。注意缩放基数是三段之和而非 estimate.total —— pi 的 total
  // 是"末轮实报 usage + trailing"锚出来的（≈ used），与三段字符估算之和
  // （520 vs 997）是两回事，拿它当基数 scale 恒 ≈1 等于没缩放
  const estSum = estimate ? estimate.systemPrompt + estimate.toolDefs + estimate.messages : 0
  const scale = estSum > 0 ? used / estSum : 0
  // 行序对标 ZCode /context：按占比降序 + 点色随行序变浅（"越大越深"的冗余
  // 编码）。三段名次随会话生长互换属正常（工具声明固定、消息段会涨），行
  // 重排只是位置对调，键仍用 label 不闪内容
  const breakdown = estimate
    ? [
        { label: '系统提示词', tokens: estimate.systemPrompt * scale },
        { label: '系统工具', tokens: estimate.toolDefs * scale },
        { label: '消息', tokens: estimate.messages * scale }
      ]
        .map((r) => ({ ...r, pct: (r.tokens / used) * 100 }))
        .sort((a, b) => b.tokens - a.tokens)
        .map((r, i) => ({ ...r, dot: DOT_TONES[i] }))
    : undefined

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="gap-1.5 rounded-xl px-2 text-muted-foreground hover:bg-accent-foreground/5 hover:text-foreground"
            aria-label="上下文窗口用量"
          />
        }
      >
        <ContextBar pct={pct} tone={tone} warnAt={compactThreshold} className="h-1.5 w-20" />
        <span className="text-xs tabular-nums">{pctLabel}%</span>
      </PopoverTrigger>
      {/* 全卡字号与间距（2026-11-11 用户多轮定调收敛）：标题 13px semibold、
          明细/缓存行 12px、右上数值 11px；卡内 p-3.5；进度条 → 明细**无分割线**
          仅 mt-4 留白分组（用户定调去掉）；明细行距 gap-2；仅缓存行前保留
          分割线且上下收紧 mt-3/pt-3 */}
      <PopoverContent align="end" sideOffset={8} className="w-64 gap-0 rounded-2xl p-3.5">
        <div className="flex items-baseline justify-between">
          <span className="text-[13px] font-semibold">上下文容量</span>
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {approximate ? '≈' : ''}{formatTokens(used)}/{formatTokens(contextWindow)}（{pctLabel}%）
          </span>
        </div>
        <ContextBar pct={pct} tone={tone} warnAt={compactThreshold} className="mt-4 h-1.5" />
        {/* 明细区（对照 ZCode /context 三段可算项；MCP 工具/技能待各自模块，
            无"其他"兜底段）。口径 = 总量实报、拆分估算：顶部数字是端点实报，
            三段按估算占比缩放到该总量，加起来能对上。原"≈ 分类明细"头行
            2026-11-11 按用户要求去掉 —— 估算语义记在 token-usage.md §6.1，
            UI 不再重复占一行 */}
        {breakdown && (
          <div className="mt-4 flex flex-col gap-2">
            {breakdown.map((r) => (
              <EstimateRow key={r.label} label={r.label} tokens={r.tokens} pct={r.pct} dot={r.dot} />
            ))}
          </div>
        )}
        {cacheHit !== undefined && (
          <div className="mt-3 flex items-center justify-between border-t pt-3">
            <span className="text-xs">平均缓存命中率</span>
            <span className="text-xs font-semibold tabular-nums">
              {parseFloat((cacheHit * 100).toFixed(1))}%
            </span>
          </div>
        )}
        {/* 压缩说明行（批次 4）：解释横条刻度的含义 —— 越线后下一条消息前自动
            压缩，回落动画即压缩产物（分子切 tokensAfter 估算）。百分比 = 有效
            触发线（完备化 R1 随模型下发，小窗前移），四舍五入整显 */}
        <div className="mt-3 flex items-center gap-1.5 border-t pt-3 text-xs text-muted-foreground">
          <span className="h-1.5 w-px bg-foreground/40" aria-hidden="true" />
          越过 {Math.round(compactThreshold * 100)}% 自动压缩上下文
        </div>
        {/* 手动压缩入口（完备化 D8）：session.compact 已通协议（批次 4），此处补
            UI 面 —— 无可压缩（刚压过/内容不足）引擎报错落 chat store 错误条；
            压缩中按钮禁用（会话级护栏引擎侧也有） */}
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 w-full justify-center rounded-lg text-xs text-muted-foreground hover:bg-accent-foreground/5 hover:text-foreground"
          disabled={compacting}
          onClick={() => void useChatStore.getState().compactNow()}
        >
          {compacting ? '压缩中…' : '立即压缩上下文'}
        </Button>
      </PopoverContent>
    </Popover>
  )
}
