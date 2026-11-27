/** 方法访问控制单源表测试：确保网络 scope 与 renderer 白名单派生一致且特权方法不越界。 */
import { describe, expect, it } from 'vitest'
import { httpMethodMinScope, METHOD_ACCESS, rendererAllowedMethods } from '../../src/protocol'

describe('protocol/method-access', () => {
  it('宿主专属与敏感写方法不进入 renderer 通用代理白名单', () => {
    const allowed = rendererAllowedMethods()
    for (const restricted of [
      'host.shutdown',
      'initialize',
      'capability.issue',
      'approval.respond',
      'question.respond',
      'plan.respond',
      'credentials.set',
      'credentials.remove',
      'providers.custom.sync',
      'files.actionTarget',
      'fileViews.acquire',
      'skills.import',
      'skills.export',
      'skills.revealTarget'
    ]) {
      expect(allowed.has(restricted)).toBe(false)
    }
  })

  it('未声明 httpScope 的本地方法拒绝 HTTP/WS 访问，签发接口需要 admin', () => {
    expect(httpMethodMinScope('host.shutdown')).toBeUndefined()
    expect(httpMethodMinScope('files.resolve')).toBeUndefined()
    expect(httpMethodMinScope('changes.get')).toBeUndefined()
    expect(httpMethodMinScope('changes.diff')).toBeUndefined()
    expect(httpMethodMinScope('attachments.draft')).toBeUndefined()
    expect(rendererAllowedMethods().has('changes.get')).toBe(true)
    expect(rendererAllowedMethods().has('changes.diff')).toBe(true)
    expect(httpMethodMinScope('nonexistent.method')).toBeUndefined()
    expect(httpMethodMinScope('capability.issue')).toBe('admin')
    expect(httpMethodMinScope('session.list')).toBe('readonly')
    expect(httpMethodMinScope('agent.abort')).toBe('write')
    expect(Object.keys(METHOD_ACCESS).length).toBeGreaterThan(60)
  })
})
