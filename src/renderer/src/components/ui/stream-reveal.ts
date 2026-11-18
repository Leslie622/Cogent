/**
 * 流式正文逐词淡入（docs/技术笔记/流式呈现动效.md，移植自 zcode streaming-markdown-reveal：
 * reference/zcode/packages/ui/src/components/ai-elements/message.tsx:845-1345 与其
 * reference/zcode/docs/streaming-markdown-reveal.md —— 三代前身栽坑的历史教训都记录在彼处）。
 * 手法：rehype 插件把流式 block 的文本切成单元（中日文按字、拉丁文按词）逐个包
 * span，挂 data-reveal="new" + 各自的 transition-delay；CSS 侧（globals.css
 * 「逐词浮现」段）用 transition + @starting-style 淡入，尾部几个单元处于不同
 * 透明度即成渐隐尾巴。
 * 唯一硬约束：DOM 文本从第一帧起完整，只有透明度在变 —— 第二份随时间变长的
 * visibleText 会让高度逐帧增长，撞进 ResizeObserver 与底部跟随（zcode 三代实现
 * 全部撤回的根因）。排期只写延迟，无 rAF / timer。
 * 本文件零 streamdown 依赖（纯 hast 变换 + 纯函数），挂载在 markdown.tsx。
 * 与 zcode 的实现差异：streamdown 2.7 的 block 解析在 render 期 useMemo 同步完成
 * （2.5 走 effect + startTransition），所以 commit 放本帧渲染后的 effect 即可，
 * 每个真实 Block 的 effect 提交本块边界，消息 effect 再提交共享节奏。
 */

/** 跳过的高亮 / 图形 / 结构元素：代码块高亮是异步的，逐字会与高亮结果打架；
    表格的列宽会随流式单元格内容反复重算，把每个 td/th 文字拆成动画 span 已在
    压测中制造上千个过渡对象。本批普通正文改为有界组浮现，代码与表格保持完整
    静态内容，待拿到可靠行身份后再做专门的行级过渡；svg 同理。zcode 还跳过 math
    （rehype-katex 会整个替换公式节点）；Cogent 未装 math 插件，装时在此补上。 */
const REVEAL_SKIP_TAGS = new Set(['pre', 'svg', 'table'])
/** 相邻两个单元开始淡入的最大间隔：吐得慢时按这个节奏逐字出现。 */
const REVEAL_MAX_INTERVAL_MS = 40
/** 最大滞后：任何单元最晚在到达后这么久开始淡入，跨块也不能无限累计延迟。 */
const REVEAL_MAX_LAG_MS = 250
/** 快模型的目标滞后下限：再小就没有缓冲，突发会挤成一块。 */
const REVEAL_MIN_LAG_MS = 80
/** 目标滞后 ≈ 这么多个单元的到达时间；同时不小于相邻两批到达间隔的这么多倍，
    盖住批间空档，不会一批放完停住再来下一批。 */
const REVEAL_LAG_UNITS = 6
const REVEAL_LAG_GAP_FACTOR = 1.5
/** 队列已超过目标滞后时，每批至少铺开这么久，逐步回落，不同时起跳。 */
const REVEAL_MIN_SPREAD_MS = 15
/** 两批到达间隔超过它视为停顿，不更新到达速度（否则停顿把速度估成极慢，
    停顿后突发的整句又被按慢节奏排满）。 */
const REVEAL_PAUSE_MS = 300
const REVEAL_RATE_ALPHA = 0.3
/** 两轮提交挨得太近时，按这个间隔估速，避免瞬时速度虚高。 */
const REVEAL_MIN_GAP_MS = 10
/** 还没有速度参照时，按入口30ms发布窗口估这批单元的到达间隔，首批后由EWMA接管。 */
const REVEAL_FIRST_WINDOW_MS = 30
/** 细粒度逐字/词的上限：超过后按连续文本组浮现。总延迟仍由既有排期器封在
    250ms 起跳窗口 + 300ms opacity 内，因此一批最后一组最迟约 550ms 完全可见。 */
export const REVEAL_FINE_UNIT_LIMIT = 96
/** 单个连续文本片段同时进入 opacity 过渡的新组上限；内联标签会拆出多个片段。组内文字首帧完整占位，
    不靠第二份 visibleText 撑高度；大批只减少动画对象，不延迟业务正文。 */
