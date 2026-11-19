/** 供应商请求的图片额度覆盖整个历史，工具schema和普通文本不进入图片计数。 */
import { describe, expect, it } from 'vitest'
import type { Api, Model } from '@earendil-works/pi-ai'
import { assertAttachmentRequest, assertNewImageMessage } from '../../../src/host/runtime/attachment-request-limits'
const model = (inputLimits: Model<Api>['inputLimits']) => ({ inputLimits } as Model<Api>)
const openai = () => ({ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } })
describe('模型请求附件额度', () => {
  it.each([
    { messages: [{ content: [openai(), openai()] }] },
    { input: [{ content: [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }, { type: 'input_image', file_id: 'file' }] }] },
    { messages: [{ content: [{ type: 'image', source: { data: 'AA==' } }, { type: 'tool_result', content: [{ type: 'image', source: { data: 'AA==' } }] }] }] },
    { contents: [{ parts: [{ inlineData: { mimeType: 'image/png', data: 'AA==' } }, { fileData: { mimeType: 'image/jpeg', fileUri: 'remote' } }] }] },
    { messages: [{ content: [{ image: { source: { bytes: new Uint8Array(1) } } }, { toolResult: { content: [{ image: { source: { bytes: new Uint8Array(1) } } }] } }] }] }
  ])('每条消息限额按实际图片结构检查', (payload) => {
    expect(() => assertAttachmentRequest(payload, model({ images: { maxPerMessage: 1 } }))).toThrow('单条消息')
    expect(() => assertAttachmentRequest(payload, model({ images: { maxPerMessage: 2, maxPerRequest: 2 } }))).not.toThrow()
  })
  it('全请求合计包括历史，未声明额度不假设供应商数字', () => {
    const payload = { messages: [{ content: [openai()] }, { content: '回答' }, { content: [openai()] }], tools: [{ type: 'image', example: { content: [openai()] } }] }
    expect(() => assertAttachmentRequest(payload, model({ images: { maxPerMessage: 1, maxPerRequest: 1 } }))).toThrow('含历史共 2')
    expect(() => assertAttachmentRequest(payload, model({ images: { maxPerMessage: 1, maxPerRequest: 2 } }))).not.toThrow()
    expect(() => assertAttachmentRequest(payload, model(undefined))).not.toThrow()
    expect(() => assertAttachmentRequest({ request: { contents: [{ parts: [{ text: 'image' }] }] } }, model({ images: { maxPerRequest: 1 } }))).not.toThrow()
  })
  it('新消息先检查已声明的消息/请求图片上限，未知请求结构不能伪称完成校验', () => {
    expect(() => assertNewImageMessage(2, model({ images: { maxPerMessage: 1 } }))).toThrow('最多接收 1')
    expect(() => assertNewImageMessage(2, model({ images: { maxPerRequest: 1 } }))).toThrow('最多接收 1')
    expect(() => assertNewImageMessage(2, model(undefined))).not.toThrow()
    expect(() => assertAttachmentRequest({ unrecognized: [] }, model({ images: { maxPerRequest: 1 } }))).toThrow('无法校验')
  })
  it('请求容量按UTF8字节和SDK实际Base64二进制表示检查', () => {
    const payload = { messages: [{ content: [{ image: { source: { bytes: Buffer.from([1,2,3,4]) } } }, { text: '中文' }] }] }
    const expected = Buffer.byteLength(JSON.stringify({ messages: [{ content: [{ image: { source: { bytes: 'AQIDBA==' } } }, { text: '中文' }] }] }), 'utf8')
    expect(() => assertAttachmentRequest(payload, model({ maxRequestBytes: expected }))).not.toThrow()
    expect(() => assertAttachmentRequest(payload, model({ maxRequestBytes: expected - 1 }))).toThrow('请求体')
  })
})
