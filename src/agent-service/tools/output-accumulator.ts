/**
 * 流式输出累积器（有界内存）—— bash 等长时命令输出的护栏（步骤 3.1 搬入，
 * 首个消费者是批次 3.4 bash 工具的 tool.progress 流式呈现）。
 *
 * 搬运自 pi 上游 reference/pi/packages/coding-agent/src/core/tools/output-accumulator.ts
 * （MIT License, Copyright (c) 2025 Mario Zechner），算法原样。要点：
 * - 用流式 UTF-8 decoder 增量解码（多字节字符跨 chunk 不烂）；
 * - 内存里只留"末尾滚动窗口"（maxBytes×2 截尾）供快照 —— 万行输出也不占内存；
 * - 超限时自动转存临时文件（output-files 收口），全文可回看；
 * - 行/字节计数全程维护，快照自带准确截断元数据（TruncationResult）。
 */

import type { WriteStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { createOutputFileStream } from './output-files'
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateTail } from './truncate'

export interface OutputAccumulatorOptions {
  maxLines?: number
  maxBytes?: number
  tempFilePrefix?: string
}

export interface OutputSnapshot {
  content: string
  truncation: TruncationResult
  fullOutputPath?: string
}

export interface FullOutput {
  content: string
  /** content 是否省略了部分输出（临时文件超 maxBytes 时的头尾拼合） */
  truncated: boolean
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf-8')
}

export class OutputAccumulator {
  private readonly maxLines: number
  private readonly maxBytes: number
  private readonly maxRollingBytes: number
  private readonly tempFilePrefix: string
  private readonly decoder = new TextDecoder()

  private rawChunks: Buffer[] = []
  private tailText = ''
  private tailBytes = 0
  private tailStartsAtLineBoundary = true
  private totalRawBytes = 0
  private totalDecodedBytes = 0
  private completedLines = 0
  private totalLines = 0
  private currentLineBytes = 0
  private hasOpenLine = false
  private finished = false

  private tempFilePath: string | undefined
  private tempFileStream: WriteStream | undefined

  constructor(options: OutputAccumulatorOptions = {}) {
    this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    // 滚动窗口留双倍余量：截尾后仍够 truncateTail 取一个完整快照
    this.maxRollingBytes = Math.max(this.maxBytes * 2, 1)
    this.tempFilePrefix = options.tempFilePrefix ?? 'cogent-output'
  }

  append(data: Buffer): void {
    if (this.finished) {
      throw new Error('Cannot append to a finished output accumulator')
    }

    this.totalRawBytes += data.length
    this.appendDecodedText(this.decoder.decode(data, { stream: true }))

    if (this.tempFileStream || this.shouldUseTempFile()) {
      this.ensureTempFile()
      this.tempFileStream?.write(data)
    } else if (data.length > 0) {
      this.rawChunks.push(data)
    }
  }

  finish(): void {
    if (this.finished) {
      return
    }
    this.finished = true
    // 冲刷 decoder：把最后一个不完整多字节序列按错误形态吐出/丢弃，计数收口
    this.appendDecodedText(this.decoder.decode())
    if (this.shouldUseTempFile()) {
      this.ensureTempFile()
    }
  }

  snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
    const tailTruncation = truncateTail(this.getSnapshotText(), {
      maxLines: this.maxLines,
      maxBytes: this.maxBytes
    })
    // 滚动窗口截过尾时 tailTruncation 看不到全量，用全程计数判定真截断
    const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes
    const truncatedBy = truncated
      ? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? 'bytes' : 'lines'))
      : null
    const truncation: TruncationResult = {
      ...tailTruncation,
      truncated,
      truncatedBy,
      totalLines: this.totalLines,
      totalBytes: this.totalDecodedBytes,
      maxLines: this.maxLines,
      maxBytes: this.maxBytes
    }

    if (options.persistIfTruncated && truncation.truncated) {
      this.ensureTempFile()
    }

    return {
      content: truncation.content,
      truncation,
      fullOutputPath: this.tempFilePath
    }
  }

  async closeTempFile(): Promise<void> {
    if (!this.tempFileStream) {
      return
    }

    const stream = this.tempFileStream
    this.tempFileStream = undefined

    // 等 finish 事件而非 stream.close() 的回调风格：错误与完成双路径都摘干净监听
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        stream.off('finish', onFinish)
        reject(error)
      }
      const onFinish = () => {
        stream.off('error', onError)
        resolve()
      }
      stream.once('error', onError)
      stream.once('finish', onFinish)
      stream.end()
    })
  }

  /**
   * 完整输出（finish + closeTempFile 之后调用）。超 maxBytes 时保留头尾各半、
   * 中间插省略标记 —— 命令输出的开头（命令回显）与结尾（错误/结果）最有信息量。
   */
  async readFullOutput(maxBytes: number): Promise<FullOutput> {
    if (!this.tempFilePath) {
      return { content: new TextDecoder().decode(Buffer.concat(this.rawChunks)), truncated: false }
    }
    const file = await open(this.tempFilePath, 'r')
    try {
      const size = (await file.stat()).size
      if (size <= maxBytes) {
        return { content: new TextDecoder().decode(await file.readFile()), truncated: false }
      }
      const headBytes = Math.floor(maxBytes / 2)
      const tailBytes = maxBytes - headBytes
      const head = Buffer.alloc(headBytes)
      const tail = Buffer.alloc(tailBytes)
      await file.read(head, 0, headBytes, 0)
      await file.read(tail, 0, tailBytes, size - tailBytes)
      // 头部用流式解码（留住不完整尾序列的语义）、尾部跳过续字节 —— 都切在字符边界
      const headText = new TextDecoder().decode(head, { stream: true })
      let tailStart = 0
      while (tailStart < tail.length && (tail[tailStart] & 0xc0) === 0x80) tailStart++
      const tailText = new TextDecoder().decode(tail.subarray(tailStart))
      const omitted = size - headBytes - tailBytes
      return { content: `${headText}\n\n[... ${omitted} bytes omitted ...]\n\n${tailText}`, truncated: true }
    } finally {
      await file.close()
    }
  }

  getLastLineBytes(): number {
    return this.currentLineBytes
  }

  private appendDecodedText(text: string): void {
    if (text.length === 0) {
      return
    }

    const bytes = byteLength(text)
    this.totalDecodedBytes += bytes
    this.tailText += text
    this.tailBytes += bytes
    // 滚动窗口超双倍上限才截尾：省一次 Buffer 往返，也保证窗口完整覆盖快照需求
    if (this.tailBytes > this.maxRollingBytes * 2) {
      this.trimTail()
    }

    // 增量维护行计数（快照的 totalLines 来源，不重扫全量）
    let newlines = 0
    let lastNewline = -1
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
      newlines++
      lastNewline = i
    }
    if (newlines === 0) {
      this.currentLineBytes += bytes
      this.hasOpenLine = true
    } else {
      this.completedLines += newlines
      const tail = text.slice(lastNewline + 1)
      this.currentLineBytes = byteLength(tail)
      this.hasOpenLine = tail.length > 0
    }
    this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0)
  }

  private trimTail(): void {
    const buffer = Buffer.from(this.tailText, 'utf-8')
    if (buffer.length <= this.maxRollingBytes) {
      this.tailBytes = buffer.length
      return
    }

    // 对齐多字节边界后截尾；记录窗口是否起于行边界（快照要能丢掉半行头）
    let start = buffer.length - this.maxRollingBytes
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
      start++
    }

    this.tailStartsAtLineBoundary =
      start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a
    this.tailText = buffer.subarray(start).toString('utf-8')
    this.tailBytes = byteLength(this.tailText)
  }

  private getSnapshotText(): string {
    // 窗口头不是行边界（截尾切在行中间）= 首行是残行，丢弃到下一个换行
    if (this.tailStartsAtLineBoundary) {
      return this.tailText
    }

    const firstNewline = this.tailText.indexOf('\n')
    return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1)
  }

  private shouldUseTempFile(): boolean {
    return (
      this.totalRawBytes > this.maxBytes ||
      this.totalDecodedBytes > this.maxBytes ||
      this.totalLines > this.maxLines
    )
  }

  private ensureTempFile(): void {
    if (this.tempFilePath) {
      return
    }
    // 转存：把已缓存的 rawChunks 先写盘，之后 append 直接进文件，内存 chunk 清空
    const { path, stream } = createOutputFileStream(this.tempFilePrefix, '.log')
    this.tempFilePath = path
    this.tempFileStream = stream
    for (const chunk of this.rawChunks) {
      this.tempFileStream.write(chunk)
    }
    this.rawChunks = []
  }
}