export const REVEAL_MAX_ANIMATED_GROUPS = 32
/** 大批优先以8ms组间隔铺开；跨块/富文本同时到达时服从250ms上限压缩间隔。 */
export const REVEAL_GROUP_MIN_INTERVAL_MS = 8
/** 同一个 block 的下一版可能改写旧文本末尾的几个字符（尾随空白被裁、remend
 *  补全的标点），允许这么长的尾部分叉；分叉里只能是空白和标点。 */
const REVEAL_TAIL_SLACK_CHARS = 8
/** 字词字符：旧版本分叉的尾巴里出现它，就说明是另一段内容。 */
const REVEAL_WORD_CHAR_RE = /[\p{L}\p{N}]/u
const REVEAL_FALLBACK_WORD_RE = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu
const REVEAL_CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u

/** rehype 树的局部形状：插件只读写这几个字段，不引 hast 类型包 */
interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

/** 逐词插件的 rehype 形状（unified 只要求「返回 transformer 的函数」） */
export type StreamRevealPlugin = () => (tree: HastNode) => void

/** 淡入时长，须与 globals.css 的 --reveal-duration 一致（段间排期接力按
 *  「前段淡入完整结束」对齐下一段首拍；两处漂移只造成观感差，不会错乱）。 */
export const REVEAL_FADE_MS = 300

/** 段间排期接力种子：跨 Markdown 实例（封段后的新旧正文段）共享。新段以
 *  minStart 为初始时钟 —— 首拍不早于前段最后一拍的淡入结束，避免快工具后
 *  「上段渐显未完、下段已开播」的倒序观感；慢路径（工具耗时超过排期尾）
 *  不受影响（start = max(now, clock + interval)）。 */
export interface StreamingRevealPacing {
  minStart: number
}

export function createStreamingRevealPacing(): StreamingRevealPacing {
  return { minStart: Number.NEGATIVE_INFINITY }
}

export interface StreamingRevealState {
  /** 浮现时钟：最后一个已排定单元的开始时间（performance.now 时间线），跨帧接续节奏。 */
  clock: number
  /** 到达速度（单元 / ms）的 EWMA；还没有参照时为 undefined。commit 后更新。 */
  rate: number | undefined
  /** 相邻两轮新单元到达间隔（ms）的 EWMA。 */
  gap: number | undefined
  /** 上一轮新单元到达的时间。 */
  arrival: number
  /** 本轮排期按真实块实例索引；同文块不能合并或删除彼此的候选。 */
  pendingSchedules: Map<symbol, RevealPlan>
  /** 本帧是否是纯追加的 live delta。 */
  incremental: boolean
  /** 原生 parser 的上次提交与本次候选；只观察，不改变分块结果。 */
  committedBlocks: readonly string[]
  pendingBlocks: readonly string[] | undefined
  /** 链接定义/脚注等让旧稳定块重组时，本次重解析直接 settled。 */
  restructured: boolean
  /** 段间排期接力种子（会话级共享；缺省 = 独立渲染，行为不变）。 */
  pacing?: StreamingRevealPacing
}

/** 生命周期跟随真实 BlockComponent；文本只比较本块自己的版本。 */
export interface StreamingRevealBlockState {
  id: symbol
  committed: string
  pending: string | undefined
  /** 文本组在本块渲染文本中的结束偏移，包含纯空白组。 */
  boundaries: readonly number[]
  pendingBoundaries: readonly number[] | undefined
}

interface RevealPlan {
  text: string
  /** 排期时刻，也就是这批单元的到达时间。 */
  now: number
  start: number
  interval: number
  end: number
  count: number
}

export function createStreamingRevealState(pacing?: StreamingRevealPacing | null): StreamingRevealState {
  return {
    clock: pacing?.minStart ?? Number.NEGATIVE_INFINITY,
    rate: undefined,
    gap: undefined,
    arrival: Number.NEGATIVE_INFINITY,
    pendingSchedules: new Map(),
    incremental: false,
    committedBlocks: [],
    pendingBlocks: undefined,
    restructured: false,
    pacing: pacing ?? undefined,
  }
}

