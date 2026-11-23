/** 兼容必须钉住来源标记本身，不能以中文、长查询或多参数为由重写用户目标。 */
import { describe, expect, it } from 'vitest'
import { edgeExternalUrl } from '../../../../src/electron/main/browser/external-url'
import { BAIDU_HOT_SEARCH_EXTERNAL_URL, BAIDU_HOT_SEARCH_URL } from './fixtures'

describe('Edge 系统浏览器地址兼容', () => {
  it('百度热榜地址只去掉固定来源标记，保留完整中文编码和其他查询字节', () => {
    expect(edgeExternalUrl(BAIDU_HOT_SEARCH_URL)).toBe(BAIDU_HOT_SEARCH_EXTERNAL_URL)
  })
  it.each([
    ['https://www.baidu.com/s?tn=baidutop10&wd=a%20b&x=~#part', 'https://www.baidu.com/s?wd=a%20b&x=~#part'],
    ['https://www.baidu.com/s?wd=a+b&tn=baidutop10', 'https://www.baidu.com/s?wd=a+b'],
    ['https://www.baidu.com/s?tn=baidutop10#part', 'https://www.baidu.com/s#part'],
    ['https://www.baidu.com/s?tn=other&tn=baidutop10&wd=a%2Bb&tn=baidutop10', 'https://www.baidu.com/s?tn=other&wd=a%2Bb'],
  ])('参数位置与片段不影响定点兼容：%s', (input, expected) => {
    expect(edgeExternalUrl(input)).toBe(expected)
  })
  it.each([
    'https://example.org/s?tn=baidutop10',
    'http://www.baidu.com/s?tn=baidutop10',
    'https://www.baidu.com:8443/s?tn=baidutop10',
    'https://www.baidu.com/?tn=baidutop10',
    'https://www.baidu.com/s',
    'https://www.baidu.com/s?tn=other&wd=a+b',
    'https://www.baidu.com/s?tn=baidutop100&wd=a+b',
    'https://www.baidu.com/s?x=tn=baidutop10&wd=a+b#tn=baidutop10',
    'https://www.baidu.com/s?wd=tn%3Dbaidutop10',
  ])('其他站点、入口与参数保持原样：%s', value => {
    expect(edgeExternalUrl(value)).toBe(value)
  })
})
