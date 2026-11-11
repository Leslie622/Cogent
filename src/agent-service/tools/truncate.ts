/**
 * 工具输出统一截断器（计划-pi借鉴.md 步骤 3.1）。
 *
 * 搬运自 pi 上游 reference/pi/packages/coding-agent/src/core/tools/truncate.ts
 * （MIT License, Copyright (c) 2025 Mario Zechner）——算法与边界原样保留
 * （行/字节双上限先到先停、从不返回半行、多字节字符不切断），仅格式与注释
 * 按 Cogent 约定重写。它取代批次 1 各工具自带的零散上限（read 的字符循环 /
 * grep 的 slice(0,300)），成为 read / grep / glob / 未来 bash 输出的唯一护栏，
 * 截断元数据（TruncationResult）让每个工具都能生成"用 offset 续读"类的
 * 可行动提示，而不是一句干巴巴的"已截断"。
 *
 * 双上限独立生效，先到先停：
 * - 行数上限（默认 2000 行，Claude Code Read 同款量级）
 * - 字节上限（默认 50KB）
 * 例外：bash 尾部截断的"单行超限取行尾"场景允许半行（见 truncateTail）。
 */

export const DEFAULT_MAX_LINES = 2000
export const DEFAULT_MAX_BYTES = 50 * 1024 // 50KB
/** grep 匹配行的单行字符上限（超长行只可能是打包产物，截断并标注） */
export const GREP_MAX_LINE_LENGTH = 500

/** （type 别名而非 interface：对象字面量形状才有隐式索引签名，才能作为
 *  details 塞进 pi 转录的 JsonValue —— interface 会被判不兼容） */
export type TruncationResult = {
  /** 截断后的内容 */
  content: string
  /** 是否发生了截断 */
  truncated: boolean
  /** 先命中的是哪个上限："lines" | "bytes" | null（未截断） */
  truncatedBy: 'lines' | 'bytes' | null
  /** 原内容总行数 */
  totalLines: number
  /** 原内容总字节数（UTF-8） */
  totalBytes: number
  /** 截断后输出包含的完整行数 */
  outputLines: number
  /** 截断后输出字节数（UTF-8） */
  outputBytes: number
  /** 末行是否被部分截断（仅尾部截断的单行超限边界场景为 true） */
  lastLinePartial: boolean
  /** 首行单独就超过字节上限（头部截断时为 true，调用方据此给替代方案提示） */
  firstLineExceedsLimit: boolean
  /** 生效的行数上限 */
  maxLines: number
  /** 生效的字节上限 */
  maxBytes: number
}

export interface TruncationOptions {
  /** 行数上限（默认 2000） */
  maxLines?: number
  /** 字节上限（默认 50KB） */
  maxBytes?: number
}

/** 按行计数切分：结尾换行不计为空行（"a\nb\n" = 2 行，与 split 直用差一个空尾行） */
function splitLinesForCounting(content: string): string[] {
  if (content.length === 0) {
    return []
  }
  const lines = content.split('\n')
  if (content.endsWith('\n')) {
    lines.pop()
  }
  return lines
}