export function createStreamingRevealBlockState(): StreamingRevealBlockState {
  return { id: Symbol(), committed: '', pending: undefined, boundaries: [], pendingBoundaries: undefined }
}

/** 只比较原生分块的结构；尾块增长和新段落仍走追加，旧稳定前缀改动则重置视觉边界。 */
export function prepareStreamingRevealBlocks(state: StreamingRevealState, blocks: readonly string[]): void {
  const previous = state.committedBlocks
  const pending = state.pendingBlocks
  // 被丢弃的渲染还没提交；输入换版后清掉它的候选，同版重试仍可复用原排期。
  if (pending !== undefined && (pending.length !== blocks.length || pending.some((text, index) => blocks[index] !== text))) {
    state.pendingSchedules.clear()
  }
  state.restructured = blocks.length < previous.length || previous.slice(0, -1).some((text, index) => blocks[index] !== text)
  state.pendingBlocks = blocks
}

export function commitStreamingRevealBlock(block: StreamingRevealBlockState): void {
  if (block.pending !== undefined) {
    block.committed = block.pending
    block.boundaries = block.pendingBoundaries!
    block.pending = undefined
    block.pendingBoundaries = undefined
  }
}

/** 非前缀变化意味着回填、切会话或模型重写。此时整段按已稳定处理，绝不能按旧
    进度裁剪正文 —— zcode「切回来开头被吞掉」就是这么来的。 */
export function isIncrementalRevealSource(previous: string, next: string): boolean {
  return next.length > previous.length && next.startsWith(previous)
}

/** 新到的普通文本单元分成有限连续组。短批沿用逐字/词：保持用户已经验收的尾巴；
 * 大批只让有限组进入 opacity 过渡，组内文本仍在首帧完整上屏，避免 600+ 时整片
 * settled 或数千个 span 同时过渡。空白挂在相邻实词组里，正文文本守恒。 */
export function groupRevealUnits(units: readonly string[]): string[][] {
  const nonBlank = units.reduce((count, unit) => count + (unit.trim().length > 0 ? 1 : 0), 0)
  if (nonBlank <= REVEAL_FINE_UNIT_LIMIT) return units.map((unit) => [unit])
  const groupCount = Math.min(REVEAL_MAX_ANIMATED_GROUPS, nonBlank)
  const unitsPerGroup = Math.ceil(nonBlank / groupCount)
  const groups: string[][] = []
  let group: string[] = []
  let groupUnits = 0
  for (const unit of units) {
    group.push(unit)
    if (unit.trim().length > 0) groupUnits += 1
    if (groupUnits === unitsPerGroup) {
      groups.push(group)
      group = []
      groupUnits = 0
    }
  }
  if (group.length > 0) {
    if (group.every((unit) => unit.trim().length === 0) && groups.length > 0) groups.at(-1)!.push(...group)
    else groups.push(group)
  }
  return groups
}

function buildTextRevealGroups(
  units: readonly string[],
  start: number,
  revealedLength: number,
  boundaries: readonly number[]
): TextRevealGroup[] {
  const settled: string[] = []
  const fresh: string[] = []
  let cursor = start
  for (const unit of units) {
    // 模型可能把一个拉丁词拆在两帧送达；跨进度的那个单元已有 DOM，归旧组以免重播。
    if (cursor < revealedLength) settled.push(unit)
    else fresh.push(unit)
    cursor += unit.length
  }
  const toGroups = (source: readonly string[], animate: boolean): TextRevealGroup[] => {
    if (source.length === 0) return []
    const fineGrained = source.filter((unit) => unit.trim().length > 0).length <= REVEAL_FINE_UNIT_LIMIT
    return groupRevealUnits(source).map((group) => {
      const text = group.join('')
      return {
        text,
        animate: animate && text.trim().length > 0,
        grouped: !fineGrained,
        ...(fineGrained && text.trim().length === 0 && { plain: true })
      }
    })
  }
  // 已提交的组保留原边界；把旧字重新压组会让新字复用旧 span，@starting-style 因而不启动。
  const previousEnds = boundaries.filter((end) => end > start && end <= cursor)
  const stable: TextRevealGroup[] = []
  let group = ''
  let endIndex = 0
  let position = start
  for (const unit of settled) {
    group += unit
    position += unit.length
    if (endIndex < previousEnds.length && position >= previousEnds[endIndex]) {
      stable.push({ text: group, animate: false, ...(group.trim().length === 0 && { plain: true }) })
      group = ''
      while (endIndex < previousEnds.length && position >= previousEnds[endIndex]) endIndex += 1
    }
  }
  if (group.length > 0) stable.push(...toGroups([group], false))
  return [...stable, ...toGroups(fresh, true)]
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1
  return index
}

