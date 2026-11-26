/** 文本解码与净行差计算；纯函数供 diff-worker 与单测共用。 */
import { diffLines } from 'diff'

export type DecodedText =
  | { binary: false; text: string; encoding: string }
  | { binary: true }

export type DiffStatResult =
  | { status: 'text'; added: number; deleted: number; beforeEncoding?: string; afterEncoding?: string }
  | { status: 'eol-or-encoding'; added: 0; deleted: 0; beforeEncoding?: string; afterEncoding?: string }
  | { status: 'binary'; added: null; deleted: null }
  | { status: 'timeout'; added: null; deleted: null }

function swapBytes16(buf: Buffer): Buffer {
  const copy = Buffer.allocUnsafe(buf.length - (buf.length % 2))
  for (let i = 0; i + 1 < buf.length; i += 2) {
    copy[i] = buf[i + 1]
    copy[i + 1] = buf[i]
  }
  return copy
}

/** 识别 UTF-16 BOM / UTF-8 BOM / 合法 UTF-8，含 NUL 字节或非法序列判为二进制。 */
export function decodeBuffer(buf: Buffer): DecodedText {
  if (buf.length === 0) return { binary: false, text: '', encoding: 'utf-8' }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { binary: false, text: buf.subarray(2).toString('utf16le'), encoding: 'utf-16le' }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { binary: false, text: swapBytes16(buf.subarray(2)).toString('utf16le'), encoding: 'utf-16be' }
  }
  const hasUtf8Bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  const payload = hasUtf8Bom ? buf.subarray(3) : buf
  if (payload.subarray(0, 8192).includes(0)) return { binary: true }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(payload)
    return { binary: false, text, encoding: hasUtf8Bom ? 'utf-8-bom' : 'utf-8' }
  } catch {
    return { binary: true }
  }
}

export const normalizeLineEndings = (text: string): string => text.replaceAll('\r\n', '\n')

/** 计算首尾内容净增删行数；超时或二进制返回诚实降级状态，不伪装成 +0 -0。 */
export function computeDiffStat(
  beforeBuf: Buffer | null,
  afterBuf: Buffer | null,
  timeoutMs: number
): DiffStatResult {
  const before = beforeBuf === null ? null : decodeBuffer(beforeBuf)
  const after = afterBuf === null ? null : decodeBuffer(afterBuf)
  if ((before !== null && before.binary) || (after !== null && after.binary)) {
    return { status: 'binary', added: null, deleted: null }
  }
  const beforeRaw = before?.text ?? ''
  const afterRaw = after?.text ?? ''
  const beforeNorm = normalizeLineEndings(beforeRaw)
  const afterNorm = normalizeLineEndings(afterRaw)
  if (beforeBuf !== null && afterBuf !== null && beforeNorm === afterNorm) {
    return {
      status: 'eol-or-encoding',
      added: 0,
      deleted: 0,
      beforeEncoding: before?.encoding,
      afterEncoding: after?.encoding
    }
  }
  const changes = diffLines(beforeNorm, afterNorm, { timeout: timeoutMs })
  if (changes === undefined) return { status: 'timeout', added: null, deleted: null }
  let added = 0
  let deleted = 0
  for (const part of changes) {
    if (part.added) added += part.count
    else if (part.removed) deleted += part.count
  }
  return {
    status: 'text',
    added,
    deleted,
    beforeEncoding: before?.encoding,
    afterEncoding: after?.encoding
  }
}
