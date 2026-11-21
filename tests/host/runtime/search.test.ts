/** 字面语义、派生索引生命周期与中文短词回归；使用真实 SQLite，不依赖模型。 */
import { expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SearchDatabase } from '../../../src/host/runtime/search/database'
import { matchSearchText, searchTokens } from '../../../src/shared/search-text'
import { validateSearchQuery } from '../../../src/host/runtime/search/validation'

it('短中文、符号和大小写遵循同一字面语义，多个词不能跨消息拼接', () => {
  const db = new SearchDatabase(':memory:')
  try {
    db.replace({ id: 'a', title: '修复登录', createdAt: 1, updatedAt: 2 }, '1', [
      { id: 'm1', role: 'user', text: '用户说你好，请检查登录报错 100%_literal HELLO 🚀', sources: [{ id: 'entry1', start: 0, end: 52 }] },
      { id: 'm2', role: 'assistant', text: '分离的苹果', sources: [{ id: 'entry2', start: 0, end: 6 }] }
    ])
    for (const query of ['你好', '好', '登录报错', '100%_literal', 'hello', '🚀', '你好 HELLO']) {
      const page = db.search({ query })
      expect(page.items.map((item) => item.session.id), query).toEqual(['a'])
      expect(page.items[0].hits[0].anchor.sourceId).toBe('entry1')
    }
    expect(db.search({ query: '你好 苹果' }).items).toEqual([])
    expect(db.search({ query: '100X_literal' }).items).toEqual([])
    expect(db.search({ query: '"你好，请"' }).items).toHaveLength(1)
    expect(db.search({ query: '修复登录' }).items[0].titleRanges).toEqual([{ start: 0, end: 4 }])
  } finally { db.close() }
})

it('排序、归档与项目过滤、会话命中分页及游标失效', () => {
  const db = new SearchDatabase(':memory:')
  try {
    for (let i = 0; i < 5; i++) db.replace({ id: String(i), title: i === 0 ? 'needle' : `聊天${i}`, createdAt: i, updatedAt: i,
      projectId: i < 3 ? 'p' : 'q', ...(i === 4 && { archivedAt: 5 }) }, '1', [
      { id: 'm', role: 'assistant', text: 'needle ' + 'x'.repeat(200) + ' needle', sources: [{ id: `s${i}`, start: 0, end: 214 }] }
    ])
    const first = db.search({ query: 'needle', limit: 2 })
    expect(first.items.map((item) => item.session.id)).toEqual(['0', '3'])
    expect(db.search({ query: 'needle', limit: 2, cursor: first.nextCursor }).items.map((item) => item.session.id)).toEqual(['2', '1'])
    expect(db.search({ query: 'needle', projectId: 'p' }).items).toHaveLength(3)
    expect(db.search({ query: 'needle', includeArchived: true }).items).toHaveLength(5)
    const scoped = db.search({ query: 'needle', sessionId: '1', limit: 1 })
    expect(scoped.items[0].hits).toHaveLength(1)
    expect(db.search({ query: 'needle', sessionId: '1', limit: 1, cursor: scoped.nextCursor }).items[0].hits[0].anchor.offset).toBeGreaterThan(200)
    db.remove('1')
    expect(() => db.search({ query: 'needle', limit: 2, cursor: first.nextCursor })).toThrow('已更新')
    expect(db.search({ query: 'needle' }).items.some((item) => item.session.id === '1')).toBe(false)
  } finally { db.close() }
})

it('Unicode 展开映射回原文，查询语法不变成 FTS 运算符', () => {
  expect(searchTokens('foo "bar baz" OR %_')).toEqual(['foo', 'bar baz', 'or', '%_'])
  expect(matchSearchText('İ你好🚀', ['i'])).toEqual([{ start: 0, end: 1 }])
  expect(matchSearchText('İ你好🚀', ['🚀'])).toEqual([{ start: 3, end: 5 }])
  expect(() => validateSearchQuery({ query: '', limit: 0 })).toThrow()
  expect(() => validateSearchQuery({ query: 'x', includeArchived: 'yes' })).toThrow()
})

it('高频词按会话读取仍保留所有匹配会话和会话内后续页', () => {
  const db = new SearchDatabase(':memory:')
  try {
    for (const id of ['a', 'b']) db.replace({ id, title: id, createdAt: 1, updatedAt: 1 }, '1', Array.from({ length: 100 }, (_, index) => ({
      id: String(index), role: 'user' as const, text: '历史消息', sources: [{ id: `${id}:${index}`, start: 0, end: 4 }]
    })))
    const all = db.search({ query: '历史' })
    expect(all.items.map((item) => item.session.id)).toEqual(['a', 'b'])
    expect(all.items.every((item) => item.hits.length === 2 && item.moreHits)).toBe(true)
    const first = db.search({ query: '历史', sessionId: 'a', limit: 10 })
    const next = db.search({ query: '历史', sessionId: 'a', limit: 10, cursor: first.nextCursor })
    expect(first.items[0].hits[0].anchor.sourceId).toBe('a:99')
    expect(next.items[0].hits[0].anchor.sourceId).toBe('a:89')
  } finally { db.close() }
})

it('已识别的旧派生格式只补短词索引，其他应用数据库拒绝且不改字节', () => {
  const root = mkdtempSync(join(tmpdir(), 'cogent-search-schema-'))
  try {
    const path = join(root, 'old.sqlite')
    let db = new SearchDatabase(path)
    db.replace({ id: 'a', title: '旧索引', createdAt: 1, updatedAt: 1 }, '1', [{ id: 'm', role: 'user', text: '你好', sources: [{ id: 's', start: 0, end: 2 }] }])
    db.close()
    const previous = new DatabaseSync(path)
    previous.exec('DROP TABLE shortgrams; PRAGMA user_version=1'); previous.close()
    db = new SearchDatabase(path)
    expect(db.search({ query: '你好' }).items[0].hits[0].anchor.sourceId).toBe('s')
    db.close()
    const foreignPath = join(root, 'foreign.sqlite')
    const foreign = new DatabaseSync(foreignPath)
    foreign.exec('CREATE TABLE source(text)'); foreign.close()
    const bytes = readFileSync(foreignPath)
    expect(() => new SearchDatabase(foreignPath)).toThrow('不属于')
    expect(readFileSync(foreignPath)).toEqual(bytes)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
