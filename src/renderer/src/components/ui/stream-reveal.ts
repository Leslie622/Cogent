/**
 * 流式正文逐词淡入（计划/流式呈现动效.md，移植自 zcode streaming-markdown-reveal：
 * reference/zcode/packages/ui/src/components/ai-elements/message.tsx:845-1345 与其
 * docs/streaming-markdown-reveal.md —— 三代前身栽坑的历史教训都记录在彼处）。
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
 * 不需要像 zcode 那样落后一帧 —— 下一帧插件读到的就是最新进度。
 */

/** 跳过的高亮 / 图形元素：代码块高亮是异步的，逐字会与高亮结果打架；svg 同理。
    zcode 还跳过 math（rehype-katex 会整个替换公式节点）；Cogent 未装 math 插件，
    管线里不会出现 math 元素，装时在此补上。 */
const REVEAL_SKIP_TAGS = new Set(['pre', 'svg'])
/** 相邻两个单元开始淡入的最大间隔：吐得慢时按这个节奏逐字出现。 */
const REVEAL_MAX_INTERVAL_MS = 40
/** 最大滞后：任何单元最晚在到达后这么久开始淡入。也封住单帧大批量的累计延迟 ——
    Streamdown 内置动画正是栽在没有封顶：stagger 40ms × 1000 词 = 末尾 40 秒后才可见。 */
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
/** 还没有速度参照时，按一帧估这批单元的到达间隔（zcode 桌面端 30ms 合帧的
    估值；Cogent 无合帧、每 delta 直达，首批后即由 EWMA 接管，此值只影响首拍）。 */
const REVEAL_FIRST_WINDOW_MS = 30
/** 单帧源文本增量超过它就不是 live delta，而是挂载 / 回填 / 切会话，整条消息
    不动画。护栏放消息级：进度按 block 记录后，单 block 上限挡不住「多个段落
    各自不超限」的整段重播。 */
const REVEAL_MAX_DELTA_CHARS = 600
/** 前面的 block 被 Streamdown 的 memo 冻结、不再跑插件，只记最近若干条 block。 */
const REVEAL_COMMITTED_BLOCK_CAP = 16
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

export interface StreamingRevealState {
  /** 已提交的最近 block 渲染文本；插件在 render 期间只读它。 */
  committed: string[]
  /** 本轮渲染里各 block 的渲染文本，由挂载组件的 effect 提交给 committed。 */
  pending: string[]
  /** 浮现时钟：最后一个已排定单元的开始时间（performance.now 时间线），跨帧接续节奏。 */
  clock: number
  /** 到达速度（单元 / ms）的 EWMA；还没有参照时为 undefined。commit 后更新。 */
  rate: number | undefined
  /** 相邻两轮新单元到达间隔（ms）的 EWMA。 */
  gap: number | undefined
  /** 上一轮新单元到达的时间。 */
  arrival: number
  /** 本轮渲染里各 block 的排期，按 block 渲染文本索引；commit 后并入时钟与速度。 */
  pendingSchedules: Map<string, RevealPlan>
  /** 本帧是否是纯追加的 live delta；非追加或增量过大时整条消息不动画。 */
  incremental: boolean
}

interface RevealPlan {
  /** 排期时刻，也就是这批单元的到达时间。 */
  now: number
  start: number
  interval: number
  end: number
  count: number
}

export function createStreamingRevealState(): StreamingRevealState {
  return {
    committed: [],
    pending: [],
    clock: Number.NEGATIVE_INFINITY,
    rate: undefined,
    gap: undefined,
    arrival: Number.NEGATIVE_INFINITY,
    pendingSchedules: new Map(),
    incremental: false,
  }
}

/** 非前缀变化意味着回填、切会话或模型重写。此时整段按已稳定处理，绝不能按旧
    进度裁剪正文 —— zcode「切回来开头被吞掉」就是这么来的。 */
