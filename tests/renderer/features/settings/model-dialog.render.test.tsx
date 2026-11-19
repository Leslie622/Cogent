/** 图片声明必须回显并能显式关闭，不能省略后又继承目录 image。 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelDialog } from '@/features/settings/ModelDialog'
import type { ModelDef, ModelSummary } from '@/env.d'

afterEach(cleanup)
const model: ModelSummary = { id: 'vision-model', name: '视觉模型', provider: 'mock', input: ['text', 'image'],
  reasoning: false, thinkingLevels: ['off'], contextWindow: 128000, maxTokens: 4096 }
const catalog = new Map([[model.id, model]])
describe('模型输入声明', () => {
  it('继承目录 image 回显，关闭后明确保存 text', () => {
    const save = vi.fn<(def: ModelDef, original: string | null) => void>()
    render(<ModelDialog open onClose={() => {}} initial={{ id: model.id }} catalog={catalog} onSave={save} />)
    expect(screen.getByRole('button', { name: '图片' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: '图片' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(save.mock.calls[0][0].input).toEqual(['text'])
  })
  it('显式 text 覆盖优先于目录 image', () => {
    render(<ModelDialog open onClose={() => {}} initial={{ id: model.id, input: ['text'] }} catalog={catalog} onSave={() => {}} />)
    expect(screen.getByRole('button', { name: '图片' })).toHaveAttribute('aria-pressed', 'false')
  })
})
