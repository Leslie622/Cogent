/** 会话检索的壳合同；来源锚点独立于消息 UI key，不把内核对象传给界面。 */
export interface MessageSource { id: string; start: number; end: number }
export interface SearchRange { start: number; end: number }
export interface SearchQuery {
  query: string
  projectId?: string
  includeArchived?: boolean
  sessionId?: string
  limit?: number
  cursor?: string
}
export interface SearchSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  projectId?: string
  archivedAt?: number
}
export interface SearchHit {
  key: string
  role: 'user' | 'assistant'
  snippet: string
  ranges: SearchRange[]
  anchor: { sourceId: string; offset: number }
}
export interface SearchResult {
  session: SearchSession
  titleRanges: SearchRange[]
  hits: SearchHit[]
  moreHits: boolean
}
export interface SearchPage {
  items: SearchResult[]
  nextCursor?: string
  /** 来源损坏时仍返回其他聊天，明确说明结果不完整。 */
  issues: Array<{ sessionId: string; message: string }>
}
export interface SessionSearchMethods {
  'session.search': { params: SearchQuery; result: SearchPage }
  'session.search.rebuild': { params: Record<string, never>; result: { ok: true } }
}
