/** 模型请求边界：按供应商实际消息结构计数，不从原件大小或本轮附件数推断整个请求额度。 */
import type { Api, Model } from '@earendil-works/pi-ai'
import { formatAttachmentBytes } from '../../shared/attachments'

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function imageCount(block: unknown): number {
  const value = record(block)
  if (value === undefined) return 0
  if (value.type === 'image_url' || value.type === 'input_image' || value.type === 'image') return 1
  if (record(value.image) !== undefined) return 1
  for (const field of ['inlineData', 'fileData']) {
    const data = record(value[field])
    if (data !== undefined && typeof data.mimeType === 'string' && data.mimeType.startsWith('image/')) return 1
  }
  // 只进入工具结果的内容，不遍历工具入参/schema，避免把普通JSON里的type=image当作图片。
  const nested = value.type === 'tool_result' ? value.content : record(value.toolResult)?.content
  return Array.isArray(nested) ? nested.reduce((total: number, item: unknown) => total + imageCount(item), 0) : 0
}
function counts(payload: unknown): number[] {
  const root = record(payload)
  if (root === undefined) throw new Error('当前API请求结构无法校验图片额度')
  const body = record(root.request) ?? root
  let messages: unknown[] | undefined
  for (const key of ['messages', 'input', 'contents']) {
    const value = body[key]
    if (Array.isArray(value)) { messages = value; break }
    if (typeof value === 'string') { messages = []; break }
  }
  if (messages === undefined) throw new Error('当前API请求结构无法校验图片额度')
  return messages.map((message) => {
    const entry = record(message)
    if (entry === undefined) return 0
    const content = entry.content ?? entry.parts
    return Array.isArray(content) ? content.reduce((total: number, item: unknown) => total + imageCount(item), 0) : imageCount(entry)
  })
}

/** 新消息先拒绝已知不可能满足的额度，不把该批原生图片写入pi历史后才发现单条超限。 */
export function assertNewImageMessage(count: number, model: Model<Api> | undefined): void {
  const limits = model?.inputLimits?.images
  const cap = Math.min(limits?.maxPerMessage ?? Infinity, limits?.maxPerRequest ?? Infinity)
  if (count > cap) throw new Error(`本次有 ${count} 张原生图片，当前模型最多接收 ${cap} 张；请减少图片后重新发送`)
}

export function assertAttachmentRequest(payload: unknown, model: Model<Api>): void {
  const limits = model.inputLimits
  if (limits === undefined) return
  const images = limits.images
  if (images?.maxPerMessage !== undefined || images?.maxPerRequest !== undefined) {
    const messages = counts(payload)
    if (images.maxPerMessage !== undefined && messages.some((count) => count > images.maxPerMessage!)) {
      throw new Error(`请求中单条消息的图片超过模型上限 ${images.maxPerMessage} 张；请减少本次图片，或新建聊天避开历史图片`)
    }
    const total = messages.reduce((sum, count) => sum + count, 0)
    if (images.maxPerRequest !== undefined && total > images.maxPerRequest) {
      throw new Error(`本次请求含历史共 ${total} 张图片，模型每次请求最多 ${images.maxPerRequest} 张；请减少本次图片或新建聊天`)
    }
  }
  if (limits.maxRequestBytes !== undefined) {
    // AWS SDK的二进制字段在JSON线上为Base64；JSON.stringify默认会将Buffer变成数字数组。
    const json = JSON.stringify(payload, function (this: Record<string, unknown>, key: string, value: unknown) {
      const original = this[key]
      return original instanceof Uint8Array ? Buffer.from(original).toString('base64') : value
    })
    const bytes = Buffer.byteLength(json, 'utf8')
    if (bytes > limits.maxRequestBytes) {
      throw new Error(`请求体为 ${formatAttachmentBytes(bytes)}，模型请求上限为 ${formatAttachmentBytes(limits.maxRequestBytes)}；请减少附件或历史内容`)
    }
  }
}
