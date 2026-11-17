/**
 * stream-reveal 纯函数单测（计划/流式呈现动效.md 验收 1）：切分 / 进度判定 /
 * 增量判定 / 排期 / 提交。钉的是行为契约，断言值对应 zcode 移植时保留的
 * 教训场景（列表项误判、尾随标点改写、StrictMode 重复、速度自适应）。
 */
import { describe, expect, it } from 'vitest'
import {
  commitStreamingReveal,
  commitStreamingRevealBlock,
  createStreamingRevealBlockState,
  createStreamingRevealState,
  groupRevealUnits,
  isIncrementalRevealSource,
  planRevealSchedule,
  prepareStreamingRevealBlocks,
  revealPredecessorLength,
  segmentRevealUnits,
} from '@/components/ui/stream-reveal'

describe('segmentRevealUnits 切分（拉丁按词 / CJK 按字 / 空白保留）', () => {
  it('拉丁文按单词切，空白自占一个单元', () => {
    expect(segmentRevealUnits('hello world')).toEqual(['hello', ' ', 'world'])
  })

  it('汉字按字切：ICU 词典分词会把「拍板」切成一块，没有逐字打字感（zcode 教训）', () => {
    expect(segmentRevealUnits('拍板决策')).toEqual(['拍', '板', '决', '策'])
  })

  it('中英混排：各按各的粒度', () => {
    expect(segmentRevealUnits('用delta流式')).toEqual(['用', 'delta', '流', '式'])
  })
})

describe('groupRevealUnits 大批动画预算', () => {
  it('短批保持逐字/词粒度，保留原有渐隐尾巴', () => {
    expect(groupRevealUnits(['拍', '板', ' ', 'decide'])).toEqual([['拍'], ['板'], [' '], ['decide']])
  })

  it('大批普通正文压成最多32个连续组，文本与空白完全守恒', () => {
    const units = Array.from({ length: 240 }, (_, index) => (index % 6 === 5 ? ' ' : '字'))
    const groups = groupRevealUnits(units)
    expect(groups.length).toBeLessThanOrEqual(32)
    expect(groups.flat().join('')).toBe(units.join(''))
    expect(groups.every((group) => group.length > 0)).toBe(true)
  })

  it('大批拉丁文不拆词，连续组只在既有单元边界切开', () => {
    const units = Array.from({ length: 120 }, (_, index) => `word${index}`)
    const groups = groupRevealUnits(units)
    expect(groups).toHaveLength(30)
    expect(groups.flat()).toEqual(units)
  })
})

describe('revealPredecessorLength 旧版本判定（宁严勿宽）', () => {
  it('旧文本是当前文本前缀：返回已浮现长度', () => {
    expect(revealPredecessorLength('拍板决策好了', '拍板决策')).toBe(4)
  })

  it('前缀后只剩标点（remend 补全 / 尾随空白裁剪）也算旧版本', () => {
    expect(revealPredecessorLength('拍板决策好了', '拍板决策，')).toBe(4)
  })

  it('分叉尾巴含字词 = 另一段内容：有序列表「列表项一/三」误判场景（zcode 2026-11-05）', () => {
    expect(revealPredecessorLength('\n列表项三\n', '\n列表项一\n')).toBe(0)
  })

  it('无公共前缀 = 0', () => {
    expect(revealPredecessorLength('abc', 'xyz')).toBe(0)
  })
})

describe('真实块实例的独立进度', () => {
  it('同文块分别提交：新块不继承另一块的文本边界', () => {
    const first = createStreamingRevealBlockState()
    const second = createStreamingRevealBlockState()
    first.pending = '相同'
    first.pendingBoundaries = [1, 2]
    commitStreamingRevealBlock(first)
    expect(first.committed).toBe('相同')
    expect(second.committed).toBe('')
    expect(first.id).not.toBe(second.id)
    expect(revealPredecessorLength('相同', second.committed)).toBe(0)
    second.pending = '相同'
    second.pendingBoundaries = [1, 2]
    commitStreamingRevealBlock(second)
    expect(first.committed).toBe(second.committed)
    expect(first.boundaries).not.toBe(second.boundaries)
  })

  it('本块提交组边界后再提交幂等，不把重试当作新版本', () => {
    const block = createStreamingRevealBlockState()
    block.pending = '你好'
    block.pendingBoundaries = [1, 2]
    commitStreamingRevealBlock(block)
    const boundaries = block.boundaries
    commitStreamingRevealBlock(block)
    expect(block.committed).toBe('你好')
    expect(block.boundaries).toBe(boundaries)
    expect(block.pending).toBeUndefined()
  })
})

