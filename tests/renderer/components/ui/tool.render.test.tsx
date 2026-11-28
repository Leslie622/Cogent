/**
 * ToolCard 渲染测试（docs/模块/消息呈现.md 验收钉）：
 * - 头行结构：固定类别词 + 主文案 + diff 尾标；运行中 data-status=running（扫光
 *   由 CSS 带出）且无「执行中」尾词；ok 无状态词；
 * - 失败：行尾「执行失败」+ 整行不变红（TraceLine 无 data-status=error），
 *   hover 出 Tooltip 看原因（zcode 图 2 形态）；
 * - bash 运行中进度尾行定高两行槽；审批以图标呈现，授权与执行结果相互独立。
 * 折叠体 keepMounted 收起常驻（trace.render.test.tsx 钉）；简洁模式移除详情，
 * 切回详细可继续查看原来的展开内容。
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolCard } from '@/components/ui/tool'
import { useAppearanceStore } from '@/stores/appearance'

afterEach(() => {
  cleanup()
  useAppearanceStore.getState().setOutputVerbosity('high')
  localStorage.removeItem('cogent-appearance')
})

describe('ToolCard 头行结构（类别词 + 主文案 + 尾标）', () => {
  it('运行中：固定类别词 + data-status=running，无「执行中」尾词（扫光即信号）', () => {
    const { container } = render(
      <ToolCard name="read" summary="read(src/a.ts)" status="running" />
    )
    expect(screen.getByText('读取')).toBeInTheDocument()
    expect(screen.getByText('src/a.ts')).toBeInTheDocument()
    expect(container.querySelector('[data-status="running"]')).not.toBeNull()
    expect(screen.queryByText('执行中')).not.toBeInTheDocument()
  })

  it('完成：类别词保持不变，无运行扫光或状态尾词', () => {
    render(<ToolCard name="read" summary="read(src/a.ts)" status="ok" />)
    expect(screen.getByText('读取')).toBeInTheDocument()
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

  it('MCP 工具主文案显示 server · tool（裸工具名无识别量）', () => {
    render(
      <ToolCard
        name="mcp__image_search__search_image"
        summary="mcp__image_search__search_image(cat)"
        status="ok"
      />
    )
    expect(screen.getByText('MCP')).toBeInTheDocument()
    expect(screen.getByText('image_search · search_image')).toBeInTheDocument()
  })

  it('拒绝：置灰单行 + 「已拒绝」尾词', () => {
    render(<ToolCard name="write" summary="write(a.ts)" status="blocked" />)
    expect(screen.getByText('写入')).toBeInTheDocument()
    expect(screen.getByText('已拒绝')).toBeInTheDocument()
  })
})

describe('ToolCard 失败态（§3.3：不红整行，行尾状态词 + hover Tooltip）', () => {
  it('整行无 data-status=error（不变红），行尾「执行失败」可悬停', () => {
    const { container } = render(
      <ToolCard name="write" summary="write(a.ts)" status="error" result="文件已被修改" />
    )
    expect(container.querySelector('[data-status="error"]')).toBeNull()
    expect(screen.getByText('写入')).toBeInTheDocument()
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
    const { rerender } = render(
      <ToolCard
        name="powershell"
        summary="powershell(npm test)"
        status="running"
        progress={'只有一行输出'}
      />
    )
    const tail = screen.getByText('只有一行输出').parentElement
    expect(tail).not.toBeNull()
    expect(tail?.children).toHaveLength(2)
    rerender(<ToolCard name="powershell" summary="powershell(npm test)" status="running" progress={'旧行\n倒数第二行\n最后一行'} />)
    expect(screen.queryByText('旧行')).not.toBeInTheDocument()
    expect(screen.getByText('最后一行').parentElement?.children).toHaveLength(2)
  })
})

describe('ToolCard 输出详细程度', () => {
  it('简洁档移除已展开详情、参数和 diff 计数；切回详细仍可查看原内容', async () => {
    const user = userEvent.setup()
    const { container } = render(<ToolCard
      name="edit" summary="edit(src/private.ts)" status="ok"
      result="详细输出" diff={'+新增内容\n-旧内容'}
    />)
    await user.click(screen.getByRole('button', { name: /编辑/ }))
    expect(screen.getByText('详细输出')).toBeVisible()
    act(() => useAppearanceStore.getState().setOutputVerbosity('low'))
    expect(screen.getByText('编辑')).toBeVisible()
    expect(screen.getByText('edit')).toBeVisible()
    expect(screen.queryByText('src/private.ts')).not.toBeInTheDocument()
    expect(screen.queryByText('详细输出')).not.toBeInTheDocument()
    expect(screen.queryByText('+新增内容')).not.toBeInTheDocument()
    expect(screen.queryByText('+1')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(container.querySelector('[data-slot="trace-collapsible-content"]')).toBeNull()
    act(() => useAppearanceStore.getState().setOutputVerbosity('high'))
    expect(screen.getByText('src/private.ts')).toBeVisible()
    expect(screen.getByText('详细输出')).toBeVisible()
  })

  it('简洁档运行中保留状态扫光和工具名，隐藏命令 / 输出尾行', () => {
    useAppearanceStore.getState().setOutputVerbosity('low')
    const { container } = render(<ToolCard
      name="powershell" summary="powershell(secret-command)" status="running" progress="具体输出" approval="approved"
    />)
    expect(screen.getByText('终端')).toBeVisible()
    expect(screen.getByText('powershell')).toBeVisible()
    expect(screen.getByRole('img', { name: '已允许' })).toBeVisible()
    expect(container.querySelector('[data-status="running"]')).not.toBeNull()
    expect(screen.queryByText('secret-command')).not.toBeInTheDocument()
    expect(screen.queryByText('具体输出')).not.toBeInTheDocument()
  })

  it('简洁档保留失败 / 拒绝状态和 MCP 身份，不提供具体错误的悬停入口', () => {
    useAppearanceStore.getState().setOutputVerbosity('low')
    const { container } = render(<>
      <ToolCard name="write" summary="write(private.ts)" status="error" result="具体失败原因" />
      <ToolCard name="mcp__search__query" summary="mcp__search__query(secret)" status="blocked" />
    </>)
    expect(screen.getByText('执行失败')).toBeVisible()
    expect(screen.getByText('已拒绝')).toBeVisible()
    expect(screen.getByText('search · query')).toBeVisible()
    expect(container.querySelector('.cursor-help')).toBeNull()
    expect(screen.queryByText('具体失败原因')).not.toBeInTheDocument()
    expect(screen.queryByText('private.ts')).not.toBeInTheDocument()
  })
})

describe('ToolCard 类别与审批结果分离', () => {
  it.each(['running', 'ok', 'error', 'blocked'] as const)('终端在 %s 态保持固定分类', (status) => {
    const { container } = render(<ToolCard name="powershell" summary="powershell(Get-ComputerInfo)" status={status} />)
    expect(screen.getByText('终端')).toBeVisible()
    expect(container.querySelector('[data-status="running"]') !== null).toBe(status === 'running')
    expect(screen.queryByText(/正在执行|执行命令/)).not.toBeInTheDocument()
  })

  it('允许结果只用图标呈现，悬停可读；已允许的命令仍可执行失败', async () => {
    const user = userEvent.setup()
    render(<ToolCard name="powershell" summary="powershell(exit 1)" status="error" approval="approved" />)
    expect(screen.queryByText('已允许')).not.toBeInTheDocument()
    expect(screen.getByText('执行失败')).toBeVisible()
    await user.hover(screen.getByRole('img', { name: '已允许' }))
    expect(await screen.findByText('已允许')).toBeVisible()
  })
})
