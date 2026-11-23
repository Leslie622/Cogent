/** 派生语料读取：目录身份由 Host 供给，文件指纹只决定重读，不把孤儿转录恢复成会话。 */
import { statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { findPiTranscriptFile, legacyMessages, readPiTranscript } from '../../kernel/transcript'
import { toChatMessages } from '../message-projection'
import type { MessageSource, SearchSession } from '../../../shared/session-search'

export interface SearchDescriptor { summary: SearchSession; cwd: string }
export interface SearchDocument { id: string; role: 'user' | 'assistant'; text: string; sources: MessageSource[] }
export interface SearchSource { revision: string; documents: SearchDocument[] }

export function locateSearchSource(root: string, descriptor: SearchDescriptor): { file: string; revision: string; pi: boolean } {
  const piFile = findPiTranscriptFile(descriptor.cwd, root, descriptor.summary.id)
  const file = piFile ?? join(root, 'sessions', `${descriptor.summary.id}.json`)
  const stat = statSync(file)
  return { file, revision: `${file}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`, pi: piFile !== undefined }
}

export function loadSearchSource(root: string, descriptor: SearchDescriptor, source: ReturnType<typeof locateSearchSource>): SearchSource {
  let messages
  if (source.pi) messages = readPiTranscript(descriptor.cwd, root, descriptor.summary.id)!
  else {
    const doc = JSON.parse(readFileSync(source.file, 'utf8')) as { version?: unknown; summary?: { id?: unknown }; transcript?: unknown }
    if (doc.summary?.id !== descriptor.summary.id || (doc.version !== 1 && doc.version !== 2)) throw new Error('会话摘要版本或身份损坏')
    if (doc.version === 1 && !Array.isArray(doc.transcript)) throw new Error('旧会话转录损坏')
    messages = doc.version === 1 ? legacyMessages(doc.transcript as AgentMessage[]) : []
  }
  const documents = toChatMessages(messages).filter((message) => message.role !== 'compaction').map((message) => ({
    id: message.id, role: message.role as 'user' | 'assistant',
    text: [message.content, ...(message.attachments ?? []).map((item) => item.name), ...(message.directories ?? []).map((item) => item.name)].join('\n').trimEnd(),
    sources: message.sources ?? []
  })).filter((document) => document.text !== '' && document.sources.length > 0)
  const after = locateSearchSource(root, descriptor)
  if (after.revision !== source.revision) throw new Error('转录正在更新，请重试搜索')
  return { revision: source.revision, documents }
}
