/**
 * ToolCard 渲染测试（docs/计划/对话过程呈现打磨.md §3.2/3.3 验收钉）：
 * - 头行结构：类别词 + 主文案 + diff 尾标；运行中 data-status=running（扫光
 *   由 CSS 带出）且无「执行中」尾词；ok 无状态词；
 * - 失败：行尾「执行失败」+ 整行不变红（TraceLine 无 data-status=error），
 *   hover 出 Tooltip 看原因（zcode 图 2 形态）；
 * - bash 运行中进度尾行定高两行槽（流稳定化 §3.4）。
 * 折叠体 keepMounted 收起常驻（trace.render.test.tsx 钉），CodeBlock/展开
 * 路径不在本钉范围。
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ToolCard } from './tool'

describe('ToolCard 头行结构（类别词 + 主文案 + 尾标）', () => {
  it('运行中：类别词进行形 + data-status=running，无「执行中」尾词（扫光即信号）', () => {
    const { container } = render(
      <ToolCard name="read" summary="read(src/a.ts)" status="running" />
    )
    expect(screen.getByText('正在读取')).toBeInTheDocument()
    expect(screen.getByText('src/a.ts')).toBeInTheDocument()
    expect(container.querySelector('[data-status="running"]')).not.toBeNull()
    expect(screen.queryByText('执行中')).not.toBeInTheDocument()
  })

  it('完成：类别词完成形，无任何状态尾词（「已读取」自身即完成语义）', () => {
    render(<ToolCard name="read" summary="read(src/a.ts)" status="ok" />)
    expect(screen.getByText('已读取')).toBeInTheDocument()
    expect(screen.queryByText(/完成|失败|拒绝/)).not.toBeInTheDocument()
  })

  it('edit 终态带 +N -M diff 尾标（zcode 图 2「+199」形态）', () => {
    render(
      <ToolCard
        name="edit"
        summary="edit(src/a.ts)"
        status="ok"
        diff={'+++ a\n--- b\n+新增\n+再增\n-删除'}
      />
    )
    expect(screen.getByText('+2')).toBeInTheDocument()
    expect(screen.getByText('-1')).toBeInTheDocument()
  })

  it('MCP 工具主文案显示 server.tool（裸工具名无识别量）', () => {
    render(
      <ToolCard
        name="mcp__image_search__search_image"
        summary="mcp__image_search__search_image(cat)"
        status="ok"
      />
    )
    expect(screen.getByText('已调用')).toBeInTheDocument()
    expect(screen.getByText('image_search.search_image')).toBeInTheDocument()
  })

  it('拒绝：置灰单行 + 「已拒绝」尾词', () => {
    render(<ToolCard name="write" summary="write(a.ts)" status="blocked" />)
    expect(screen.getByText('已写入')).toBeInTheDocument()
    expect(screen.getByText('已拒绝')).toBeInTheDocument()
  })
})

describe('ToolCard 失败态（§3.3：不红整行，行尾状态词 + hover Tooltip）', () => {
  it('整行无 data-status=error（不变红），行尾「执行失败」可悬停', () => {
    const { container } = render(
      <ToolCard name="write" summary="write(a.ts)" status="error" result="文件已被修改" />
    )
    expect(container.querySelector('[data-status="error"]')).toBeNull()
    expect(screen.getByText('已写入')).toBeInTheDocument()
    expect(screen.getByText('执行失败')).toBeInTheDocument()
  })

  it('hover「执行失败」出 Tooltip 显示失败原因', async () => {
    const user = userEvent.setup()
    render(
      <ToolCard name="write" summary="write(a.ts)" status="error" result="文件已被修改，请重读" />
    )
    await user.hover(screen.getByText('执行失败'))
    expect(await screen.findByText('文件已被修改，请重读')).toBeInTheDocument()
  })

  it('失败无原因（result 缺失）：退化为纯状态词，无悬停语义', () => {
    const { container } = render(<ToolCard name="write" summary="write(a.ts)" status="error" />)
    expect(screen.getByText('执行失败')).toBeInTheDocument()
    expect(container.querySelector('.cursor-help')).toBeNull()
  })
})

describe('ToolCard bash 进度尾行（§3.4 定高两行槽）', () => {
  it('运行中且有 progress：尾部快照恒两行（不足补空 —— 行数翻动不推挤下方）', () => {
    const { container } = render(
      <ToolCard
        name="powershell"
        summary="powershell(npm test)"
        status="running"
        progress={'只有一行输出'}
      />
    )
    const tail = container.querySelector('.font-mono.text-\\[11px\\]')
    expect(tail).not.toBeNull()
    expect(tail?.children).toHaveLength(2)
  })
})
