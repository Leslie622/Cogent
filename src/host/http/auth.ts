/**
 * HTTP 门鉴权域（阶段 2b，D3 票据生命周期）：三件套纯逻辑，无 HTTP 依赖 ——
 *
 * 1. rootSecret：Host 启动生成、不持久化、**不出进程**（长期 token 的 HMAC
 *    材料；重启即重生成 = 全部 token 随 Host 进程生命周期失效）；
 * 2. capability store：一次性短 TTL 票据（zcode hostCapability 同构 + scope），
 *    消费即焚防重放 —— 无状态 HMAC 验签做不到这一点，票据必须带 store；
 * 3. 长期 token：无状态 HMAC 签名（不占 store，签名里带 scope），验证 =
 *    timingSafeEqual 恒时比较。
 *
 * 信任边界（约定.md §1.1「外部世界」行）：ticket / token 都是外部输入，
 * verify 失败统一返回 null 不细分原因（不给探测者信息），诊断走 stderr。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { TokenScope } from '../../protocol'

/** scope 层级：readonly ⊂ write ⊂ admin（数值比较即权限判定） */
export const SCOPE_RANK: Record<TokenScope, number> = { readonly: 0, write: 1, admin: 2 }

export function createRootSecret(): string {
  return randomBytes(32).toString('base64url')
}

// ———— 一次性票据 store（TTL + 消费即焚） ————

export const DEFAULT_TICKET_TTL_MS = 30_000

export interface IssuedTicket {
  ticket: string
  scope: TokenScope
  expiresAt: number
}

export interface CapabilityStoreOptions {
  ttlMs?: number
  now?: () => number
  /** 测试注入：默认 randomBytes(32) base64url */
  createTicket?: () => string
}

export interface CapabilityStore {
  issue(scope: TokenScope): IssuedTicket
  /** 命中且未过期 → 返回 scope 并即焚；过期/已用/伪造 → null（同样即焚） */
  consume(ticket: string | undefined): TokenScope | null
}

export function createCapabilityStore(options: CapabilityStoreOptions = {}): CapabilityStore {
  const ttlMs = options.ttlMs ?? DEFAULT_TICKET_TTL_MS
  const now = options.now ?? Date.now
  const createTicket = options.createTicket ?? (() => randomBytes(32).toString('base64url'))
  const entryByTicket = new Map<string, { scope: TokenScope; expiresAt: number }>()

  const purgeExpired = (at: number): void => {
    for (const [ticket, entry] of entryByTicket) {
      if (entry.expiresAt <= at) entryByTicket.delete(ticket)
    }
  }

  return {
    issue(scope) {
      const issuedAt = now()
      purgeExpired(issuedAt)
      const ticket = createTicket()
      const expiresAt = issuedAt + ttlMs
      entryByTicket.set(ticket, { scope, expiresAt })
      return { ticket, scope, expiresAt }
    },
    consume(ticket) {
      if (!ticket) return null
      const consumedAt = now()
      const entry = entryByTicket.get(ticket)
      // 无论成功、过期还是重放都先删：只有首次且 TTL 内的消费能换到 token
      entryByTicket.delete(ticket)
      purgeExpired(consumedAt)
      if (!entry || entry.expiresAt <= consumedAt) return null
      return entry.scope
    }
  }
}

// ———— 长期 token：无状态 HMAC ————

/** payload 只带 scope 与签发时刻：过期策略 = Host 进程生命周期（无 exp 字段） */
function sign(rootSecret: string, payload: string): string {
  return createHmac('sha256', rootSecret).update(payload).digest('base64url')
}

export function signToken(rootSecret: string, scope: TokenScope, now: number = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ s: scope, i: now }), 'utf8').toString('base64url')
  return `v1.${payload}.${sign(rootSecret, payload)}`
}

export function verifyToken(rootSecret: string, token: string | undefined): TokenScope | null {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') return null
  const [, payload, signature] = parts
  const expected = Buffer.from(sign(rootSecret, payload))
  const received = Buffer.from(signature)
  // 恒时比较前先比长度：timingSafeEqual 长度不等直接 throw
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    process.stderr.write('[host] token verify failed\n')
    return null
  }
  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { s?: unknown }
  return parsed.s === 'readonly' || parsed.s === 'write' || parsed.s === 'admin' ? parsed.s : null
}
