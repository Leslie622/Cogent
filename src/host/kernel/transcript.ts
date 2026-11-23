/** pi 转录只读适配：旧版本只在内存迁移，搜索与历史回查绝不重写真源。 */
import { join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { SessionManager as PiSessionManager, parseSessionEntries, type SessionEntry } from '@earendil-works/pi-coding-agent'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { Usage } from '@earendil-works/pi-ai'
import { isAttachmentRef, isDirectoryRef, type AttachmentRef, type DirectoryRef } from '../../shared/attachments'
import type { FileContext, FileReference } from '../../shared/files'

/** 只校验呈现消费的磁盘字段；其他内核消息仍由 pi 按原格式保留。 */
function validateSearchMessage(value: unknown): void {
  if (typeof value !== 'object' || value === null || !('role' in value) || typeof value.role !== 'string') throw new Error('转录消息缺少角色')
  if (value.role !== 'user' && value.role !== 'assistant') return
  if (!('timestamp' in value) || typeof value.timestamp !== 'number' || !('content' in value)) throw new Error('转录消息正文或时间损坏')
  if (value.role === 'user' && typeof value.content === 'string') return
  if (!Array.isArray(value.content)) throw new Error('转录消息内容块损坏')
  for (const block of value.content as unknown[]) {
    if (typeof block !== 'object' || block === null || !('type' in block) || typeof block.type !== 'string') throw new Error('转录内容块缺少类型')
    if (block.type === 'text' && (!('text' in block) || typeof block.text !== 'string')) throw new Error('转录文本块损坏')
    if (block.type === 'thinking' && (!('thinking' in block) || typeof block.thinking !== 'string')) throw new Error('转录思考块损坏')
  }
}

/** 完整行损坏直接报错；末尾并发追加中的半行交给下次稳定读取，不冒充完整转录。 */
export function readSessionBranch(file: string, cwd: string, expectedId?: string): SessionEntry[] {
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  for (const line of lines) {
    if (line.trim() === '') continue
    JSON.parse(line)
  }
  const entries = parseSessionEntries(text)
  const header = entries[0]
  if (entries.length === 0 || header.type !== 'session' || (header.version !== undefined && ![1, 2, 3].includes(header.version))) throw new Error('会话转录头或版本损坏')
  if (typeof header.id !== 'string' || (expectedId !== undefined && header.id !== expectedId)) throw new Error('转录会话身份损坏')
  const legacy = header.version === undefined || header.version < 2
  for (const entry of entries.slice(1)) {
    if (typeof entry.type !== 'string' || (!legacy && typeof entry.id !== 'string')) throw new Error('转录条目形状损坏')
    if (entry.type === 'message') validateSearchMessage(entry.message)
  }
  const originals = new Map(entries.map((entry, index) => [entry, index]))
  const branch = PiSessionManager.inMemory(cwd, undefined, entries).getBranch()
  if (legacy) {
    const revision = createHash('sha256').update(text).digest('hex')
    return branch.map((entry) => ({ ...entry, id: `legacy-pi:${revision}:${originals.get(entry)!}` }))
  }
  return branch
}

/** 未导入的 Cogent v1 也用内容修订约束锚点，导入后旧结果明确失效。 */
export function legacyMessages(messages: AgentMessage[]): AttachmentMessage[] {
  for (const message of messages) validateSearchMessage(message)
  const revision = createHash('sha256').update(JSON.stringify(messages)).digest('hex')
  return messages.map((message, index) => ({ ...message, sourceId: `legacy:${revision}:${index}` }))
}

/** 呈现元数据跟随用户条目；不把上传/预览信息塞进模型内容块。 */
export interface AttachmentInput {
  version: 1
  userEntryId: string
  inputId: string
  text: string
  attachments: AttachmentRef[]
  directories?: DirectoryRef[]
}
export type AttachmentMessage = AgentMessage & { sourceId?: string; attachmentInput?: AttachmentInput; fileContext?: FileContext; toolFileRefs?: Record<string, FileReference[]> }

/**
 * 投影源里的压缩条：pi 的 CompactionSummaryMessage 不带 usage
 * （createCompactionSummaryMessage 落树时丢弃），而 CompactionEntry 本身有
 * —— readPiTranscript 构造投影源时补挂（仅呈现口径，不回写 pi 树），
 * 历史折叠条的 summaryUsage 小字账由此而来。
 */
export type CompactionBarSource = Extract<AgentMessage, { role: 'compactionSummary' }> & { usage?: Usage }

/**
 * 会话目录编码（pi session-manager.ts:590 getDefaultSessionDirPath 同款，
 * 该函数未从包导出，此处照抄规则保持文件名/目录可互认）：
 * <agentDir>/sessions/--<cwd 盘符路径分隔符全换 - >--
 */
export function piSessionDir(cwd: string, agentDir: string): string {
  const safePath = `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  return join(resolve(agentDir), 'sessions', safePath)
}

/** Cogent Host 根（COGENT_HOME ?? ~/.cogent）下的 pi 域目录（即 pi 的 agentDir） */
export const PI_AGENT_DIR_NAME = 'pi'

/** 历史读取与删除用同一目录锚点定位，避免为查找文件装配 AgentSession。 */
export function findPiTranscriptFile(cwd: string, hostRoot: string, sessionId: string): string | undefined {
  const sessionDir = piSessionDir(cwd, join(hostRoot, PI_AGENT_DIR_NAME))
  return PiSessionManager.findById(cwd, sessionId, sessionDir)
}

/**
 * 只读回查 pi JSONL（惰性会话的历史投影源，保留式呈现的 pi 版）。
 * pi 的 buildSessionProjection 是**上下文口径**（影子区被摘要吸收后丢弃），
 * 而 Cogent 的历史回查是**呈现口径**（保留式：被摘要区原文照旧可滚，
 * 验收定稿）—— 故此处不走它，改遍历 getBranch() 全量条目自投影：message
 * 条目原样收，compaction 条目转 compactionSummary（pi 投影同款形状，
 * session-manager sessionEntryToContextMessages 对照，另补挂 usage 见
 * CompactionBarSource），影子区/多代压缩条全部保留。找不到会话文件返回
 * undefined（新会话未跑过、或已删除）。
 */
export function readPiTranscript(cwd: string, hostRoot: string, sessionId: string): AttachmentMessage[] | undefined {
  const file = findPiTranscriptFile(cwd, hostRoot, sessionId)
  if (file === undefined) return undefined
  const messages: AttachmentMessage[] = []
  const branch = readSessionBranch(file, cwd, sessionId)
  const inputs = new Map<string, AttachmentInput>()
  const contexts = new Map<string, FileContext>()
  const references: Record<string, FileReference[]> = {}
  for (const entry of branch) {
    if (entry.type === 'custom' && entry.customType === 'cogent.file-context.v1') {
      const data = entry.data as Partial<FileContext>
      if (data.version !== 1 || typeof data.turnId !== 'string' || typeof data.userEntryId !== 'string' || typeof data.cwd !== 'string' ||
        typeof data.platform !== 'string' || !Array.isArray(data.roots) || !data.roots.every((root) => typeof root === 'string')) throw new Error('文件来源元数据损坏')
      contexts.set(data.userEntryId, data as FileContext)
    }
    if (entry.type === 'custom' && entry.customType === 'cogent.file-refs.v1') {
      const data = entry.data as { callId?: unknown; refs?: unknown }
      if (typeof data.callId !== 'string' || !Array.isArray(data.refs) || !data.refs.every((ref: unknown): ref is FileReference =>
        typeof ref === 'object' && ref !== null && 'path' in ref && typeof ref.path === 'string' &&
        (!('turnId' in ref) || typeof ref.turnId === 'string'))) throw new Error('工具文件引用元数据损坏')
      references[data.callId] = data.refs
    }
    if (entry.type === 'custom' && entry.customType === 'cogent.attachment-input.v1') {
      const data = entry.data as Partial<AttachmentInput>
      if (data.version !== 1 || typeof data.userEntryId !== 'string' || typeof data.text !== 'string' ||
        typeof data.inputId !== 'string' || !Array.isArray(data.attachments) || !data.attachments.every(isAttachmentRef) ||
        (data.directories !== undefined && (!Array.isArray(data.directories) || !data.directories.every(isDirectoryRef)))) throw new Error('附件消息元数据损坏')
      inputs.set(data.userEntryId, data as AttachmentInput)
    }
  }
  let context: FileContext | undefined
  for (const entry of branch) {
    if (entry.type === 'message') {
      const input = inputs.get(entry.id)
      if (entry.message.role === 'user') context = contexts.get(entry.id) ?? (typeof entry.message.content === 'string' && entry.message.content.startsWith('[cogent:continue]') ? context : undefined)
      messages.push({ ...entry.message, sourceId: entry.id, ...(input !== undefined && { attachmentInput: input }),
        ...(context !== undefined && { fileContext: context }), toolFileRefs: references })
    } else if (entry.type === 'compaction') {
      const bar: CompactionBarSource = {
        role: 'compactionSummary',
        summary: entry.summary,
        tokensBefore: entry.tokensBefore,
        timestamp: new Date(entry.timestamp).getTime(),
        ...(entry.usage !== undefined && { usage: entry.usage })
      }
      messages.push(bar)
    }
  }
  return messages
}
