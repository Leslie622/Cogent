/** 折叠只改变可见范围：容器层级、转义、大整数及截断文本均不改写。 */
import { describe, expect, it } from 'vitest'
import { getJsonFoldRanges } from '@/lib/json-folding'

describe('JSON 展开层级', () => {
  const content = '{"id":9007199254740993,"messages":[{"content":{"text":"a\\\"{}[]"}},{"content":[]}],"usage":{"output":12}}'
  const slices = (depth: number) => getJsonFoldRanges(content, depth).map(({ from, to }) => content.slice(from, to))

  it('根算第1层，展开1层折子容器，展开2层保留数组并折其元素', () => {
    expect(slices(0)).toEqual([content.slice(1, -1)])
    expect(slices(1)).toEqual(['{"content":{"text":"a\\\"{}[]"}},{"content":[]}', '"output":12'])
    expect(slices(2)).toEqual(['"content":{"text":"a\\\"{}[]"}', '"content":[]'])
    expect(slices(3)).toEqual(['"text":"a\\\"{}[]"'])
    expect(slices(5)).toEqual([])
    expect(content).toContain('9007199254740993')
  })

  it('截断的父容器保持可读，已闭合子容器仍能折叠', () => {
    const partial = '{"messages":[{"text":"complete"},{"text":"cut\n…[已截断，原始 400000 字符]'
    const ranges = getJsonFoldRanges(partial, 0)
    expect(ranges.map(({ from, to }) => partial.slice(from, to))).toEqual(['"text":"complete"'])
    expect(getJsonFoldRanges('(不可序列化)', 1)).toEqual([])
  })
})
