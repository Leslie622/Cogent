/**
 * stream-reveal 纯函数单测（计划/流式呈现动效.md 验收 1）：切分 / 进度判定 /
 * 增量判定 / 排期 / 提交。钉的是行为契约，断言值对应 zcode 移植时保留的
 * 教训场景（列表项误判、尾随标点改写、StrictMode 重复、速度自适应）。
 */
import { describe, expect, it } from 'vitest'
import {
  commitStreamingReveal,
  createStreamingRevealState,
  isIncrementalRevealSource,
  planRevealSchedule,
  revealPredecessorLength,
  resolveRevealedLength,
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

describe('resolveRevealedLength 多 block 进度', () => {
  it('取所有已提交条目里最长的可信前缀', () => {
    expect(resolveRevealedLength('你好世界', ['你好', '你好世'])).toBe(3)
  })

  it('新段落与已提交内容无前缀关系：从 0 起浮现', () => {
    expect(resolveRevealedLength('全新段落', ['别的段落'])).toBe(0)
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

  it('单帧增量超过 600 字符（挂载 / 恢复）不是增量，整条不动画', () => {
    expect(isIncrementalRevealSource('', '好'.repeat(601))).toBe(false)
    expect(isIncrementalRevealSource('好'.repeat(100), '好'.repeat(701))).toBe(false)
  })
})

describe('planRevealSchedule 排期', () => {
  it('批内间隔封顶 40ms（逐字可辨），队列积压时至少铺开 15ms 逐步回落', () => {
    const state = createStreamingRevealState()
    state.clock = performance.now() - 500 // 队列已积压 500ms（超过 250ms 上限）
    const schedule = planRevealSchedule(state, '字', 1)
    expect(schedule.interval).toBeLessThanOrEqual(40)
    expect(schedule.interval).toBeGreaterThanOrEqual(15)
  })

  it('接龙：同轮第二个 block 排在第一个 block 的末单元之后', () => {
    const state = createStreamingRevealState()
    const first = planRevealSchedule(state, '一', 2)
    const second = planRevealSchedule(state, '二', 3)
    expect(second.start).toBeGreaterThanOrEqual(first.start + first.interval)
  })

  it('同一 block 提交前重复渲染（StrictMode 双渲染）沿用已排的期，不接龙翻倍', () => {
    const state = createStreamingRevealState()
    const first = planRevealSchedule(state, '你好世界', 2)
    const again = planRevealSchedule(state, '你好世界', 2)
    expect(again.start).toBe(first.start)
    expect(again.interval).toBe(first.interval)
  })
})

describe('commitStreamingReveal 提交', () => {
  it('pending 转正 committed，幂等（StrictMode 双 effect 安全）', () => {
    const state = createStreamingRevealState()
    state.pending = ['a', 'b']
    commitStreamingReveal(state)
    expect(state.committed).toEqual(['a', 'b'])
    expect(state.pending).toEqual([])
    commitStreamingReveal(state)
    expect(state.committed).toEqual(['a', 'b'])
  })

  it('双渲染重复推入的同段文本去重', () => {
    const state = createStreamingRevealState()
    state.pending = ['c', 'c']
    commitStreamingReveal(state)
    expect(state.committed).toEqual(['c'])
  })

  it('block 新版覆盖旧版条目（尾随标点改写不是严格前缀也要删得掉，zcode 教训）', () => {
    const state = createStreamingRevealState()
    state.pending = ['b', 'a']
    commitStreamingReveal(state)
    state.pending = ['b!']
    commitStreamingReveal(state)
    expect(state.committed).toEqual(['a', 'b!'])
  })

  it('committed 只保留最近 16 条（前面的 block 已被 memo 冻结）', () => {
    const state = createStreamingRevealState()
    state.pending = Array.from({ length: 20 }, (_, i) => `t${i}`)
    commitStreamingReveal(state)
    expect(state.committed).toHaveLength(16)
    expect(state.committed.at(-1)).toBe('t19')
  })
})