describe('isIncrementalRevealSource 消息级增量判定', () => {
  it('空 → 非空是增量（首帧整段浮现）', () => {
    expect(isIncrementalRevealSource('', '你好')).toBe(true)
  })

  it('纯追加是增量', () => {
    expect(isIncrementalRevealSource('你好', '你好世界')).toBe(true)
  })

  it('非前缀变化（回填 / 重写）不是增量', () => {
    expect(isIncrementalRevealSource('你好', '你号')).toBe(false)
  })

  it('大批纯追加仍是 live：策略改为有限组渐显，不再误当回填整片直出', () => {
    expect(isIncrementalRevealSource('', '好'.repeat(601))).toBe(true)
    expect(isIncrementalRevealSource('好'.repeat(100), '好'.repeat(701))).toBe(true)
  })
})

describe('planRevealSchedule 排期', () => {
  it('批内间隔封顶 40ms（逐字可辨），队列积压时至少铺开 15ms 逐步回落', () => {
    const state = createStreamingRevealState()
    state.clock = performance.now() - 500 // 队列已积压 500ms（超过 250ms 上限）
    const schedule = planRevealSchedule(state, createStreamingRevealBlockState(), '字', 1)
    expect(schedule.interval).toBeLessThanOrEqual(40)
    expect(schedule.interval).toBeGreaterThanOrEqual(15)
  })

  it('接龙：同轮第二个 block 排在第一个 block 的末单元之后', () => {
    const state = createStreamingRevealState()
    const first = planRevealSchedule(state, createStreamingRevealBlockState(), '一', 2)
    const second = planRevealSchedule(state, createStreamingRevealBlockState(), '二', 3)
    expect(second.start).toBeGreaterThanOrEqual(first.start + first.interval)
  })

  it('同一 block 提交前重复渲染（StrictMode 双渲染）沿用已排的期，不接龙翻倍', () => {
    const state = createStreamingRevealState()
    const block = createStreamingRevealBlockState()
    const first = planRevealSchedule(state, block, '你好世界', 2)
    const again = planRevealSchedule(state, block, '你好世界', 2)
    expect(again.start).toBe(first.start)
    expect(again.interval).toBe(first.interval)
  })

  it('同文新块分别排期，后块接在前块末组之后', () => {
    const state = createStreamingRevealState()
    const first = planRevealSchedule(state, createStreamingRevealBlockState(), '相同', 2)
    const second = planRevealSchedule(state, createStreamingRevealBlockState(), '相同', 2)
    expect(state.pendingSchedules.size).toBe(2)
    expect(second.start).toBeGreaterThan(first.start + first.interval)
  })

  it('同实例未提交的新版本只替换自己，不能删除前缀相同的另一块', () => {
    const state = createStreamingRevealState()
    const first = createStreamingRevealBlockState()
    const second = createStreamingRevealBlockState()
    planRevealSchedule(state, first, '你好', 2)
    planRevealSchedule(state, second, '你好', 2)
    planRevealSchedule(state, first, '你好世界', 4)
    expect(state.pendingSchedules.size).toBe(2)
    expect(state.pendingSchedules.get(first.id)?.text).toBe('你好世界')
    expect(state.pendingSchedules.get(second.id)?.text).toBe('你好')
  })

  it('大批32组按组排期仍至少隔8ms，首拍末组在约250ms内起跳', () => {
    const state = createStreamingRevealState()
    const plan = planRevealSchedule(state, createStreamingRevealBlockState(), '大批', 32, true)
    expect(plan.interval).toBeGreaterThanOrEqual(8)
    expect(plan.start + 31 * plan.interval - plan.now).toBeLessThanOrEqual(250)
  })

  it('多个富文本片段或同帧第二大段服从250ms预算，不因8ms目标无限接龙', () => {
    const rich = createStreamingRevealState()
    const many = planRevealSchedule(rich, createStreamingRevealBlockState(), '富文本多片段', 64, true)
    // 绝对performance时刻加减可能多出约1e-13ms；容差远小于任何可见/可调度时间单位。
    const ceiling = 250 + 1e-8
    expect(many.start + 63 * many.interval - many.now).toBeLessThanOrEqual(ceiling)
    const state = createStreamingRevealState()
    planRevealSchedule(state, createStreamingRevealBlockState(), '第一大段', 32, true)
    const second = planRevealSchedule(state, createStreamingRevealBlockState(), '第二大段', 32, true)
    expect(second.start + 31 * second.interval - second.now).toBeLessThanOrEqual(ceiling)
    const tail = planRevealSchedule(state, createStreamingRevealBlockState(), '尾部', 2)
    expect(tail.start + tail.interval - tail.now).toBeLessThanOrEqual(ceiling)
  })
})