export function isIncrementalRevealSource(previous: string, next: string): boolean {
  return (
    next.length > previous.length &&
    next.length - previous.length <= REVEAL_MAX_DELTA_CHARS &&
    next.startsWith(previous)
  )
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

/** 当前 block 已浮现的长度：与最近已提交 block 文本取最长的可信前缀 */
export function resolveRevealedLength(blockText: string, committed: readonly string[]): number {
  let revealed = 0
  for (const entry of committed) {
    revealed = Math.max(revealed, revealPredecessorLength(blockText, entry))
  }
  return revealed
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
  blockText: string,
  count: number
): RevealSchedule {
  const now = performance.now()
  // 同一个 block 内容在提交前又渲染了一次（StrictMode 双渲染 / 丢弃重来），
  // 沿用已排的期；否则它会接在自己后面再排一遍，延迟翻倍。
  const planned = state.pendingSchedules.get(blockText)
  if (planned) return { now, start: planned.start, interval: planned.interval }
  // 同一轮渲染里后面的 block 接着前面的排。当前文本的前缀版本是同一个 block
  // 被打断、丢弃的那次渲染，它的单元从未上屏：不能接在它后面（凭空多段延迟），
  // 提交时也不能把它的单元数计入到达速度。
  let clock = state.clock
  for (const [key, entry] of state.pendingSchedules) {
    if (blockText.startsWith(key)) state.pendingSchedules.delete(key)
    else clock = Math.max(clock, entry.end)
  }
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
  const interval = Math.min(REVEAL_MAX_INTERVAL_MS, available / count)
  const start = Math.max(now, clock + interval)
  state.pendingSchedules.set(blockText, {
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
 * 速度，pending block 文本转正 committed。幂等：pending 清空后再调是 no-op
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
  if (state.pending.length === 0) return
  let committed = state.committed
  for (const text of state.pending) {
    if (text.length === 0) continue
    // 同一个 block 的新文本覆盖它的旧版本：旧条目去掉，免得日后被误认成别的
    // block 的旧版本。判定与 resolveRevealedLength 用同一条规则（不是严格前缀
    // —— 尾随换行被改写就不是前缀了，zcode 曾因此误判）。StrictMode 双渲染
    // 重复推入的同一段文本也在这里去重。
    committed = committed.filter((entry) => revealPredecessorLength(text, entry) === 0)
    committed.push(text)
  }
  state.committed = committed.slice(-REVEAL_COMMITTED_BLOCK_CAP)
  state.pending = []
}

let streamRevealPluginSeq = 0

type RevealSlot =
  | { kind: 'text'; parent: HastNode; index: number; start: number; units: string[] }
  | { kind: 'element'; node: HastNode; start: number }
  | { kind: 'marker'; node: HastNode; start: number }

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
export function createStreamingRevealPlugin(state: StreamingRevealState): StreamRevealPlugin {
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
      state.pending.push(blockText)
      if (slots.length === 0) return
      // 非增量帧（挂载、回填、切会话）整段都算已浮现：用无穷大而不是文本长度，
      // 否则末尾还没有文字的空 li 会被当成新单元，回填时圆点也跟着淡入。
      const revealedLength = state.incremental
        ? resolveRevealedLength(blockText, state.committed)
        : Number.POSITIVE_INFINITY
      /* 单元按开头是否越过进度判定新旧。跨过进度的单元是上一帧已挂载的同一个
         元素被延长（拉丁文 token 常把一个词拆成几段送达，key 按同级序号不变），
         @starting-style 不会对它重播，再标 new 只会白占一个排期位置。 */
      let fresh = 0
      for (const slot of slots) {
        if (slot.kind !== 'text') {
          if (slot.start >= revealedLength) fresh += 1
          continue
        }
        let cursor = slot.start
        for (const unit of slot.units) {
          if (cursor >= revealedLength && unit.trim().length > 0) fresh += 1
          cursor += unit.length
        }
      }
      const schedule = fresh > 0 ? planRevealSchedule(state, blockText, fresh) : undefined
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

      /* 每个非空白单元都包 span（含 settled）：hast-util-to-jsx-runtime 按
         「标签 + 同级序号」生成 key，只包新单元时下一帧新词拿到的 span-0 正是
         上一帧旧词的 DOM 元素，React 只改文字、动画不播（zcode 关键 bugfix）。
         全包之后纯追加时旧单元的 span 位置不变、DOM 保留；新单元出现在末尾，
         拿到新 key，一定是新挂载的元素。纯空白保留文本节点。 */
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
        let cursor = slot.start
        const out: HastNode[] = []
        for (const unit of slot.units) {
          if (unit.trim().length === 0) {
            out.push({ type: 'text', value: unit })
          } else {
            out.push({
              type: 'element',
              tagName: 'span',
              properties:
                cursor >= revealedLength
                  ? nextRevealProperties()
                  : { 'data-reveal': 'settled' },
              children: [{ type: 'text', value: unit }],
            })
          }
          cursor += unit.length
        }
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
