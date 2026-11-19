/** 使用真实 Base UI 菜单，回归展开时的分组上下文与模型输入声明。 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { ProviderModelRow } from '@/features/settings/ProviderModelRow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelSummary } from '@/env.d'
import { ModelMenu } from '@/features/home/ModelMenu'
import { useEngineStore } from '@/stores/engine'

// 品牌图形与菜单上下文无关；保留真实菜单原语，隔离图标库的全量加载。
vi.mock('@/components/ProviderLogo', () => ({ ProviderLogo: () => null }))

const initialEngine = { ...useEngineStore.getState() }
const previousCogent = window.cogent
const model: ModelSummary = {
  id: 'test-model', name: '测试模型', provider: 'custom/test',
  input: ['text'], reasoning: true, thinkingLevels: ['off', 'high'],
  contextWindow: 128_000, maxTokens: 4096
}

beforeEach(() => {
  useEngineStore.setState(initialEngine, true)
  useEngineStore.setState({
    models: [model], keyConfigured: { [model.provider]: true },
    activeModelId: model.id, activeProviderId: model.provider, thinkingLevel: 'off'
  })
  window.cogent = { ...previousCogent, saveSettings: vi.fn().mockResolvedValue({ ok: true }) }
})

afterEach(() => {
  useEngineStore.setState(initialEngine, true)
  window.cogent = previousCogent
})

describe('输入框模型菜单', () => {
  it.each([
    { input: ['text'] as ModelSummary['input'] },
    { input: ['text', 'image'] as ModelSummary['input'] }
  ])('只用视觉标签表达图片能力，保留模型与思考力度分组（$input）', ({ input }) => {
    useEngineStore.setState({ models: [{ ...model, input }] })
    render(<ModelMenu />)
    fireEvent.click(screen.getByRole('button', { name: `选择模型：${model.id}` }))

    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.queryByText(/输入：|模型声明/)).not.toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: new RegExp(model.id) })).toBeInTheDocument()
    expect(screen.queryByText('视觉') !== null).toBe(input?.includes('image') === true)
    expect(screen.getByRole('group', { name: '思考力度关闭' })).toBeInTheDocument()
  })

  it('模型设置行和展开菜单共用有效能力，关闭后标签立即消失', () => {
    useEngineStore.setState({ models: [{ ...model, input: ['text', 'image'] }] })
    render(<><ProviderModelRow providerId={model.provider} def={{ id: model.id }} enabled onEdit={() => {}} onToggle={() => {}} /><ModelMenu /></>)
    fireEvent.click(screen.getByRole('button', { name: `选择模型：${model.id}` }))
    expect(screen.getAllByText('视觉')).toHaveLength(2)
    act(() => { useEngineStore.setState({ models: [{ ...model, input: ['text'] }] }) })
    expect(screen.queryByText('视觉')).not.toBeInTheDocument()
  })

  it('未配置模型时仍能正常展开菜单', () => {
    useEngineStore.setState({ models: [], keyConfigured: {}, activeModelId: '', activeProviderId: null })
    render(<ModelMenu />)
    fireEvent.click(screen.getByRole('button', { name: '选择模型' }))

    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.queryByText(/输入：|模型声明/)).not.toBeInTheDocument()
  })
})
