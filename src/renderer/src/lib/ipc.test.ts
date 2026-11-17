/**
 * unwrapIpcError 单测（2026-11-17 会话状态重构 P3 随迁 lib/ipc.ts）：钉
 * Electron invoke 前缀的剥壳形状 —— 前缀变体（带/不带内层 Error:）剥净、
 * 协议自身消息不误伤、非 Error 输入降级 String()。
 */
import { describe, expect, it } from 'vitest'
import { unwrapIpcError } from './ipc'

describe('unwrapIpcError', () => {
  it('剥掉 Electron 统一前缀（带 "Error: " 内层）', () => {
    expect(unwrapIpcError(new Error("Error invoking remote method 'engine:request': Error: 会话正在回复中，请先停止或等待完成"))).toBe(
      '会话正在回复中，请先停止或等待完成'
    )
  })
  it('不带内层 "Error: " 的形态同样剥', () => {
    expect(unwrapIpcError(new Error("Error invoking remote method 'engine:request': InvalidParams: x"))).toBe('InvalidParams: x')
  })
  it('协议自身的错误消息原样保留（无前缀不误伤）', () => {
    expect(unwrapIpcError(new Error('会话正在回复中'))).toBe('会话正在回复中')
  })
  it('非 Error 输入走 String()', () => {
    expect(unwrapIpcError(42)).toBe('42')
  })
})
