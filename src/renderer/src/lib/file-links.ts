/** Markdown 文件语法适配：在默认 URL 清洗前封装目标，保留相对路径与 Windows 原文。 */
import type { FileReference } from '@shared/files'
import { parseFileTarget } from '@shared/file-target'

const PREFIX = '#cogent-file:'
export function encodeFileLink(target: string, imageAlt?: string): string {
  return (
    PREFIX +
    encodeURIComponent(
      JSON.stringify({ v: 1, target, ...(imageAlt !== undefined && { imageAlt }) })
    )
  )
}
export function decodeFileEnvelope(
  href: string | undefined
): { target: string; imageAlt?: string } | undefined {
  if (href === undefined || !href.startsWith(PREFIX) || href.length > 100_000) return undefined
  try {
    const data: unknown = JSON.parse(decodeURIComponent(href.slice(PREFIX.length)))
    if (
      typeof data !== 'object' ||
      data === null ||
      !('v' in data) ||
      data.v !== 1 ||
      !('target' in data) ||
      typeof data.target !== 'string' ||
      parseFileTarget(data.target) === undefined
    )
      return undefined
    if ('imageAlt' in data && (typeof data.imageAlt !== 'string' || data.imageAlt.length > 10_000))
      return undefined
    return { target: data.target, ...('imageAlt' in data && { imageAlt: data.imageAlt as string }) }
  } catch {
    return undefined
  }
}
export function decodeFileLink(href: string | undefined): string | undefined {
  return decodeFileEnvelope(href)?.target
}
export function literalFileTarget(path: string): string {
  return path
    .replaceAll('%', '%25')
    .replaceAll('#', '%23')
    .replaceAll('?', '%3F')
    .replace(/:(\d+)(?::\d+)?$/, (part) => part.replaceAll(':', '%3A'))
}
interface MdNode {
  type: string
  url?: string
  value?: string
  title?: string | null
  children?: MdNode[]
  alt?: string
  identifier?: string
  position?: { start: { offset?: number }; end: { offset?: number } }
}
const unescape = (value: string) =>
  value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1')
function rawWindowsDestination(node: MdNode, source: string): string | undefined {
  if (node.url === undefined || !/^(?:[a-z]:[\\/]|\\|file:\/\/)/i.test(node.url)) return undefined
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (start === undefined || end === undefined) return undefined
  const span = source.slice(start, end)
  const match =
    node.type === 'definition'
      ? /^\s*\[[\s\S]*?\]:\s*/.exec(span)
      : /^!?\[[\s\S]*\]\(\s*/.exec(span)
  if (match === null) return undefined
  const rest = span.slice(match[0].length)
  let raw = ''
  if (rest.startsWith('<')) {
    const close = rest.indexOf('>')
    if (close < 0) return undefined
    raw = rest.slice(1, close)
  } else {
    let depth = 0
    for (let i = 0; i < rest.length; i++) {
      const char = rest[i]
      if (char === '\\' && /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(rest[i + 1] ?? '')) {
        raw += char + rest[++i]
        continue
      }
      if ((char === ')' && depth === 0) || /\s/.test(char)) break
      if (char === '(') depth++
      if (char === ')') depth--
      raw += char
    }
  }
  return raw !== '' && unescape(raw) === node.url ? raw : undefined
}
export function knownFileLink(value: string, refs: readonly FileReference[]): string | undefined {
  const normalize = (path: string) => path.replaceAll('\\', '/').replace(/^\.\//, '')
  const paths = [...new Set(refs.map((ref) => ref.path))]
  const matching = (token: string) =>
    paths.filter((path) => {
      let candidate = normalize(path)
      let name = normalize(token)
      if (/^[a-z]:|^\\\\/i.test(path)) {
        candidate = candidate.toLowerCase()
        name = name.toLowerCase()
      }
      return candidate === name || candidate.endsWith('/' + name)
    })
  // inlineCode 是字面文件名，先匹配 %、#、数字冒号等真实字符，再尝试 URI/定位语法。
  const literal = matching(value)
  if (literal.length === 1) return literalFileTarget(literal[0])
  if (literal.length > 1) return undefined
  const target = parseFileTarget(value)
  if (target === undefined) return undefined
  const matches = matching(target.path)
  if (matches.length !== 1) return undefined
  const location = target.location
  return (
    literalFileTarget(matches[0]) +
    (location === undefined
      ? ''
      : location.endLine !== undefined
        ? `#L${location.line}-L${location.endLine}`
        : `:${location.line}${location.column === undefined ? '' : ':' + location.column}`)
  )
}
let fileLinksPluginSeq = 0
export function fileLinksPlugin(refs: readonly FileReference[] = []) {
  const plugin = () => (tree: unknown, file: { toString(): string }) => {
    const source = String(file)
    const definitions = new Map<string, string>()
    const index = (node: MdNode) => {
      if (node.type === 'definition' && node.identifier !== undefined && node.url !== undefined)
        definitions.set(node.identifier, rawWindowsDestination(node, source) ?? node.url)
      node.children?.forEach(index)
    }
    index(tree as MdNode)
    const visit = (node: MdNode, insideLink = false): void => {
      if (node.type === 'imageReference' && node.identifier !== undefined) {
        const target = definitions.get(node.identifier)
        if (target !== undefined && parseFileTarget(target) !== undefined) {
          node.type = 'image'
          node.url = target
        }
      }
      if (
        (node.type === 'link' || node.type === 'image' || node.type === 'definition') &&
        node.url !== undefined
      ) {
        const raw = rawWindowsDestination(node, source) ?? node.url
        if (raw !== 'streamdown:incomplete-link' && parseFileTarget(raw) !== undefined) {
          if (node.type === 'image') {
            // 默认图片安全插件拒绝片段 src；先变成惰性内部链接，清洗后再由委托加载 Blob。
            const alt = node.alt ?? ''
            node.type = 'link'
            node.children = [{ type: 'text', value: alt }]
            node.url = encodeFileLink(raw, alt)
          } else node.url = encodeFileLink(raw)
        }
      }
      if (node.type === 'inlineCode' && node.value !== undefined && !insideLink) {
        const target = knownFileLink(node.value, refs)
        if (target !== undefined) {
          node.children = [{ type: 'text', value: node.value }]
          node.type = 'link'
          node.url = encodeFileLink(target)
          delete node.value
        }
      }
      if (node.type === 'code' || node.type === 'html') return
      node.children?.forEach((child) => visit(child, insideLink || node.type === 'link'))
    }
    visit(tree as MdNode)
  }
  // Streamdown 以插件函数名缓存 processor；闭包词表不同就必须分开，与渐显插件同一身份规则。
  Object.defineProperty(plugin, 'name', { value: `cogentFileLinksRemark$${++fileLinksPluginSeq}` })
  return plugin
}
