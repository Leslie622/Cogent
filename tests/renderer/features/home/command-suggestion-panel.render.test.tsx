/** CommandSuggestionPanel 吸顶分组头结构回归：吸顶头的 containing block 必须覆盖整张列表。 */
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CommandSuggestionPanel } from '@/features/home/composer/CommandSuggestionPanel'
import type { ComposerSuggestionItem } from '@/features/home/composer/types'

// jsdom 没有 matchMedia / Element.scrollTo；面板键盘导航滚动用到，空转即可
vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }))
Element.prototype.scrollTo = () => {}

const command = (id: string, label: string): ComposerSuggestionItem => ({
  id,
  group: 'command',
  label,
  description: `${label} 说明`,
  keywords: [],
  payload: {
    kind: 'command',
    command: {
      id,
      label,
      description: `${label} 说明`,
      keywords: [],
      execution: { kind: 'prompt', name: 'init' }
    }
  }
})

const skill = (id: string, name: string): ComposerSuggestionItem => ({
  id,
  group: 'skill',
  label: name,
  description: `${name} 说明`,
  keywords: [],
  payload: { kind: 'skill', name, scope: 'user' }
})

const noop = (): void => {}
const props = {
  selectedIndex: 0,
  selectionSource: 'pointer' as const,
  onSelectIndex: noop,
  onPick: noop
}

describe('CommandSuggestionPanel 吸顶分组头', () => {
  it('吸顶头平铺在列表流容器上，containing block 覆盖两组行', () => {
    const items = [command('c1', '/compact'), command('c2', '/continue'), skill('s1', '总结'), skill('s2', '翻译')]
    const { container } = render(
      <CommandSuggestionPanel triggerKind="/" items={items} {...props} />
    )
    const headers = Array.from(container.querySelectorAll('[data-composer-group-header]'))
    expect(headers.map((el) => el.textContent)).toEqual(['命令', '技能'])
    expect(headers.every((el) => el.classList.contains('sticky'))).toBe(true)

    // 两枚吸顶头挂在同一个列表流容器上，且该容器同时是命令行与技能行的祖先：
    // 技能头的 containing block 覆盖命令组，前一组滚到底时后一组头部滑入直接交接，不再有空窗。
    const commandRow = container.querySelector('[data-suggestion-item="c1"]') as HTMLElement
    const skillRow = container.querySelector('[data-suggestion-item="s1"]') as HTMLElement
    const commandHeader = headers[0] as HTMLElement
    const skillHeader = headers[1] as HTMLElement
    const flow = commandHeader.parentElement
    expect(flow).not.toBeNull()
    expect(skillHeader.parentElement).toBe(flow)
    expect(flow?.contains(commandRow)).toBe(true)
    expect(flow?.contains(skillRow)).toBe(true)
    // 吸顶头不再包在各自行分组容器里
    expect(commandRow.parentElement?.contains(commandHeader)).toBe(false)
    expect(skillRow.parentElement?.contains(skillHeader)).toBe(false)
  })

  it('$ 触发只显技能组时不渲染吸顶头', () => {
    const { container } = render(
      <CommandSuggestionPanel triggerKind="$" items={[skill('s1', '总结')]} {...props} />
    )
    expect(container.querySelectorAll('[data-composer-group-header]')).toHaveLength(0)
    expect(container.querySelector('[data-suggestion-item="s1"]')).not.toBeNull()
  })
})
