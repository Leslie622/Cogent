/** 原文搜索/坐标行为独立于渲染引擎，覆盖 CRLF、末尾空行和零宽正则。 */
import { describe, expect, it, vi } from 'vitest'
import { codeDocument, codeLineAt, codeLocation, EMPTY_CODE_QUERY, findCodeMatches } from '@/features/home/files/visual/code-text'
import { readCodeSelection } from '@/features/home/files/visual/code-dom'

describe('源码坐标与搜索', () => {
  it('CRLF/CR显示按LF规范化，原文offset和末尾空行仍准确', () => {
    const document = codeDocument('甲\r\n乙\r丙\n')
    expect(document.contents).toBe('甲\n乙\n丙\n\n')
    expect(document.lines).toEqual([{ from: 0, to: 1 }, { from: 3, to: 4 }, { from: 5, to: 6 }, { from: 7, to: 7 }])
    expect(codeLineAt(document, 5)).toBe(2)
    expect(codeLocation(document, { line: 4 })).toMatchObject({ selection: { anchor: 7, head: 7 } })
    expect(codeLocation(codeDocument(''), { line: 1 })).toMatchObject({ selection: { anchor: 0, head: 0 } })
  })
  it('普通搜索转义、Unicode全字、大小写与零宽正则不丢匹配', () => {
    expect(findCodeMatches('a.b axb', { ...EMPTY_CODE_QUERY, search: 'a.b' }).matches).toEqual([{ from: 0, to: 3 }])
    expect(findCodeMatches('猫 大猫 猫咪 猫', { ...EMPTY_CODE_QUERY, search: '猫', wholeWord: true }).matches).toEqual([{ from: 0, to: 1 }, { from: 8, to: 9 }])
    expect(findCodeMatches('Beta beta', { ...EMPTY_CODE_QUERY, search: 'beta', caseSensitive: true }).matches).toEqual([{ from: 5, to: 9 }])
    expect(findCodeMatches('ab', { ...EMPTY_CODE_QUERY, search: '(?=.)', regexp: true }).matches).toEqual([{ from: 0, to: 0 }, { from: 1, to: 1 }])
    expect(findCodeMatches('a', { ...EMPTY_CODE_QUERY, search: '[', regexp: true }).error).not.toBeNull()
    const many = findCodeMatches('a'.repeat(10_001), { ...EMPTY_CODE_QUERY, search: 'a' })
    expect(many.truncated).toBe(true); expect(many.matches).toHaveLength(10_000)
  })
  it('ComposedRanges读取Shadow内逆向原生选择，维持anchor/head方向', () => {
    const host = document.createElement('div'), root = host.attachShadow({ mode: 'open' }), line = document.createElement('div')
    line.dataset.line = '1'; line.dataset.lineIndex = '0'; line.textContent = 'alpha beta'
    root.append(line)
    const spy = vi.spyOn(window, 'getSelection').mockImplementation(() => ({ anchorNode: host, focusNode: host, anchorOffset: 0, focusOffset: 0, direction: 'backward', getComposedRanges: () => [{ startContainer: line.firstChild!, startOffset: 3, endContainer: line.firstChild!, endOffset: 8 }] }) as unknown as Selection)
    try { expect(readCodeSelection(root, codeDocument('alpha beta'))).toEqual({ anchor: 8, head: 3 }) }
    finally { spy.mockRestore() }
  })
})
