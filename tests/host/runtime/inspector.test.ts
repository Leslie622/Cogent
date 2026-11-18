/**
 * SessionInspector 审批审计对单测（钩子座 4d，docs/模块/钩子座.md）。
 * 钉三件事：裁决词呈现映射（VERDICT_LABELS，缺词回退不炸）、asked/decided
 * 的 requestId 详情块可配对、reason/概览的形状。判定路径的接线（哪条分支落
 * 哪个词、read 域外零条目）由 tests/integration/approval-upgrade.test.ts S8
 * 黑盒断言 —— 两层互补（同 session.test.ts / 集成的分层惯例）。
 */
import { describe, expect, it } from 'vitest'
import { SessionInspector } from '../../../src/host/runtime/inspector'

const newInspector = (): SessionInspector => new SessionInspector(() => {})

const asked = (over?: Partial<Parameters<SessionInspector['approvalAsked']>[0]>) => ({
  requestId: 'appr-test-1',
  toolName: 'write',
  kind: 'write',
  summary: 'write("a.txt")',
  mode: 'ask',
  outsideRoots: false,
  ...over
})

describe('SessionInspector 审批审计对', () => {
  it('详情环淘汰后明确报缺失，不能伪装成空详情；无详情条目仍可读取', () => {
    const insp = newInspector()
    insp.toolStarted('read', { path: 'first' })
    const first = insp.entries()[0]
    for (let i = 0; i < 150; i += 1) insp.toolStarted('read', { path: String(i) })
    expect(insp.entries()).toContain(first)
    expect(first.hasDetail).toBe(true)
    expect(insp.detail(first.seq)).toBeUndefined()
    insp.turnStarted()
    expect(insp.detail(insp.entries().at(-1)!.seq)).toEqual({ seq: 152, blocks: [] })
  })

  it('approvalAsked：kind/标题/概览齐全，根外仅在标记时出现，requestId 进详情块', () => {
    const insp = newInspector()
    insp.approvalAsked(asked())
    const entry = insp.entries().at(-1)
    expect(entry?.kind).toBe('approval.asked')
    expect(entry?.title).toContain('write')
    expect(entry?.overview).toEqual(
      expect.arrayContaining([
        { label: '类别', value: 'write' },
        { label: '摘要', value: 'write("a.txt")' },
        { label: '权限档', value: 'ask' }
      ])
    )
    expect(entry?.overview?.some((o) => o.label === '根外')).toBe(false)
    expect(insp.detail(entry!.seq)?.blocks[0]?.content).toBe('appr-test-1')

    insp.approvalAsked(asked({ outsideRoots: true }))
    expect(insp.entries().at(-1)?.overview).toEqual(expect.arrayContaining([{ label: '根外', value: '是' }]))
  })

  it('approvalDecided：九个裁决词全映射成呈现文案，未知词回退原词', () => {
    const insp = newInspector()
    const words: Array<[string, string]> = [
      ['plan', '拦截（计划模式）'],
      ['auto', '放行（auto 档）'],
      ['autonomous', '放行（自主档）'],
      ['always-workspace', '放行（工作区规则）'],
      ['user-allow', '用户允许'],
      ['user-deny', '用户拒绝'],
      ['always-workspace-user', '用户允许并记工作区规则'],
      ['aborted', '中止'],
      ['settled', '收尾']
    ]
    for (const [verdict, label] of words) {
      insp.approvalDecided({ toolName: 'bash', verdict })
      const entry = insp.entries().at(-1)
      expect(entry?.kind).toBe('approval.decided')
      expect(entry?.title).toContain(label)
      expect(entry?.overview).toEqual(expect.arrayContaining([{ label: '裁决', value: label }]))
    }
    insp.approvalDecided({ toolName: 'bash', verdict: 'future-word' })
    expect(insp.entries().at(-1)?.title).toContain('future-word')
  })

  it('配对与 reason：asked→decided 同 requestId 可在详情块对账；reason 截 120；快路无 requestId 无详情', () => {
    const insp = newInspector()
    insp.approvalAsked(asked({ requestId: 'appr-pair-9' }))
    insp.approvalDecided({ toolName: 'write', verdict: 'user-deny', requestId: 'appr-pair-9', reason: '用户拒绝了本次操作' })
    const [askedEntry, decidedEntry] = insp.entries().slice(-2)
    expect(insp.detail(askedEntry.seq)?.blocks[0]?.content).toBe('appr-pair-9')
    expect(insp.detail(decidedEntry.seq)?.blocks[0]?.content).toBe('appr-pair-9')
    expect(decidedEntry.overview).toEqual(expect.arrayContaining([{ label: '原因', value: '用户拒绝了本次操作' }]))

    insp.approvalDecided({ toolName: 'write', verdict: 'auto' })
    const fast = insp.entries().at(-1)
    expect(fast?.hasDetail).toBe(false)
    expect(insp.detail(fast!.seq)?.blocks).toEqual([])

    insp.approvalDecided({ toolName: 'write', verdict: 'user-deny', reason: 'x'.repeat(200) })
    expect(insp.entries().at(-1)?.overview?.find((o) => o.label === '原因')?.value.length).toBe(120)
  })
})