/** 字节数 → 人类可读（提示行用，模型对 "50.0KB" 比对裸数字更有量感） */
export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`
  } else {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  }
}

/**
 * 头部截断（保留前 N 行/字节）—— 文件读取类：模型从头往下读，续读靠 offset。
 * 从不返回半行；首行单独超字节上限时返回空内容 + firstLineExceedsLimit 标记
 * （调用方决定给替代方案而不是硬塞半行）。
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES

  const totalBytes = Buffer.byteLength(content, 'utf-8')
  const lines = splitLinesForCounting(content)
  const totalLines = lines.length

  // 双上限都没碰：原样返回
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines,
      maxBytes
    }
  }

  // 首行单独就超字节上限（压缩/打包文件典型）：空内容 + 标记，决定权交调用方
  const firstLineBytes = Buffer.byteLength(lines[0], 'utf-8')
  if (firstLineBytes > maxBytes) {
    return {
      content: '',
      truncated: true,
      truncatedBy: 'bytes',
      totalLines,
      totalBytes,
      outputLines: 0,
      outputBytes: 0,
      lastLinePartial: false,
      firstLineExceedsLimit: true,
      maxLines,
      maxBytes
    }
  }

  // 逐行收集完整行，任一上限先到即停
  const outputLinesArr: string[] = []
  let outputBytesCount = 0
  let truncatedBy: 'lines' | 'bytes' = 'lines'

  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const line = lines[i]
    // +1 是换行符（首行无前置换行）
    const lineBytes = Buffer.byteLength(line, 'utf-8') + (i > 0 ? 1 : 0)

    if (outputBytesCount + lineBytes > maxBytes) {
      truncatedBy = 'bytes'
      break
    }

    outputLinesArr.push(line)
    outputBytesCount += lineBytes
  }

  // 因行数上限退出的（收集满 maxLines 且没碰字节上限）
  if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
    truncatedBy = 'lines'
  }

  const outputContent = outputLinesArr.join('\n')
  const finalOutputBytes = Buffer.byteLength(outputContent, 'utf-8')

  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLinesArr.length,
    outputBytes: finalOutputBytes,
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes
  }
}

/**
 * 尾部截断（保留末 N 行/字节）—— 命令输出类：错误与最终结果都在末尾。
 * 边界场景：原内容最后一行单独超字节上限时，取该行的字节尾段（允许半行——
 * 命令输出的长行是数据不是代码，保尾比保完整行更有信息量）。
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES

  const totalBytes = Buffer.byteLength(content, 'utf-8')
  const lines = splitLinesForCounting(content)
  const totalLines = lines.length

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines,
      maxBytes
    }
  }

  // 从末行往前收集
  const outputLinesArr: string[] = []
  let outputBytesCount = 0
  let truncatedBy: 'lines' | 'bytes' = 'lines'
  let lastLinePartial = false

  for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
    const line = lines[i]
    const lineBytes = Buffer.byteLength(line, 'utf-8') + (outputLinesArr.length > 0 ? 1 : 0)

    if (outputBytesCount + lineBytes > maxBytes) {
      truncatedBy = 'bytes'
      // 一行都没收且这行就超限：取行尾字节段（半行），保证有产出
      if (outputLinesArr.length === 0) {
        const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes)
        outputLinesArr.unshift(truncatedLine)
        outputBytesCount = Buffer.byteLength(truncatedLine, 'utf-8')
        lastLinePartial = true
      }
      break
    }

    outputLinesArr.unshift(line)
    outputBytesCount += lineBytes
  }

  if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
    truncatedBy = 'lines'
  }

  const outputContent = outputLinesArr.join('\n')
  const finalOutputBytes = Buffer.byteLength(outputContent, 'utf-8')

  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLinesArr.length,
    outputBytes: finalOutputBytes,
    lastLinePartial,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes
  }
}

/** 字符串截到字节上限（保尾）—— 按多字节边界回退，不切出半个 UTF-8 字符 */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, 'utf-8')
  if (buf.length <= maxBytes) {
    return str
  }

  // 从末尾往前跳 maxBytes 字节，再对齐到字符首字节（续字节 = 10xxxxxx 形态）
  let start = buf.length - maxBytes
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
    start++
  }

  return buf.slice(start).toString('utf-8')
}

/**
 * 单行截断到 maxChars 字符，追加截断标注 —— grep 匹配行用
 * （标注让模型知道行被切过，不会把截断处当原文）。
 */
export function truncateLine(
  line: string,
  maxChars: number = GREP_MAX_LINE_LENGTH
): { text: string; wasTruncated: boolean } {
  if (line.length <= maxChars) {
    return { text: line, wasTruncated: false }
  }
  return { text: `${sliceHead(line, maxChars)}... [truncated]`, wasTruncated: true }
}

/** 取前 maxUnits 个 UTF-16 码元，不切断代理对（emoji 不出半个） */
export function sliceHead(text: string, maxUnits: number): string {
  const end = Math.max(0, maxUnits)
  // 切点正好落在高代理项后 = 会留半个字符：整字让出
  return isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))
    ? text.slice(0, end - 1)
    : text.slice(0, end)
}

/** 取后 maxUnits 个 UTF-16 码元，不切断代理对 */
export function sliceTail(text: string, maxUnits: number): string {
  if (maxUnits <= 0) return ''
  const start = Math.max(0, text.length - maxUnits)
  return isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))
    ? text.slice(start + 1)
    : text.slice(start)
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}
