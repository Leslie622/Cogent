import { describe, expect, it } from 'vitest'
import { allowedBrowserUrl, permissionKey } from '../../../../src/electron/main/browser/policy'
import { browserAddress, publicBrowserHistory } from '../../../../src/shared/browser'

describe('普通浏览器的地址与数据边界', () => {
  it('开发地址补 http，正常裸域补 https，未知协议不降级为搜索', () => {
    expect(browserAddress('localhost:5173/a')).toBe('http://localhost:5173/a')
    expect(browserAddress('[::1]:8080')).toBe('http://[::1]:8080/')
    expect(browserAddress('example.org/docs')).toBe('https://example.org/docs')
    expect(browserAddress('example.org:8080/docs')).toBe('https://example.org:8080/docs')
    expect(browserAddress('app.localhost:5173')).toBe('http://app.localhost:5173/')
    expect(browserAddress('中文 文档')).toBe('https://www.bing.com/search?q=%E4%B8%AD%E6%96%87%20%E6%96%87%E6%A1%A3')
    for (const value of ['javascript:alert(1)', 'file:///C:/secret.txt', 'https://user:password@example.org']) expect(() => browserAddress(value)).toThrow()
  })
  it('保护当前服务端口的所有 hostname 与 websocket，保留其他开发端口', () => {
    for (const value of ['http://localhost:19200', 'ws://evil.example:19200', 'http://127.1:19200', 'http://[::ffff:127.0.0.1]:19200']) expect(allowedBrowserUrl(value, [19200])).toBe(false)
    expect(allowedBrowserUrl('http://localhost:5173', [19200])).toBe(true)
    expect(allowedBrowserUrl('cogent-preview://valid-id/index.html', [], new Set(['valid-id']))).toBe(true)
    expect(allowedBrowserUrl('cogent-preview://other/index.html', [], new Set(['valid-id']))).toBe(false)
    expect(allowedBrowserUrl('file:///C:/file.html', [])).toBe(false)
  })
  it('权限请求按种类与媒体类型区分，录音不能借用剪贴板确认', () => {
    expect(permissionKey('https://example.org/a', 'media', ['video', 'audio'])).toBe(permissionKey('https://example.org', 'media', ['audio', 'video']))
    expect(permissionKey('https://example.org', 'media', ['audio'])).not.toBe(permissionKey('https://example.org', 'clipboard-read'))
  })
  it('公开历史只留 URL/title，不把 Chromium 的表单 pageState 或 capability URL 落盘', () => {
    const entries = [{ url: 'https://example.org', title: '公开', pageState: 'secret-form-base64' }, { url: 'cogent-preview://token/index.html', title: '私密资源', pageState: 'another-secret' }]
    expect(publicBrowserHistory(entries)).toEqual([{ url: 'https://example.org', title: '公开' }])
  })
})
