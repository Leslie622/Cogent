/** 中断迁移的真源选择与原子重试；读历史/搜索不能把半份 pi 文件当作完整转录。 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { SessionManager as PiSessionManager } from '@earendil-works/pi-coding-agent'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { importLegacyTranscript } from '../../../src/host/kernel/legacy-import'
import { migrateLegacyTranscript, transcriptAuthority } from '../../../src/host/kernel/transcript-authority'
import { findPiTranscriptFile, piSessionDir, readPiTranscript } from '../../../src/host/kernel/transcript'
let root: string
const id = 'legacy-test'
const legacy: AgentMessage[] = [
  { role: 'user', content: '第一条', timestamp: 1000 },
  { role: 'user', content: '第二条不能丢', timestamp: 2000 }
]
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cogent-transcript-authority-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))
function seed(messages: AgentMessage[]) {
  const manager = PiSessionManager.create(root, piSessionDir(root, join(root, 'pi')), { id })
  importLegacyTranscript(manager, messages)
}
it('目标不存在、空前缀、严格前缀均保留完整旧历史，迁移可反复重试', () => {
  expect(transcriptAuthority(root, root, id, legacy).needsMigration).toBe(true)
  seed(legacy.slice(0, 1))
  expect(transcriptAuthority(root, root, id, legacy).messages).toHaveLength(2)
  migrateLegacyTranscript(root, root, id, legacy)
  expect(readPiTranscript(root, root, id)?.map(message => message.role === 'user' ? message.content : '')).toEqual(['第一条', '第二条不能丢'])
  const file = findPiTranscriptFile(root, root, id)!
  const before = readFileSync(file, 'utf8')
  migrateLegacyTranscript(root, root, id, legacy)
  expect(readFileSync(file, 'utf8')).toBe(before)
})
it('完整前缀后有新消息时保留新内容；分叉报冲突并保留两份', () => {
  seed([...legacy, { role: 'user', content: '迁移后的新消息', timestamp: 3000 }])
  expect(transcriptAuthority(root, root, id, legacy).needsMigration).toBe(false)
  expect(transcriptAuthority(root, root, id, legacy).messages).toHaveLength(3)
  const file = findPiTranscriptFile(root, root, id)!, before = readFileSync(file, 'utf8')
  const fork: AgentMessage[] = [legacy[0], { role: 'user', content: '不同分支', timestamp: 2000 }]
  expect(() => migrateLegacyTranscript(root, root, id, fork)).toThrow('分叉')
  expect(readFileSync(file, 'utf8')).toBe(before)
})
it('旧压缩记录转换后仍可确认完成，不因生成时间差误判分叉', () => {
  const messages: AgentMessage[] = [...legacy, { role: 'compactionSummary', summary: '摘要', tokensBefore: 100, timestamp: 4000 }]
  migrateLegacyTranscript(root, root, id, messages)
  expect(transcriptAuthority(root, root, id, messages).needsMigration).toBe(false)
})