/**
 * entry 是不是 text 这个 block 的旧版本：是则返回已浮现的长度，否则返回 0。
 * 只有「几乎整条都是当前文本前缀」的条目才算旧版本；另一段恰好以相同的词开头
 * 时，公共前缀只占它的一小截，不能当成进度。
 *
 * 教训（zcode 2026-11-05 bugfix）：最初只要求「旧文本除末尾 8 字符外都是当前
 * 文本的前缀」—— 短于 8 字符的旧文本对任何公共前缀都成立，有序列表第一帧
 * 「\n列表项三\n」被当成旧条目「\n列表项一\n」的新版本，前三个字不经淡入直接
 * 出现。同一 block 的下一版只会改写末尾的空白和标点，所以尾巴里出现字词就是
 * 另一段内容。取舍：误判成「不是旧版本」只多占几个排期位置；误判成「是旧版本」
 * 则新单元直接出现 —— 前者代价小，宁严勿宽。
 */
export function revealPredecessorLength(text: string, entry: string): number {
  const prefix = commonPrefixLength(text, entry)
  if (prefix === 0) return 0
  const tail = entry.slice(prefix)
  return tail.length <= REVEAL_TAIL_SLACK_CHARS && !REVEAL_WORD_CHAR_RE.test(tail) ? prefix : 0
}

interface RevealSchedule {
  now: number
  start: number
  interval: number
}

