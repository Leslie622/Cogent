/** tool-display 纯函数单测：类别词 / summary 剥壳 / MCP 名 / diff 计数（钉行为，见 docs/约定.md §1.3-4） */
import { describe, expect, it } from 'vitest'
import { askUserSummary, diffCount, mcpDisplayName, parseToolSummary, toolKindLabel } from './tool-display'

describe('toolKindLabel', () => {
  it('running 用进行形，其余三态共用完成形（失败的「已写入」指动作已发生）', () => {
    expect(toolKindLabel('read', 'running')).toBe('正在读取')
    expect(toolKindLabel('read', 'ok')).toBe('已读取')
    expect(toolKindLabel('write', 'error')).toBe('已写入')
    expect(toolKindLabel('write', 'blocked')).toBe('已写入')
  })

  it('find 与 grep 共用搜索词；shell 双名（bash/powershell）共用执行命令', () => {
    expect(toolKindLabel('find', 'ok')).toBe('已搜索')
    expect(toolKindLabel('grep', 'ok')).toBe('已搜索')
    expect(toolKindLabel('powershell', 'ok')).toBe('执行命令')
    expect(toolKindLabel('bash', 'running')).toBe('正在执行')
  })

  it('mcp__ 前缀走「正在调用/已调用」，未知名兜底「正在执行/已执行」', () => {
    expect(toolKindLabel('mcp__image_search__search_image', 'running')).toBe('正在调用')
    expect(toolKindLabel('mcp__image_search__search_image', 'ok')).toBe('已调用')
    expect(toolKindLabel('glob', 'ok')).toBe('已执行')
    expect(toolKindLabel('旧历史名', 'running')).toBe('正在执行')
  })
})

describe('parseToolSummary', () => {
  it('剥掉 name( 前缀与尾括号：字符串值不带引号（summarizeArgs 口径）', () => {
    expect(parseToolSummary('read', 'read(src/index.ts)')).toBe('src/index.ts')
    expect(parseToolSummary('grep', 'grep(分钟, docs)')).toBe('分钟, docs')
  })

  it('截断尾（…）与空参原样透传；括号不配对回退原文', () => {
    expect(parseToolSummary('read', 'read(超长路径截断…)')).toBe('超长路径截断…')
    expect(parseToolSummary('enter_plan', 'enter_plan()')).toBe('')
    expect(parseToolSummary('read', 'v1 旧转录无括号')).toBe('v1 旧转录无括号')
  })
})

describe('mcpDisplayName', () => {
  it('mcp__server__tool → server.tool；非 mcp 名返回 undefined', () => {
    expect(mcpDisplayName('mcp__image_search__search_image')).toBe('image_search.search_image')
    expect(mcpDisplayName('read')).toBeUndefined()
  })
})

describe('askUserSummary', () => {
  it('questions 数组数问题数（zcode「已询问 1 个问题」的参数侧）', () => {
    expect(askUserSummary('ask_user([{"question":"q1","options":["a"]}] )')).toBe('1 个问题')
    expect(
      askUserSummary('ask_user([{"question":"q1"},{"question":"q2"},{"question":"q3"}])')
    ).toBe('3 个问题')
  })

  it('空数组/非 JSON/截断回退：空参给「1 个问题」，截断 JSON 透传剥壳文本', () => {
    expect(askUserSummary('ask_user()')).toBe('1 个问题')
    // 括号配对但 JSON 解析失败（截断）→ inner 原样透传
    expect(askUserSummary('ask_user([{"question":"截断…")')).toBe('[{"question":"截断…"')
  })
})

describe('diffCount', () => {
  it('数 +/- 行，文件头 +++/--- 不计', () => {
    expect(diffCount('+++ a/x.ts\n--- b/x.ts\n+新增\n-删除\n+再增\n 上下文')).toEqual({
      added: 2,
      removed: 1
    })
  })

  it('纯上下文（无增删）返回 undefined —— 尾标整枚不显示', () => {
    expect(diffCount(' 上下文一行\n 上下文两行')).toBeUndefined()
  })
})
