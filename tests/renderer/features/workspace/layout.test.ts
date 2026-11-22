import { describe, expect, it } from 'vitest'
import { resizeWorkspace, workspaceWidth } from '@/features/workspace/layout'

describe('工作区手动分栏', () => {
  it('跨原有900px断点仍并排，缩窗不主动占满或折叠', () => {
    for (const contentWidth of [1100, 900, 899, 700, 350]) {
      const width = workspaceWidth(contentWidth, false, false, 480)
      expect(width).toBeGreaterThan(0)
      expect(contentWidth - width).toBeGreaterThanOrEqual(160)
    }
    expect(workspaceWidth(1100, false, false, 480)).toBe(480)
    expect(workspaceWidth(700, false, false, 480)).toBe(480)
    expect(workspaceWidth(350, false, false, 480)).toBe(190)
  })
  it('只有显式占满才使用整个内容区，关闭时不占宽', () => {
    expect(workspaceWidth(700, false, true, 480)).toBe(700)
    expect(workspaceWidth(700, true, true, 480)).toBe(0)
  })
  it('可以连续拖窄到160px，越过门槛才折叠', () => {
    expect(resizeWorkspace(1100, 200)).toEqual({ width: 200 })
    expect(resizeWorkspace(1100, 160)).toEqual({ width: 160 })
    expect(resizeWorkspace(1100, 159)).toEqual({ collapsed: true })
  })
  it('很小视口的临时裁剪不写入不可恢复的宽度', () => {
    expect(resizeWorkspace(210, 300)).toEqual({ width: 160 })
    expect(workspaceWidth(1100, false, false, 480)).toBe(480)
  })
})
