/** 数量和容量是消息准入政策，不从图片限额推导普通文件数量。 */
import { describe, expect, it } from 'vitest'
import { ATTACHMENT_LIMITS as limits, attachmentAdmissionIssue, type AttachmentMetadata } from '../../src/shared/attachments'
const file = (size = 1): AttachmentMetadata => ({ name: 'a.txt', size, mime: 'text/plain' })
const image = (): AttachmentMetadata => ({ name: 'a.png', size: 1, mime: 'image/png' })
describe('附件准入', () => {
  it('普通文件超过20不限制，图片仍独立计数', () => {
    const ordinary = Array.from({ length: 1000 }, () => file())
    expect(attachmentAdmissionIssue(file(), ordinary)).toBeUndefined()
    const images = Array.from({ length: 20 }, image)
    expect(attachmentAdmissionIssue(file(), images)).toBeUndefined()
    expect(attachmentAdmissionIssue(image(), images)).toContain('20')
    expect(attachmentAdmissionIssue(image(), ordinary)).toBeUndefined()
  })
  it('单文件、原生图片与消息合计精确按字节执行，满额时仍可加入空文件', () => {
    expect(attachmentAdmissionIssue(file(limits.fileBytes), [])).toBeUndefined()
    expect(attachmentAdmissionIssue(file(limits.fileBytes + 1), [])).toContain('单文件')
    expect(attachmentAdmissionIssue({ ...image(), size: limits.imageBytes + 1 }, [])).toContain('图片上限')
    const existing = [file(limits.fileBytes), file(limits.fileBytes)]
    expect(attachmentAdmissionIssue(file(0), existing)).toBeUndefined()
    expect(attachmentAdmissionIssue(file(1), existing)).toContain('合计')
  })
})
