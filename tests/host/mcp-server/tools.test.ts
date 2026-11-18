/**
 * 对外 MCP 工具面单测：scope 过滤规则 + 默认 plan 档落点（钉行为：写组
 * 注册与否、planEnabled 兜底），不触 McpServer/网络 —— 端到端链路在
 * tests/integration/external-mcp.test.ts。
 */
import { describe, expect, it } from 'vitest'
import { createSessionParams, toolSpecs } from '../../../src/host/mcp-server/tools'

describe('toolSpecs：写组注册按凭据 scope 过滤', () => {
  it('write 档 = 只读 6 + 写组 8 全注册', () => {
    const names = toolSpecs('write').map((spec) => spec.name)
    expect(names).toContain('cogent_status')
    expect(names).toContain('cogent_session_submit')
    expect(names).toContain('cogent_approval_respond')
    expect(names).toHaveLength(14)
  })

  it('readonly 档 = 写组零注册（不是注册了拒调）', () => {
    const specs = toolSpecs('readonly')
    expect(specs.map((spec) => spec.name)).toEqual([
      'cogent_status',
      'cogent_projects_list',
      'cogent_sessions_list',
      'cogent_session_messages',
      'cogent_models_list',
      'cogent_inspect_entries'
    ])
    expect(specs.every((spec) => !spec.write)).toBe(true)
  })

  it('无凭据（null）也保只读组 —— tools/list 可用、业务调用报引导错误', () => {
    expect(toolSpecs(null).some((spec) => spec.write)).toBe(false)
    expect(toolSpecs(null).map((spec) => spec.name)).toContain('cogent_status')
  })
})

describe('createSessionParams：默认 plan 档（安全默认 + 放开显式）', () => {
  it('什么档都不传 → planEnabled: true（只读零挂起）', () => {
    expect(createSessionParams({})).toEqual({ planEnabled: true })
  })

  it('只传 title 等非档位字段 → 仍兜 planEnabled: true', () => {
    expect(createSessionParams({ title: 'x' })).toEqual({ title: 'x', planEnabled: true })
  })

  it('显式传 permissionMode = 调用方声明交互策略，不再兜计划档', () => {
    expect(createSessionParams({ permissionMode: 'auto' })).toEqual({ permissionMode: 'auto', planEnabled: false })
    expect(createSessionParams({ permissionMode: 'ask' })).toEqual({ permissionMode: 'ask', planEnabled: false })
  })

  it('显式 planEnabled 最优先（正交开关原样透传）', () => {
    expect(createSessionParams({ planEnabled: false })).toEqual({ planEnabled: false })
    expect(createSessionParams({ permissionMode: 'auto', planEnabled: true })).toEqual({
      permissionMode: 'auto',
      planEnabled: true
    })
  })
})
