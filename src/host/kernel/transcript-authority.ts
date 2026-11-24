/** 旧转录与 pi 转录共存时只认完整内容；历史、搜索、惰性迁移共用判定。 */
import { isDeepStrictEqual } from 'node:util'
import { mkdirSync, renameSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SessionManager as PiSessionManager } from '@earendil-works/pi-coding-agent'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { findPiTranscriptFile, legacyMessages, PI_AGENT_DIR_NAME, piSessionDir, readPiTranscript } from './transcript'
import { importLegacyTranscript } from './legacy-import'

function comparable(message: AgentMessage): unknown {
  if (message.role === 'compactionSummary') return { role: message.role, summary: message.summary, tokensBefore: message.tokensBefore }
  const { sourceId: _source, attachmentInput: _input, fileContext: _context, toolFileRefs: _refs, ...body } = message as AgentMessage & Record<string, unknown>
  return body
}
function importable(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter(message => ['system', 'user', 'assistant', 'toolResult', 'compactionSummary'].includes(message.role))
}
export function transcriptAuthority(cwd: string, root: string, id: string, legacy?: AgentMessage[]) {
  const pi = readPiTranscript(cwd, root, id)
  if (legacy === undefined) return { messages: pi ?? [], needsMigration: false }
  const old = importable(legacy)
  if (pi === undefined) return { messages: legacyMessages(old), needsMigration: true }
  const equalPrefix = pi.slice(0, old.length).every((message, index) => index < old.length && isDeepStrictEqual(comparable(message), comparable(old[index])))
  if (!equalPrefix) throw new Error(`旧转录与 pi 转录存在分叉，已保留两份，请先处理冲突（${id}）`)
  // pi 包含完整旧前缀并追加新消息是发布后摘要更新前的合法状态。
  return pi.length >= old.length ? { messages: pi, needsMigration: false } : { messages: legacyMessages(old), needsMigration: true }
}
export function migrateLegacyTranscript(cwd: string, root: string, id: string, legacy: AgentMessage[]): void {
  if (!transcriptAuthority(cwd, root, id, legacy).needsMigration) return
  const manager = PiSessionManager.inMemory(cwd)
  importLegacyTranscript(manager, legacy)
  const header = { ...manager.getHeader()!, id }
  const dir = piSessionDir(cwd, join(root, PI_AGENT_DIR_NAME))
  mkdirSync(dir, { recursive: true })
  const existing = findPiTranscriptFile(cwd, root, id)
  const target = existing ?? join(dir, `${header.timestamp.replace(/[:.]/g, '-')}_${id}.jsonl`)
  const stage = `${target}.${randomUUID()}.tmp`
  try {
    writeFileSync(stage, [header, ...manager.getEntries()].map(entry => JSON.stringify(entry)).join('\n') + '\n')
    // 全文在内存构建完成才发布；原 v1 留到调用方摘要提交成功，任一点中断都能重试。
    renameSync(stage, target)
  } finally { rmSync(stage, { force: true }) }
  if (transcriptAuthority(cwd, root, id, legacy).needsMigration) throw new Error('旧转录迁移发布校验失败')
}
