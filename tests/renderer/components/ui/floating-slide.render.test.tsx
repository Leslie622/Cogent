/** 浮层原语的滑动装配：Select / Combobox / Command 读外观「开启滑动动画」——开 = 行容器 + 胶囊、行打
 *  data-hover-slide 且原高亮类不动；关 = 不渲染任何额外节点。真实滑行由 Electron 探针验证。 */
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Command, CommandItem, CommandList } from '@/components/ui/command'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAppearanceStore } from '@/stores/appearance'

// cmdk 挂载时量列表尺寸并把选中项滚进视口：jsdom 没有 ResizeObserver / scrollIntoView
beforeEach(() => {
  Element.prototype.scrollIntoView = () => {}
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  useAppearanceStore.setState({ hoverSlide: true })
  vi.unstubAllGlobals()
})

describe('浮层原语的滑动装配', () => {
  it('Command：List 外包行容器，项带 data-hover-slide 且保留 data-[selected=true] 高亮类', () => {
    const { container } = render(
      <Command>
        <CommandList>
          <CommandItem>甲</CommandItem>
          <CommandItem>乙</CommandItem>
        </CommandList>
      </Command>,
    )
    const list = container.querySelector('[data-slot="command-list"]')!
    expect(list.querySelector('.hover-slide-pill')).not.toBeNull()
    expect(list.querySelectorAll('[data-hover-slide]')).toHaveLength(2)
    expect(screen.getByText('甲').closest('[data-slot="command-item"]')?.className).toContain('data-[selected=true]:bg-muted')
  })

  it('Select：打开的面板里有胶囊，选项带 data-hover-slide 且保留 focus:bg-accent 原类', () => {
    render(
      <Select items={[{ label: '甲', value: 'a' }, { label: '乙', value: 'b' }]} value="a" onValueChange={() => {}}>
        <SelectTrigger aria-label="档位">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">甲</SelectItem>
          <SelectItem value="b">乙</SelectItem>
        </SelectContent>
      </Select>,
    )
    fireEvent.click(screen.getByRole('combobox', { name: '档位' }))
    const listbox = screen.getByRole('listbox')
    expect(listbox.querySelector('.hover-slide-pill')).not.toBeNull()
    expect(listbox.querySelectorAll('[data-hover-slide]')).toHaveLength(2)
    expect(screen.getByRole('option', { name: '甲' }).className).toContain('focus:bg-accent')
  })

  it('外观「开启滑动动画」关闭：Command 不包行容器、项不打标记', () => {
    useAppearanceStore.setState({ hoverSlide: false })
    const { container } = render(
      <Command>
        <CommandList>
          <CommandItem>甲</CommandItem>
        </CommandList>
      </Command>,
    )
    expect(container.querySelector('.hover-slide-pill')).toBeNull()
    expect(container.querySelector('[data-hover-slide]')).toBeNull()
  })
})