function clampRevealMs(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * 给本帧新到的单元排期，返回第一个单元的开始时间和相邻单元的间隔。
 * 跨帧的浮现时钟接续：新一批排在上一批最后一个单元之后，整批铺到
 * 「现在 + 目标滞后」之前 —— 模型和网络本身是突发的，直接按到达顺序出会
 * 一块一块地出现；缓冲把突发铺平。
 *   - 吐得慢：间隔取上限 40ms，逐字可辨；
 *   - 吐得快：目标滞后缩到约 6 个单元的到达时间（最少 80ms）；
 *   - 队列超过目标滞后：每批至少铺开 15ms 逐步回落，不同时起跳。
 * 教训（zcode bugfix）：目标滞后最初固定 250ms，快模型（每秒 100+ 单元）队列
 * 恒顶上限，字要 460ms 才出现，观感即渲染跟不上 —— 滞后必须按到达速度缩放；
 * 而淡入时长固定 300ms 不缩放（时长一缩每字只剩 2-3 帧渐变，肉眼即无动画），
 * 速度只影响起跳延迟。
 */
export function planRevealSchedule(
  state: StreamingRevealState,
  block: StreamingRevealBlockState,
  blockText: string,
  count: number,
  grouped = false
): RevealSchedule {
  const now = performance.now()
  // 同一个 block 内容在提交前又渲染了一次（StrictMode 双渲染 / 丢弃重来），
  // 沿用已排的期；否则它会接在自己后面再排一遍，延迟翻倍。
  const planned = state.pendingSchedules.get(block.id)
  if (planned?.text === blockText) return { now, start: planned.start, interval: planned.interval }
  // 同实例的未提交版本被替换，不拿文本前缀猜身份；其它块的候选全部保留。
  state.pendingSchedules.delete(block.id)
  let clock = state.clock
  for (const entry of state.pendingSchedules.values()) clock = Math.max(clock, entry.end)
  // 每个单元的到达间隔；还没有速度参照时，把这批当作一帧内到达。
  const perUnit = state.rate !== undefined ? 1 / state.rate : REVEAL_FIRST_WINDOW_MS / count
  const lag = clampRevealMs(
    Math.max(REVEAL_LAG_UNITS * perUnit, REVEAL_LAG_GAP_FACTOR * (state.gap ?? 0)),
    REVEAL_MIN_LAG_MS,
    REVEAL_MAX_LAG_MS
  )
  // 队尾：最后一个已排定单元的开始时间，不早于现在。
  const tail = Math.max(clock, now)
  const ceiling = Math.max(0, now + REVEAL_MAX_LAG_MS - tail)
  const available = Math.min(ceiling, Math.max(now + lag - tail, REVEAL_MIN_SPREAD_MS))
  // 首组接在旧队尾之后也占一个间隔；首拍无旧队尾则只有 count-1 段间隔。
  // 8ms 是正常批次的目标，不能让同帧第二段或多个富文本片段突破总滞后预算。
  const intervals = count - 1 + (clock >= now ? 1 : 0)
  const budgetInterval = intervals > 0 ? ceiling / intervals : REVEAL_MAX_INTERVAL_MS
  const interval = Math.min(
    REVEAL_MAX_INTERVAL_MS,
    budgetInterval,
    grouped
      ? Math.max(REVEAL_GROUP_MIN_INTERVAL_MS, available / count)
      : available / count
  )
  const start = Math.max(now, clock + interval)
  state.pendingSchedules.set(block.id, {
    text: blockText,
    now,
    start,
    interval,
    end: start + (count - 1) * interval,
    count,
  })
  return { now, start, interval }
}

/**
 * 提交本帧进度（挂载组件每帧渲染后的 effect 调用）：排期并入浮现时钟与到达
 * 速度，原生分块候选转正。块内文本另由块自身提交，不跨块去重。
 * （StrictMode 双 effect 安全）。
 */
export function commitStreamingReveal(state: StreamingRevealState): void {
  if (state.pendingSchedules.size > 0) {
    let count = 0
    let arrival = Number.NEGATIVE_INFINITY
    for (const planned of state.pendingSchedules.values()) {
      state.clock = Math.max(state.clock, planned.end)
      count += planned.count
      arrival = Math.max(arrival, planned.now)
    }
    state.pendingSchedules.clear()
    // 段间接力：把排期尾（末拍起跳 + 淡入时长）发布给共享种子，新段首拍
    // 对齐到前段淡入完整结束（无 pacing 的独立渲染不发布）
    if (state.pacing !== undefined) state.pacing.minStart = state.clock + REVEAL_FADE_MS
    // 到达速度只在连续输出时更新：停顿后的第一批沿用停顿前的速度。
    const gap = arrival - state.arrival
    if (gap <= REVEAL_PAUSE_MS) {
      const instant = count / Math.max(gap, REVEAL_MIN_GAP_MS)
      state.rate =
        state.rate === undefined ? instant : state.rate + (instant - state.rate) * REVEAL_RATE_ALPHA
      state.gap = state.gap === undefined ? gap : state.gap + (gap - state.gap) * REVEAL_RATE_ALPHA
    }
    state.arrival = arrival
  }
  if (state.pendingBlocks !== undefined) {
    state.committedBlocks = state.pendingBlocks
    state.pendingBlocks = undefined
  }
}

let streamRevealPluginSeq = 0

type RevealSlot =
  | { kind: 'text'; parent: HastNode; index: number; start: number; units: string[] }
  | { kind: 'element'; node: HastNode; start: number }
  | { kind: 'marker'; node: HastNode; start: number }

type TextRevealGroup = {
  text: string
  animate: boolean
  grouped?: boolean
  /** 短批的纯空白保持文本节点，和原先 DOM 语义一致。 */
  plain?: boolean
}

let cachedWordSegmenter: Intl.Segmenter | null | undefined

function getWordSegmenter(): Intl.Segmenter | null {
  if (cachedWordSegmenter !== undefined) return cachedWordSegmenter
  cachedWordSegmenter =
    typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
      ? new Intl.Segmenter(undefined, { granularity: 'word' })
      : null
  return cachedWordSegmenter
}

/** 拉丁文按单词，中日文按字。segmenter 按模块缓存：每帧 new 一个的构造成本在
    流式里不可接受。教训（zcode bugfix）：中文直接用 word 粒度时 ICU 词典把
    「拍板」切成一块，两个字一起出现，没有逐字打字感 —— 含 CJK 的片段再按
    码点拆开。 */
export function segmentRevealUnits(text: string): string[] {
  const segmenter = getWordSegmenter()
  const words = segmenter
    ? Array.from(segmenter.segment(text), ({ segment }) => segment)
    : (text.match(REVEAL_FALLBACK_WORD_RE) ?? [text])
  const units: string[] = []
  for (const word of words) {
    if (REVEAL_CJK_RE.test(word)) units.push(...Array.from(word))
    else units.push(word)
  }
  return units
}

/** 给已有的 hast 元素追加浮现属性；style 若已存在则拼接，不覆盖。 */
function mergeRevealProperties(node: HastNode, extra: Record<string, string>): void {
  const existingStyle = node.properties?.style
  node.properties = {
    ...node.properties,
    ...extra,
    ...(typeof existingStyle === 'string' && existingStyle && extra.style
      ? { style: `${existingStyle};${extra.style}` }
      : {}),
  }
}

function collectHastText(node: HastNode): string {
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(collectHastText).join('')
}

/**
 * 插件工厂。函数名带模块级递增序号：Streamdown 的 unified processor 缓存按
 * 插件函数 name 拼 key 不看引用，同名实例被共用会读到第一条消息的已终结
 * state（zcode 2026-11-06 bugfix：启动后只有第一条消息有动画）。2.7.1 源码
 * （chunk generateCacheKey）核实此规则仍在。
 */
export function createStreamingRevealPlugin(state: StreamingRevealState, block: StreamingRevealBlockState): StreamRevealPlugin {
  const plugin = function streamRevealRehypePlugin() {
    return (tree: HastNode) => {
      const slots: RevealSlot[] = []
      const blockTexts: string[] = []
      let offset = 0

      const walk = (node: HastNode, skip: boolean) => {
        const children = node.children
        if (!children) return
        for (let index = 0; index < children.length; index += 1) {
          const child = children[index]
          if (child.type === 'text') {
            const value = child.value ?? ''
            if (value.length === 0) continue
            if (!skip) {
              slots.push({
                kind: 'text',
                parent: node,
                index,
                start: offset,
                units: segmentRevealUnits(value),
              })
            }
            // 跳过的文本也计入 block 文本：它们同样占用偏移，前缀比较要和
            // 渲染顺序一致。
            blockTexts.push(value)
            offset += value.length
            continue
          }
          const tagName = child.tagName
          const childSkip = skip || (tagName !== undefined && REVEAL_SKIP_TAGS.has(tagName))
          // 列表圆点 / 序号是 li::marker 伪元素，不是文本节点，包不到 span。
          // 把 marker 当一个单元排进节奏，紧排在这个 li 第一个字之前；
          // 样式过渡 ::marker 的 color（opacity 在 ::marker 上无效）。
          if (!childSkip && tagName === 'li') {
            slots.push({ kind: 'marker', node: child, start: offset })
          }
          // 行内 code 整个元素算一个单元（不跳过它，否则它一挂载就全亮，
          // 左边的字还在淡入，看起来是行内 code 先出来）。代码块是 pre > code，
          // 已由 pre 跳过，走到这里的 code 都是行内 code。
          if (!childSkip && tagName === 'code') {
            const text = collectHastText(child)
            if (text.length === 0) continue
            slots.push({ kind: 'element', node: child, start: offset })
            blockTexts.push(text)
            offset += text.length
            continue
          }
          walk(child, childSkip)
        }
      }
      walk(tree, false)

      const blockText = blockTexts.join('')
      // 即使本帧不动画也要记下进度，否则下一帧会把这整段当成新增。
      block.pending = blockText
      const pendingBoundaries: number[] = []
      block.pendingBoundaries = pendingBoundaries
      if (slots.length === 0) return
      // 非追加或结构重整帧整段都算已浮现：用无穷大而不是文本长度，
      // 否则末尾还没有文字的空 li 会被当成新单元，回填时圆点也跟着淡入。
      const predecessor = revealPredecessorLength(blockText, block.committed)
      // 脚注定义等会改写同一块的已解析文字；这不是新增段落，不能从头重新排期。
      const append = state.incremental && !state.restructured && (block.committed.length === 0 || predecessor > 0)
      const revealedLength = append
        ? predecessor
        : Number.POSITIVE_INFINITY
      /* 单元按开头是否越过进度判定新旧。跨过进度的单元是上一帧已挂载的同一个
         元素被延长（拉丁文 token 常把一个词拆成几段送达，key 按同级序号不变），
         @starting-style 不会对它重播，再标 new 只会白占一个排期位置。 */
      const textGroups = new Map<RevealSlot, TextRevealGroup[]>()
      let fresh = 0
      let grouped = false
      for (const slot of slots) {
        if (slot.kind !== 'text') {
          if (slot.start >= revealedLength) fresh += 1
          continue
        }
        const groups = buildTextRevealGroups(slot.units, slot.start, revealedLength, block.boundaries)
        fresh += groups.filter((group) => group.animate).length
        grouped ||= groups.some((group) => group.animate && group.grouped)
        textGroups.set(slot, groups)
        let end = slot.start
        for (const group of groups) {
          end += group.text.length
          pendingBoundaries.push(end)
        }
      }
      const schedule = fresh > 0 ? planRevealSchedule(state, block, blockText, fresh, grouped) : undefined
      let revealIndex = 0
      const nextRevealDelay = (): string => {
        const delay = schedule
          ? schedule.start + revealIndex * schedule.interval - schedule.now
          : 0
        revealIndex += 1
        return `${delay.toFixed(1)}ms`
      }
      // 只写延迟；时长统一取 globals.css 的 --reveal-duration。
      const nextRevealProperties = (): Record<string, string> => ({
        'data-reveal': 'new',
        style: `--reveal-delay:${nextRevealDelay()}`,
      })

      /* 短批仍是一字/词一 span，保留既有稳定 key 语义；大批压成连续文本组，
         每组一个 span。组内空白仍与相邻文字同在一个节点，因此文本守恒且不会
         在断词处多插空格。所有 settled 组也保留 span：纯追加时旧组的位置不变，
         新组才挂载并播放 opacity。 */
      const replacements = new Map<HastNode, Map<number, HastNode[]>>()
      for (const slot of slots) {
        if (slot.kind === 'marker') {
          // 圆点占一个排期位置。延迟用单独的变量名：不能复用 --reveal-delay，
          // li 上的值会被里面 settled 的字继承。
          mergeRevealProperties(
            slot.node,
            slot.start >= revealedLength
              ? {
                  'data-reveal-marker': 'new',
                  style: `--reveal-marker-delay:${nextRevealDelay()}`,
                }
              : { 'data-reveal-marker': 'settled' }
          )
          continue
        }
        if (slot.kind === 'element') {
          // 行内 code 渲染器透传属性，底色和文字一起按排期淡入。
          mergeRevealProperties(
            slot.node,
            slot.start >= revealedLength ? nextRevealProperties() : { 'data-reveal': 'settled' }
          )
          continue
        }
        const out = textGroups.get(slot)!.map((group) =>
          group.plain
            ? { type: 'text', value: group.text }
            : {
                type: 'element',
                tagName: 'span',
                properties: group.animate ? nextRevealProperties() : { 'data-reveal': 'settled' },
                children: [{ type: 'text', value: group.text }],
              }
        )
        if (out.length === 0) continue
        let perParent = replacements.get(slot.parent)
        if (!perParent) {
          perParent = new Map()
          replacements.set(slot.parent, perParent)
        }
        perParent.set(slot.index, out)
      }

      // 同一个 parent 可能有多个文本节点被替换，逐个 splice 会让后面的下标
      // 失效；按 parent 一次性重建 children。
      for (const [parent, perParent] of replacements) {
        const children = parent.children
        if (!children) continue
        const next: HastNode[] = []
        for (let index = 0; index < children.length; index += 1) {
          const replacement = perParent.get(index)
          if (replacement) next.push(...replacement)
          else next.push(children[index])
        }
        parent.children = next
      }
    }
  }
  streamRevealPluginSeq += 1
  Object.defineProperty(plugin, 'name', {
    value: `streamRevealRehypePlugin$${streamRevealPluginSeq}`,
  })
  return plugin
}
