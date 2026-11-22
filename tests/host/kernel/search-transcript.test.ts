/** 真文件只读验证：旧格式不回写，损坏数据不伪装空转录，合并段来源区间可定位。 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { legacyMessages, readSessionBranch } from '../../../src/host/kernel/transcript'
import { toChatMessages } from '../../../src/host/runtime/message-projection'
import type { AssistantMessage } from '@earendil-works/pi-ai'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
it('旧 pi 格式只在内存迁移，多次读取给出稳定来源，不写空文件或损坏文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'cogent-search-read-')); roots.push(root)
  const file = join(root, 'old.jsonl')
  const original = [
    { type: 'session', version: 1, id: 'old-session', cwd: root, timestamp: '2026-01-01T00:00:00Z' },
    { type: 'message', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: '你好', timestamp: 1 } }
  ].map((row) => JSON.stringify(row)).join('\n') + '\n'
  writeFileSync(file, original)
  const first = readSessionBranch(file, root)
  expect(first[0].id).toMatch(/^legacy-pi:/)
  expect(readSessionBranch(file, root)[0].id).toBe(first[0].id)
  expect(readFileSync(file, 'utf8')).toBe(original)
  for (const bad of ['', original + '{bad}\n']) {
    writeFileSync(file, bad)
    expect(() => readSessionBranch(file, root)).toThrow()
    expect(readFileSync(file, 'utf8')).toBe(bad)
  }
})

it('历史助手续写合并时来源区间一同平移，内部续写指令不进入语料', () => {
  const assistant = (text: string): AssistantMessage => ({ role: 'assistant', content: [{ type: 'text', text }], provider: 'a', model: 'm', api: 'openai-completions', timestamp: 2, stopReason: 'stop',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } })
  const source = legacyMessages([{ role: 'user', content: '你好', timestamp: 1 }, assistant('第一段'), { role: 'user', content: '[cogent:continue] continue', timestamp: 3 }, assistant('第二段')])
  const messages = toChatMessages(source)
  expect(messages).toHaveLength(2)
  expect(messages[1].content).toBe('第一段第二段')
  expect(messages[1].sources).toEqual([{ id: source[1].sourceId, start: 0, end: 3 }, { id: source[3].sourceId, start: 3, end: 6 }])
})

it('形状损坏的消息不能被当作空会话成功索引', () => {
  expect(() => legacyMessages([{} as never])).toThrow('角色')
  expect(() => legacyMessages([{ role: 'user', content: [{ type: 'text' }], timestamp: 1 } as never])).toThrow('文本块')
})
