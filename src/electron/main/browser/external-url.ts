/** Edge 在 Windows 外部启动时会忽略带固定热榜标记的百度搜索地址；兼容只用于系统出口，不回写网页导航与历史。 */
export function edgeExternalUrl(value: string): string {
  const url = new URL(value)
  if (url.origin !== 'https://www.baidu.com' || url.pathname !== '/s' || url.search === '') return value

  const queryStart = value.indexOf('?')
  const fragmentStart = value.indexOf('#', queryStart)
  const queryEnd = fragmentStart === -1 ? value.length : fragmentStart
  // 保留查询串原始字节，避免 URLSearchParams 重排或重新编码其他参数中的加号、空格与保留字符。
  const pairs = value.slice(queryStart + 1, queryEnd).split('&').filter(pair => pair !== 'tn=baidutop10')
  return value.slice(0, queryStart) + (pairs.length > 0 ? '?' + pairs.join('&') : '') + value.slice(queryEnd)
}
