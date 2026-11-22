/** 单 worker 拥有的派生 SQLite；事务替换完整会话，短词字面检索与 trigram 共用最终验证。 */
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { MessageSource, SearchHit, SearchPage, SearchQuery, SearchResult, SearchSession } from '../../../shared/session-search'
import { matchSearchText, normalizeSearchText, searchSnippet, searchTokens } from '../../../shared/search-text'
import type { SearchDocument } from './corpus'

const APPLICATION_ID = 0x43475331
function shortTerm(characters: string[]): string { return 's' + characters.map((character) => character.codePointAt(0)!.toString(16)).join('x') }
function shortTerms(folded: string): string {
  const characters = Array.from(folded), terms = new Set<string>()
  for (let i = 0; i < characters.length; i++) {
    terms.add(shortTerm([characters[i]]))
    if (i > 0) terms.add(shortTerm([characters[i - 1], characters[i]]))
  }
  return [...terms].join(' ')
}
type DocumentRow = { session_id: string; id: string; role: 'user' | 'assistant'; text: string; sources: string }

export class SearchDatabase {
  private db: DatabaseSync
  private generation = 0
  private instance = randomUUID()
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    try {
      const app = this.db.prepare('PRAGMA application_id').get() as { application_id: number }
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*'").all()
      if (app.application_id !== APPLICATION_ID && (app.application_id !== 0 || tables.length > 0)) throw new Error('搜索索引文件不属于 Cogent')
      const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
      if (version.user_version !== 0 && version.user_version !== 1 && version.user_version !== 2) throw new Error('搜索索引版本不兼容，请重建索引')
      this.db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, summary TEXT NOT NULL, revision TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS documents(rowid INTEGER PRIMARY KEY, session_id TEXT NOT NULL, id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, folded TEXT NOT NULL, sources TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS documents_session ON documents(session_id);
        CREATE VIRTUAL TABLE IF NOT EXISTS grams USING fts5(folded, tokenize='trigram case_sensitive 1');
        CREATE VIRTUAL TABLE IF NOT EXISTS shortgrams USING fts5(terms, content='', contentless_delete=1, detail=none);`)
      // v1 是本模块已有派生格式，只补短词索引；不迁移或重写真源。
      if (version.user_version < 2) {
        this.db.exec('BEGIN IMMEDIATE')
        try {
          const insert = this.db.prepare('INSERT INTO shortgrams(rowid,terms) VALUES(?,?)')
          for (const row of this.db.prepare('SELECT rowid,folded FROM documents').iterate() as Iterable<{ rowid: number; folded: string }>) insert.run(row.rowid, shortTerms(row.folded))
          this.db.exec('PRAGMA user_version=2; COMMIT')
        } catch (error) { this.db.exec('ROLLBACK'); throw error }
      }
    } catch (error) { this.db.close(); throw error }
  }
  close(): void { this.db.close() }
  revision(id: string): string | undefined {
    return (this.db.prepare('SELECT revision FROM sessions WHERE id=?').get(id) as { revision: string } | undefined)?.revision
  }
  summaries(): SearchSession[] {
    return (this.db.prepare('SELECT summary FROM sessions').all() as Array<{ summary: string }>).map((row) => JSON.parse(row.summary) as SearchSession)
  }
  replace(summary: SearchSession, revision: string, documents?: SearchDocument[]): void {
    const before = this.db.prepare('SELECT summary,revision FROM sessions WHERE id=?').get(summary.id) as { summary: string; revision: string } | undefined
    const serialized = JSON.stringify(summary)
    if (before?.summary === serialized && before.revision === revision) return
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (documents !== undefined) {
        this.removeDocuments(summary.id)
        const insert = this.db.prepare('INSERT INTO documents(session_id,id,role,text,folded,sources) VALUES(?,?,?,?,?,?)')
        const gram = this.db.prepare('INSERT INTO grams(rowid,folded) VALUES(?,?)')
        const short = this.db.prepare('INSERT INTO shortgrams(rowid,terms) VALUES(?,?)')
        for (const doc of documents) {
          const folded = normalizeSearchText(doc.text).text
          const { lastInsertRowid } = insert.run(summary.id, doc.id, doc.role, doc.text, folded, JSON.stringify(doc.sources))
          gram.run(lastInsertRowid, folded)
          short.run(lastInsertRowid, shortTerms(folded))
        }
      }
      this.db.prepare('INSERT INTO sessions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET summary=excluded.summary,revision=excluded.revision').run(summary.id, serialized, revision)
      this.db.exec('COMMIT'); this.generation++
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  remove(id: string): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.removeDocuments(id)
      this.db.prepare('DELETE FROM sessions WHERE id=?').run(id)
      this.db.exec('COMMIT'); this.generation++
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private removeDocuments(id: string): void {
    this.db.prepare('DELETE FROM shortgrams WHERE rowid IN (SELECT rowid FROM documents WHERE session_id=?)').run(id)
    this.db.prepare('DELETE FROM grams WHERE rowid IN (SELECT rowid FROM documents WHERE session_id=?)').run(id)
    this.db.prepare('DELETE FROM documents WHERE session_id=?').run(id)
  }
  search(query: SearchQuery): SearchPage {
    const tokens = searchTokens(query.query)
    const limit = query.limit ?? 30
    const identity = JSON.stringify({ query: query.query, projectId: query.projectId, includeArchived: query.includeArchived === true, sessionId: query.sessionId, limit })
    let offset = 0
    if (query.cursor !== undefined) {
      const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as { identity?: unknown; generation?: unknown; offset?: unknown }
      if (cursor.identity !== identity || cursor.generation !== `${this.instance}:${this.generation}` || !Number.isInteger(cursor.offset) || (cursor.offset as number) < 0) throw new Error('搜索结果已更新，请重新搜索')
      offset = cursor.offset as number
    }
    const sessions = this.summaries().filter((session) => (query.includeArchived || session.archivedAt === undefined) &&
      (query.projectId === undefined || (query.projectId === '' ? session.projectId === undefined : session.projectId === query.projectId)) &&
      (query.sessionId === undefined || session.id === query.sessionId))
    const groups = new Map<string, SearchResult>()
    for (const session of sessions) {
      const titleRanges = matchSearchText(session.title, tokens)
      if (tokens.length === 0 || titleRanges.length > 0) groups.set(session.id, { session, titleRanges, hits: [], moreHits: false })
    }
    if (tokens.length > 0) {
      const long = tokens.filter((token) => Array.from(token).length >= 3)
      const short = tokens.filter((token) => Array.from(token).length < 3)
      const predicates: string[] = [], args: Array<string | number> = []
      if (long.length > 0) {
        predicates.push('d.rowid IN (SELECT rowid FROM grams WHERE grams MATCH ?)')
        args.push(long.map((token) => `"${token.replaceAll('"', '""')}"`).join(' AND '))
      }
      if (short.length > 0) {
        predicates.push('d.rowid IN (SELECT rowid FROM shortgrams WHERE shortgrams MATCH ?)')
        args.push(short.map((token) => shortTerm(Array.from(token))).join(' AND '))
      }
      const candidates = this.db.prepare(`SELECT count(*) AS count FROM documents d WHERE ${predicates.join(' AND ')}`).get(...args) as { count: number }
      for (const token of tokens) { predicates.push('instr(d.folded,?)>0'); args.push(token) }
      if (!query.includeArchived) predicates.push("json_extract(s.summary,'$.archivedAt') IS NULL")
      if (query.projectId !== undefined) {
        if (query.projectId === '') predicates.push("json_extract(s.summary,'$.projectId') IS NULL")
        else { predicates.push("json_extract(s.summary,'$.projectId')=?"); args.push(query.projectId) }
      }
      if (query.sessionId !== undefined) { predicates.push('d.session_id=?'); args.push(query.sessionId) }
      const maximumHits = query.sessionId === undefined ? 3 : offset + limit + 1
      // 候选先在 SQLite 内做字面验证与分组截取，避免高频词把数万条正文搬入 JS。
      // 限制的是每页所需消息数，语料和长消息本身不截断。
      const common = candidates.count > sessions.length * maximumHits * 8
      const database = this.db
      function* candidatesForPage(): Generator<DocumentRow> {
        if (common) {
          // 高频召回时逐会话从最近消息取足即可；不为第一页排序所有历史命中。
          const statement = database.prepare(`SELECT d.session_id,d.id,d.role,d.text,d.sources FROM documents d WHERE d.session_id=? AND ${tokens.map(() => 'instr(d.folded,?)>0').join(' AND ')} ORDER BY d.rowid DESC LIMIT ?`)
          for (const session of sessions) yield* statement.iterate(session.id, ...tokens, maximumHits) as Iterable<DocumentRow>
          return
        }
        yield* database.prepare(`WITH ranked AS (
        SELECT d.rowid, ROW_NUMBER() OVER (PARTITION BY d.session_id ORDER BY d.rowid DESC) AS position
        FROM documents d JOIN sessions s ON s.id=d.session_id WHERE ${predicates.join(' AND ')}
      ) SELECT d.session_id,d.id,d.role,d.text,d.sources FROM documents d JOIN ranked r ON r.rowid=d.rowid WHERE r.position<=? ORDER BY d.rowid DESC`).iterate(...args, maximumHits) as Iterable<DocumentRow>
      }
      const allowed = new Map(sessions.map((session) => [session.id, session]))
      for (const row of candidatesForPage()) {
        const session = allowed.get(row.session_id)!
        let group = groups.get(session.id)
        if (group !== undefined && group.hits.length >= maximumHits) continue
        const ranges = matchSearchText(row.text, tokens)
        if (group === undefined) { group = { session, titleRanges: [], hits: [], moreHits: false }; groups.set(session.id, group) }
        const sources = JSON.parse(row.sources) as MessageSource[]
        let lastEnd = -1
        for (const range of ranges) {
          if (group.hits.length >= maximumHits) break
          if (range.start < lastEnd) continue
          lastEnd = range.start + 130
          const source = sources.find((item) => range.start < item.end) ?? sources.at(-1)!
          const hit: SearchHit = { key: `${row.id}:${range.start}`, role: row.role, ...searchSnippet(row.text, ranges, range.start), anchor: { sourceId: source.id, offset: Math.max(0, range.start - source.start) } }
          group.hits.push(hit)
        }
      }
    }
    const normalizedQuery = normalizeSearchText(query.query.trim()).text
    const ranked = [...groups.values()].sort((a, b) => {
      const rank = (item: SearchResult) => normalizeSearchText(item.session.title).text === normalizedQuery ? 0 : item.titleRanges.length > 0 ? 1 : 2
      return rank(a) - rank(b) || b.session.updatedAt - a.session.updatedAt || a.session.id.localeCompare(b.session.id)
    })
    const total = query.sessionId === undefined ? ranked.length : (ranked[0]?.hits.length ?? 0)
    const items = query.sessionId === undefined ? ranked.slice(offset, offset + limit) : ranked.slice(0, 1)
    for (const item of items) {
      const start = query.sessionId === undefined ? 0 : offset, count = query.sessionId === undefined ? 2 : limit
      item.moreHits = item.hits.length > start + count
      item.hits = item.hits.slice(start, start + count)
    }
    return { items, issues: [], ...(offset + limit < total && { nextCursor: Buffer.from(JSON.stringify({ identity, generation: `${this.instance}:${this.generation}`, offset: offset + limit })).toString('base64url') }) }
  }
}
