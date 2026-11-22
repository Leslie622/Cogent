/** HostApi 查询入口唯一校验；符号由字面匹配处理，不接受可执行 SQL/FTS 表达式。 */
import type { SearchQuery } from '../../../shared/session-search'

export function validateSearchQuery(value: unknown): asserts value is SearchQuery {
  if (typeof value !== 'object' || value === null || !('query' in value) || typeof value.query !== 'string' || value.query.length > 500 || value.query.includes('\0')) throw new Error('搜索内容需要不超过 500 字符的文本')
  const fields = value as Partial<SearchQuery>
  for (const key of ['projectId', 'sessionId', 'cursor'] as const) {
    if (key in value && fields[key] !== undefined && typeof fields[key] !== 'string') throw new Error(`搜索参数 ${key} 需要文本`)
  }
  if ('cursor' in value && typeof value.cursor === 'string' && value.cursor.length > 4096) throw new Error('搜索游标过长')
  if ('includeArchived' in value && value.includeArchived !== undefined && typeof value.includeArchived !== 'boolean') throw new Error('归档范围需要布尔值')
  if ('limit' in value && value.limit !== undefined && (typeof value.limit !== 'number' || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 100)) throw new Error('搜索分页需要 1–100 的整数')
}
