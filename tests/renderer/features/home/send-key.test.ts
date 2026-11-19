/**
 * isSendKey 单元测试 —— 发送组合键按设置分流的行为契约（钉行为不是追数字）：
 * 选中组合发送、其余 Enter 组合换行（false）、IME 组词中恒不发送
 * （输入法确认键也是 Enter，不判 isComposing 会把组词当发送）。
 */
import { describe, expect, it, vi } from 'vitest'
import { isSendKey } from '@/features/home/HomeChat'

// 快捷键断言只依赖纯函数；页面主题在模块加载时读取matchMedia，交给主题自己的环境验证。
vi.mock('@/features/home/ChatTheme', () => ({ useChatTheme: () => ({}) }))

/** 最小事件形状（isSendKey 只读这四个字段） */
const key = (k: string, mods: { shift?: boolean; ctrl?: boolean; composing?: boolean } = {}) => ({
  key: k,
  shiftKey: mods.shift === true,
  ctrlKey: mods.ctrl === true,
  nativeEvent: { isComposing: mods.composing === true }
})

describe('isSendKey · enter 档（缺省，保持首发行为）', () => {
  it('Enter 发送、Shift+Enter 换行', () => {
    expect(isSendKey(key('Enter'), 'enter')).toBe(true)
    expect(isSendKey(key('Enter', { shift: true }), 'enter')).toBe(false)
  })
  it('Ctrl+Enter 同发（enter 档宽匹配 —— 首发行为如此，主流输入框惯例）', () => {
    expect(isSendKey(key('Enter', { ctrl: true }), 'enter')).toBe(true)
  })
})

describe('isSendKey · shift+enter 档', () => {
  it('Shift+Enter 发送、Enter 换行', () => {
    expect(isSendKey(key('Enter', { shift: true }), 'shift+enter')).toBe(true)
    expect(isSendKey(key('Enter'), 'shift+enter')).toBe(false)
  })
  it('Ctrl+Shift+Enter 跨档组合不发送（精确单键匹配）', () => {
    expect(isSendKey(key('Enter', { shift: true, ctrl: true }), 'shift+enter')).toBe(false)
  })
})

describe('isSendKey · ctrl+enter 档', () => {
  it('Ctrl+Enter 发送、Enter / Shift+Enter 换行', () => {
    expect(isSendKey(key('Enter', { ctrl: true }), 'ctrl+enter')).toBe(true)
    expect(isSendKey(key('Enter'), 'ctrl+enter')).toBe(false)
    expect(isSendKey(key('Enter', { shift: true }), 'ctrl+enter')).toBe(false)
  })
})

describe('isSendKey · 通用守卫（三档同规则）', () => {
  it.each(['enter', 'shift+enter', 'ctrl+enter'] as const)('%s 档：IME 组词中不发送', (shortcut) => {
    expect(
      isSendKey(key('Enter', { composing: true }), shortcut)
    ).toBe(false)
    expect(
      isSendKey(key('Enter', { shift: true, composing: true }), shortcut)
    ).toBe(false)
  })
  it.each(['enter', 'shift+enter', 'ctrl+enter'] as const)('%s 档：非 Enter 键不发送（key 精确匹配；小键盘 Enter 的 key 也是 "Enter"，同样走分流）', (shortcut) => {
    expect(isSendKey(key('a'), shortcut)).toBe(false)
    expect(isSendKey(key('Escape'), shortcut)).toBe(false)
  })
})
