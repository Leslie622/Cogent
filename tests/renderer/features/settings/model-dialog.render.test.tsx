/** 模型对话框：输入声明、目录无损回显、Off 禁用、家族预设、协议映射与保存校验。 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelDialog } from '@/features/settings/ModelDialog'
import type { ModelDef, ModelSummary } from '@/env.d'

afterEach(cleanup)

const visionModel: ModelSummary = {
  id: 'vision-model',
  name: '视觉模型',
  provider: 'mock',
  input: ['text', 'image'],
  reasoning: false,
  thinkingLevels: ['off'],
  contextWindow: 128000,
  maxTokens: 4096
}

const reasonerModel: ModelSummary = {
  id: 'deepseek-v4-pro',
  name: 'DeepSeek V4 Pro',
  provider: 'deepseek',
  input: ['text'],
  reasoning: true,
  thinkingLevels: ['off', 'low', 'high', 'max'],
  thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high', max: 'max' },
  contextWindow: 1000000,
  maxTokens: 384000
}

const catalog = new Map([
  [visionModel.id, visionModel],
  [reasonerModel.id, reasonerModel]
])

describe('模型输入声明与思考档位编辑', () => {
  it('继承目录 image 回显，关闭后明确保存 text', () => {
    const save = vi.fn<(def: ModelDef, original: string | null) => void>()
    render(<ModelDialog open onClose={() => {}} initial={{ id: visionModel.id }} catalog={catalog} onSave={save} />)
    expect(screen.getByRole('switch', { name: '支持图片输入' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('switch', { name: '支持图片输入' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(save.mock.calls[0][0].input).toEqual(['text'])
  })

  it('显式 text 覆盖优先于目录 image', () => {
    render(<ModelDialog open onClose={() => {}} initial={{ id: visionModel.id, input: ['text'] }} catalog={catalog} onSave={() => {}} />)
    expect(screen.getByRole('switch', { name: '支持图片输入' })).toHaveAttribute('aria-checked', 'false')
  })

  it('编辑内置推理模型无损回显真实思考档位，不丢失 Max / Low / High', () => {
    const save = vi.fn<(def: ModelDef, original: string | null) => void>()
    render(<ModelDialog open onClose={() => {}} initial={{ id: reasonerModel.id, reasoning: true }} catalog={catalog} onSave={save} />)

    fireEvent.click(screen.getByRole('tab', { name: '思考配置' }))
    expect(screen.getByRole('switch', { name: '允许 Off 档位' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('button', { name: 'Minimal' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Low' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Medium' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'High' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Max' })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(save.mock.calls[0][0].thinkingLevelMap).toEqual({
      minimal: null,
      low: 'low',
      medium: null,
      high: 'high',
      xhigh: null,
      max: 'max'
    })
  })

  it('新增自定义模型开启思考默认禁 Minimal，支持取消 Off 并在无思考档时阻止保存', async () => {
    const user = userEvent.setup()
    const save = vi.fn<(def: ModelDef, original: string | null) => void>()
    render(<ModelDialog open onClose={() => {}} initial={null} catalog={new Map()} apiFormat="openai-responses" onSave={save} />)

    fireEvent.change(screen.getByPlaceholderText(/deepseek-v4-pro/), { target: { value: 'my-o3' } })
    fireEvent.click(screen.getByRole('tab', { name: '思考配置' }))
    fireEvent.click(screen.getByRole('switch', { name: '支持思考' }))

    expect(screen.getByRole('switch', { name: '允许 Off 档位' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('button', { name: 'Minimal' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Low' })).toHaveAttribute('aria-pressed', 'true')

    // 关闭「允许关闭思考」→ 保存 off: null
    fireEvent.click(screen.getByRole('switch', { name: '允许 Off 档位' }))
    expect(screen.getByRole('switch', { name: '允许 Off 档位' })).toHaveAttribute('aria-checked', 'false')

    // 取消全部非 Off 档 → 阻止保存
    fireEvent.click(screen.getByRole('button', { name: 'Low' }))
    fireEvent.click(screen.getByRole('button', { name: 'Medium' }))
    fireEvent.click(screen.getByRole('button', { name: 'High' }))
    expect(screen.getByText(/请至少启用一个思考档位/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()

    // 套用 Always On 预设恢复 Low/Medium/High 并禁 Off
    await user.click(screen.getByRole('combobox', { name: '档位预设' }))
    await user.click(await screen.findByRole('option', { name: 'Always On' }))
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(save.mock.calls[0][0].thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: null,
      max: null
    })
  })

  it('新建命中主流家族 ID（o3-mini）自动预填禁 Off 档位与上下文', () => {
    const save = vi.fn<(def: ModelDef, original: string | null) => void>()
    render(<ModelDialog open onClose={() => {}} initial={null} catalog={new Map()} apiFormat="openai-responses" onSave={save} />)

    const idInput = screen.getByPlaceholderText(/deepseek-v4-pro/)
    fireEvent.change(idInput, { target: { value: 'o3-mini' } })
    fireEvent.blur(idInput)

    fireEvent.click(screen.getByRole('tab', { name: '思考配置' }))
    expect(screen.getByRole('switch', { name: '支持思考' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('switch', { name: '允许 Off 档位' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('button', { name: 'Low' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(save.mock.calls[0][0].thinkingLevelMap?.off).toBeNull()
  })

  it('跨页签保留输出、协议映射、预算和兼容草稿，并通过原保存入口提交', async () => {
    const user = userEvent.setup()
    const save = vi.fn<(def: ModelDef, original: string | null) => void>()
    render(<ModelDialog open onClose={() => {}} initial={{ id: reasonerModel.id }} catalog={catalog} apiFormat="openai-completions" onSave={save} />)

    fireEvent.change(screen.getByRole('textbox', { name: '最大输出 Token' }), { target: { value: '12288' } })
    fireEvent.click(screen.getByRole('tab', { name: '思考配置' }))
    fireEvent.click(screen.getByRole('button', { name: '高级设置' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Off 协议值' }), { target: { value: 'none' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'High 思考预算' }), { target: { value: '6000' } })

    fireEvent.click(screen.getByRole('tab', { name: '端点兼容' }))
    await user.click(screen.getByRole('combobox', { name: '最大输出字段' }))
    await user.click(await screen.findByRole('option', { name: 'max_tokens' }))
    fireEvent.click(within(screen.getByRole('group', { name: 'Developer Role' })).getByRole('button', { name: '关闭' }))

    fireEvent.click(screen.getByRole('tab', { name: '基础设置' }))
    expect(screen.getByRole('textbox', { name: '最大输出 Token' })).toHaveValue('12288')
    fireEvent.click(screen.getByRole('tab', { name: '思考配置' }))
    expect(screen.getByRole('textbox', { name: 'Off 协议值' })).toHaveValue('none')
    expect(screen.getByRole('textbox', { name: 'High 思考预算' })).toHaveValue('6000')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(save.mock.calls[0][0]).toMatchObject({
      contextWindow: 1000000,
      maxTokens: 12288,
      thinkingLevelMap: { off: 'none', low: 'low', high: 'high', max: 'max' },
      thinkingBudgets: { high: 6000 },
      compat: { maxTokensField: 'max_tokens', supportsDeveloperRole: false },
    })
  })
})
