/** OOXML 的命名空间与部件关系边界；只投影内存读取版本，绝不改写受管原件。 */
import { posix } from 'node:path'
import { DOMParser, XMLSerializer, type Document, type Element, type Node } from '@xmldom/xmldom'
import { XMLValidator } from 'fast-xml-parser'
import { strFromU8, strToU8, zipSync } from 'fflate'

export type XmlNode = Record<string, unknown>
const RELATIONSHIP_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const SPREADSHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'

function document(xml: string): Document {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('不支持带 DTD / 实体定义的文档')
  if (XMLValidator.validate(xml) !== true) throw new Error('文档 XML 损坏')
  return new DOMParser({ onError: (_level, message) => { throw new Error(`文档 XML 损坏：${message}`) } })
    .parseFromString(xml, 'application/xml')
}

function ordered(nodes: ArrayLike<Node>): XmlNode[] {
  const result: XmlNode[] = []
  for (const node of Array.from(nodes)) {
    if (node.nodeType === 3 || node.nodeType === 4) { result.push({ '#text': node.nodeValue! }); continue }
    if (node.nodeType !== 1) continue
    const element = node as Element
    const attributes: Record<string, string> = {}
    for (const attribute of Array.from(element.attributes)) {
      // 关系属性不能与同名普通属性折叠；关系ID也不保证使用 rId 开头。
      const key = attribute.namespaceURI === RELATIONSHIP_NS && attribute.localName === 'id'
        ? '@_relationshipId' : `@_${attribute.localName ?? attribute.name}`
      attributes[key] = attribute.value
    }
    result.push({ [element.localName ?? element.tagName]: ordered(element.childNodes), ':@': attributes })
  }
  return result
}

export function xmlNodes(xml: string): XmlNode[] { return ordered(document(xml).childNodes) }

/** ExcelJS 的标签解析不接受 SpreadsheetML 前缀；投影默认命名空间，保留其他命名空间和二进制部件。 */
export function workbookBytes(parts: Record<string, Uint8Array>, original: Uint8Array): Uint8Array {
  let changed = false
  const projected = { ...parts }
  for (const [name, bytes] of Object.entries(parts)) {
    if (!/\.xml$|\.rels$/i.test(name)) continue
    const doc = document(strFromU8(bytes))
    const elements = Array.from(doc.getElementsByTagNameNS(SPREADSHEET_NS, '*'))
    if (!elements.some((element) => element.prefix !== null)) continue
    for (const element of elements) {
      if (element.prefix === null) continue
      const replacement = doc.createElementNS(SPREADSHEET_NS, element.localName!)
      for (const attribute of Array.from(element.attributes)) {
        if (attribute.name !== 'xmlns') replacement.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value)
      }
      while (element.firstChild !== null) replacement.appendChild(element.firstChild)
      element.parentNode!.replaceChild(replacement, element)
    }
    projected[name] = strToU8(new XMLSerializer().serializeToString(doc))
    changed = true
  }
  return changed ? zipSync(projected, { level: 1 }) : original
}

/** OPC 关系目标是包内URI；按所属部件解析，外部地址与越过包根的路径不进入本地读取。 */
export function relationshipTarget(owner: string, target: string, external = false): string {
  let decoded: string
  try { decoded = decodeURIComponent(target) }
  catch { throw new Error('文档关系路径编码不合法') }
  if (external || /^[a-z][a-z0-9+.-]*:/i.test(decoded) || decoded.startsWith('//') || /[\\\0?#]/.test(decoded)) {
    throw new Error('文档关系不能指向外部地址或非法路径')
  }
  const resolved = posix.normalize(decoded.startsWith('/') ? decoded.slice(1) : posix.join(posix.dirname(owner), decoded))
  if (resolved === '.' || resolved === '..' || resolved.startsWith('../')) throw new Error('文档关系路径越过包根')
  return resolved
}

export function relationshipsPath(part: string): string {
  return posix.join(posix.dirname(part), '_rels', `${posix.basename(part)}.rels`)
}
