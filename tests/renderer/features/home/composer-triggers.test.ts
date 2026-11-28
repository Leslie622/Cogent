/**
 * 输入区触发符与候选排序单测：覆盖 `/`、`$`/`￥`/`¥` 归一、反误触与模糊评分。
 */
import { describe, expect, it } from 'vitest'
import {
  bestSuggestionIndex,
  extractActiveTrigger,
  filterSuggestions,
  triggerSignature
} from '../../../../src/renderer/src/features/home/composer/triggers'
import { ENTITY_SENTINEL, type ComposerSuggestionItem } from '../../../../src/renderer/src/features/home/composer/types'

describe('extractActiveTrigger', () => {
  it('行首与空白后的 / 与 $ 正常触发', () => {
    expect(extractActiveTrigger('/')).toEqual({ kind: '/', query: '', start: 0, end: 1 })
    expect(extractActiveTrigger('/com')).toEqual({ kind: '/', query: 'com', start: 0, end: 4 })
    expect(extractActiveTrigger('请用 $bro')).toEqual({ kind: '$', query: 'bro', start: 3, end: 7 })
  })

  it('中文全角 ￥ 与半角 ¥ 均归一为 $ 技能触发', () => {
    expect(extractActiveTrigger('￥')).toEqual({ kind: '$', query: '', start: 0, end: 1 })
    expect(extractActiveTrigger('帮我用 ￥ctrl')).toEqual({ kind: '$', query: 'ctrl', start: 4, end: 9 })
    expect(extractActiveTrigger('¥pdf')).toEqual({ kind: '$', query: 'pdf', start: 0, end: 4 })
  })

  it('实体哨兵后紧跟触发符也可唤起', () => {
    const text = `${ENTITY_SENTINEL}$next`
    expect(extractActiveTrigger(text)).toEqual({ kind: '$', query: 'next', start: 1, end: 6 })
  })

  it('词中斜杠、URL、含空格查询与邮箱不触发', () => {
    expect(extractActiveTrigger('https://example.com')).toBeNull()
    expect(extractActiveTrigger('/compact 参数')).toBeNull()
    expect(extractActiveTrigger('abc$def')).toBeNull()
    expect(extractActiveTrigger('user@example.com')).toBeNull()
    expect(extractActiveTrigger('@资源')).toEqual({ kind: '@', query: '资源', start: 0, end: 3 })
    expect(extractActiveTrigger('@')).toEqual({ kind: '@', query: '', start: 0, end: 1 })
  })

  it('triggerSignature 稳定区分不同触发位置与查询', () => {
    const a = extractActiveTrigger('/plan')
    const b = extractActiveTrigger('hello /plan')
    expect(triggerSignature(a)).not.toBe(triggerSignature(b))
    expect(triggerSignature(null)).toBeNull()
  })
})

describe('filterSuggestions & bestSuggestionIndex', () => {
  const items: ComposerSuggestionItem[] = [
    {
      id: 'cmd:plan',
      group: 'command',
      label: '/plan',
      description: '开启计划模式',
      keywords: ['plan', '计划'],
      payload: {
        kind: 'command',
        command: {
          id: 'cmd:plan',
          label: '/plan',
          description: '开启计划模式',
          keywords: ['plan', '计划'],
          execution: { kind: 'action', action: 'plan' }
        }
      }
    },
    {
      id: 'cmd:compact',
      group: 'command',
      label: '/compact',
      description: '压缩当前会话上下文',
      keywords: ['compact', '压缩'],
      payload: {
        kind: 'command',
        command: {
          id: 'cmd:compact',
          label: '/compact',
          description: '压缩当前会话上下文',
          keywords: ['compact', '压缩'],
          standaloneOnly: true,
          execution: { kind: 'standalone', name: 'compact', acceptsArgs: true }
        }
      }
    },
    {
      id: 'skill:user:control-browser',
      group: 'skill',
      label: 'control-browser',
      description: '控制内置浏览器并验证页面',
      keywords: ['control-browser', 'skill'],
      payload: { kind: 'skill', name: 'control-browser', scope: 'user' }
    }
  ]

  it('按中文关键词命中命令并保持命令组在技能组前', () => {
    const matched = filterSuggestions(items, '压缩')
    expect(matched.map((x) => x.id)).toEqual(['cmd:compact'])
  })

  it('跨分组时 bestSuggestionIndex 选中全局匹配度最高的技能', () => {
    const filtered = filterSuggestions(items, 'browser')
    expect(filtered.map((x) => x.id)).toEqual(['skill:user:control-browser'])
    expect(bestSuggestionIndex(filtered, 'browser')).toBe(0)
  })
})
