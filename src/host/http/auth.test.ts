/**
 * 鉴权域单测：票据 store 的 TTL/即焚/重放语义 + 长期 token 的 HMAC
 * 签发/验签/篡改。时钟与随机源都走注入，钉行为不靠真实 sleep。
 */
import { describe, expect, it } from 'vitest'
import {
  SCOPE_RANK,
  createCapabilityStore,
  createRootSecret,
  signToken,
  verifyToken
} from './auth'

describe('capability store（一次性票据）', () => {
  it('issue → consume 首次命中返回 scope', () => {
    const store = createCapabilityStore({ createTicket: () => 't1' })
    const issued = store.issue('write')
    expect(issued.ticket).toBe('t1')
    expect(issued.scope).toBe('write')
    expect(store.consume('t1')).toBe('write')
  })

  it('消费即焚：同一票据第二次 consume 为 null（防重放）', () => {
    const store = createCapabilityStore({ createTicket: () => 't1' })
    store.issue('readonly')
    expect(store.consume('t1')).toBe('readonly')
    expect(store.consume('t1')).toBeNull()
  })

  it('TTL 过期即作废', () => {
    let clock = 1000
    const store = createCapabilityStore({ now: () => clock, ttlMs: 30_000 })
    const { ticket } = store.issue('admin')
    clock += 30_001
    expect(store.consume(ticket)).toBeNull()
  })

  it('伪造票据 consume 为 null', () => {
    const store = createCapabilityStore()
    expect(store.consume('no-such-ticket')).toBeNull()
    expect(store.consume(undefined)).toBeNull()
  })

  it('过期票据在后续 issue 时被清出（不随时间累积）', () => {
    let clock = 0
    let seq = 0
    const store = createCapabilityStore({
      now: () => clock,
      createTicket: () => `t${++seq}`
    })
    store.issue('readonly')
    clock = 100_000
    store.issue('readonly')
    // 内部 Map 只剩第二张票据 —— 通过行为侧证：第一张即使时钟回拨也换不到
    clock = 0
    expect(store.consume('t1')).toBeNull()
  })
})

describe('长期 token（无状态 HMAC）', () => {
  it('sign → verify 返回 scope', () => {
    const secret = createRootSecret()
    const token = signToken(secret, 'write')
    expect(verifyToken(secret, token)).toBe('write')
  })

  it('错 rootSecret（Host 重启后）验签失败', () => {
    const token = signToken(createRootSecret(), 'admin')
    expect(verifyToken(createRootSecret(), token)).toBeNull()
  })

  it('篡改 payload 或签名任一段都失败', () => {
    const secret = createRootSecret()
    const token = signToken(secret, 'readonly')
    const [v, payload, sig] = token.split('.')
    // 篡改 scope 声明（readonly → admin）签名不变
    const forgedPayload = Buffer.from(JSON.stringify({ s: 'admin', i: 0 }), 'utf8').toString('base64url')
    expect(verifyToken(secret, `${v}.${forgedPayload}.${sig}`)).toBeNull()
    // 篡改签名
    expect(verifyToken(secret, `${v}.${payload}.${sig.slice(0, -2)}aa`)).toBeNull()
  })

  it('垃圾格式 / 缺 token 均 null', () => {
    const secret = createRootSecret()
    expect(verifyToken(secret, 'not-a-token')).toBeNull()
    expect(verifyToken(secret, 'v1.only-two')).toBeNull()
    expect(verifyToken(secret, undefined)).toBeNull()
  })

  it('scope 层级：readonly ⊂ write ⊂ admin', () => {
    expect(SCOPE_RANK.readonly).toBeLessThan(SCOPE_RANK.write)
    expect(SCOPE_RANK.write).toBeLessThan(SCOPE_RANK.admin)
  })
})