describe('原生分块的观察与提交', () => {
  it('候选只在提交后转正，StrictMode 双提交幂等', () => {
    const state = createStreamingRevealState()
    prepareStreamingRevealBlocks(state, ['a', 'b'])
    expect(state.committedBlocks).toEqual([])
    commitStreamingReveal(state)
    expect(state.committedBlocks).toEqual(['a', 'b'])
    expect(state.pendingBlocks).toBeUndefined()
    commitStreamingReveal(state)
    expect(state.committedBlocks).toEqual(['a', 'b'])
  })

  it('相同文本的新块原样保留，尾块增长/追加不误判结构重整', () => {
    const state = createStreamingRevealState()
    prepareStreamingRevealBlocks(state, ['相同'])
    commitStreamingReveal(state)
    prepareStreamingRevealBlocks(state, ['相同', '相同'])
    expect(state.restructured).toBe(false)
    commitStreamingReveal(state)
    expect(state.committedBlocks).toEqual(['相同', '相同'])
    prepareStreamingRevealBlocks(state, ['相同', '相同继续'])
    expect(state.restructured).toBe(false)
  })

  it('脚注/链接定义导致2块合成1块，本次按结构重整处理', () => {
    const state = createStreamingRevealState()
    prepareStreamingRevealBlocks(state, ['first', 'second'])
    commitStreamingReveal(state)
    prepareStreamingRevealBlocks(state, ['first\n\nsecond\n\n[ref]: https://example.com'])
    expect(state.restructured).toBe(true)
    commitStreamingReveal(state)
    prepareStreamingRevealBlocks(state, ['first\n\nsecond\n\n[ref]: https://example.com\n\n追加'])
    expect(state.restructured).toBe(false)
  })

  it('块数不变但原稳定前缀改变，同样不能按旧块认领', () => {
    const state = createStreamingRevealState()
    prepareStreamingRevealBlocks(state, ['first', 'second'])
    commitStreamingReveal(state)
    prepareStreamingRevealBlocks(state, ['rewritten', 'second'])
    expect(state.restructured).toBe(true)
  })

  it('同文双块的计划统一转正，重复提交不再累计', () => {
    const state = createStreamingRevealState()
    planRevealSchedule(state, createStreamingRevealBlockState(), '相同', 2)
    const last = planRevealSchedule(state, createStreamingRevealBlockState(), '相同', 2)
    commitStreamingReveal(state)
    expect(state.clock).toBe(last.start + last.interval)
    expect(state.pendingSchedules.size).toBe(0)
    const clock = state.clock
    commitStreamingReveal(state)
    expect(state.clock).toBe(clock)
  })

  it('被丢弃的分块候选换版后不进入时钟；同版StrictMode重试保留候选', () => {
    const state = createStreamingRevealState()
    const block = createStreamingRevealBlockState()
    prepareStreamingRevealBlocks(state, ['未提交'])
    planRevealSchedule(state, block, '未提交', 3)
    prepareStreamingRevealBlocks(state, ['未提交'])
    expect(state.pendingSchedules.size).toBe(1)
    prepareStreamingRevealBlocks(state, ['替换版本'])
    expect(state.pendingSchedules.size).toBe(0)
    commitStreamingReveal(state)
    expect(state.clock).toBe(Number.NEGATIVE_INFINITY)
    expect(state.committedBlocks).toEqual(['替换版本'])
  })
})
