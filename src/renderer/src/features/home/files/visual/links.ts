/** 文档作者控制href；应用协议和脚本不得跨进文件查看器的可信页面。 */
export function documentUrl(value: string): string | null {
  if (/[\u0000-\u0020\u007f]/.test(value)) return null
  try {
    const url = new URL(value.startsWith('//') ? 'https:' + value : value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null
  } catch { return null }
}

export function installDocumentLinks(root: HTMLElement, open: (url: string) => void): () => void {
  const click = (event: MouseEvent) => {
    if (event.type === 'auxclick' && event.button !== 1) return
    if (!(event.target instanceof Element)) return
    const anchor = event.target.closest('a')
    if (anchor === null || !root.contains(anchor)) return
    const href = anchor.getAttribute('href') ?? anchor.getAttribute('xlink:href') ?? ''
    event.preventDefault()
    event.stopPropagation()
    if (href.startsWith('#')) {
      let id: string
      try { id = decodeURIComponent(href.slice(1)) } catch { return }
      root.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"],[name="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' })
      return
    }
    const url = documentUrl(href)
    if (url !== null) open(url)
  }
  root.addEventListener('click', click, true)
  root.addEventListener('auxclick', click, true)
  return () => { root.removeEventListener('click', click, true); root.removeEventListener('auxclick', click, true) }
}
