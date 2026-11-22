/** tool-display 纯函数单测：类别词 / summary 剥壳 / MCP 名 / diff 计数（钉行为，见 docs/约定.md §1.3-4） */
import { describe, expect, it } from 'vitest'
import { askUserSummary, diffCount, mcpDisplayName, parseToolSummary, toolKindLabel } from '@/components/ui/tool-display'

describe('toolKindLabel', () => {
  it.each([
    ['read', '读取'], ['read_attachment', '附件'], ['write', '写入'], ['edit', '编辑'],
    ['find', '搜索'], ['grep', '搜索'], ['glob', '搜索'], ['ls', '目录'],
    ['powershell', '终端'], ['bash', '终端'], ['todo_write', '待办'], ['ask_user', '提问'],
    ['enter_plan', '计划'], ['submit_plan', '计划'],
    ['list_mcp_resources', 'MCP'], ['list_mcp_resource_templates', 'MCP'], ['read_mcp_resource', 'MCP'],
    ['mcp__image_search__search_image', 'MCP'], ['旧历史名', '工具'], ['constructor', '工具']
  ])('%s 按用途归类为 %s', (name, label) => {
    expect(toolKindLabel(name)).toBe(label)
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
  it('引擎新摘要（非 JSON 友好文本）原样透传', () => {
    expect(askUserSummary('ask_user(2 个问题)')).toBe('2 个问题')
    expect(askUserSummary('ask_user(1 个问题)')).toBe('1 个问题')
  })

  it('旧转录完整 JSON：数 questions 数组长', () => {
    expect(askUserSummary('ask_user([{"question":"q1","options":["a"]}])')).toBe('1 个问题')
    expect(
      askUserSummary('ask_user([{"question":"q1"},{"question":"q2"},{"question":"q3"}])')
    ).toBe('3 个问题')
  })

  it('旧转录截断 JSON（60 字符截断无尾括号）：regex 数 question 字段，下限 1', () => {
    const truncated =
      'ask_user([{"question":"这次你想让我帮你做什么? ","header":"任务类型","options":[{"lab…'
    expect(askUserSummary(truncated)).toBe('1 个问题')
    const twoThenCut =
      'ask_user([{"question":"q1"},{"question":"q2"},{"header":"任务类型","options":[{"lab…'
    expect(askUserSummary(twoThenCut)).toBe('2 个问题')
  })

  it('空参给「1 个问题」；括号不配对回退原文', () => {
    expect(askUserSummary('ask_user()')).toBe('1 个问题')
    expect(askUserSummary('ask_user([{"question":"截断…")')).toBe('1 个问题')
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
