/**
 * tool-spill.ts 单元测试（docs/计划/上下文工程实现.md）：
 * - 非 MCP 工具与阈值内 MCP 工具直通；
 * - 超 24K 文本落盘 `<hostRoot>/tool-outputs/v1/`，保留头 16K + 尾 4K 与黑盒提示；
 * - 代理对安全切片不劈裂 emoji；非文本块（图片）原样保留；写盘失败降级截断不抛错。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MCP_TOOL_SPILL_MAX_CHARS,
  sliceHeadSafe,
  sliceTailSafe,
  spillMcpToolResult
} from '../../../src/host/runtime/tool-spill'

const tempDirs: string[] = []
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('sliceHeadSafe / sliceTailSafe', () => {
  it('UTF-16 代理对边界安全，不产生孤立代理项', () => {
    const emoji = '🚀' // length === 2
    const text = `ab${emoji}cd` // indices: 0:a, 1:b, 2:hi, 3:lo, 4:c, 5:d
    expect(sliceHeadSafe(text, 3)).toBe('ab')
    expect(sliceHeadSafe(text, 4)).toBe(`ab${emoji}`)
    expect(sliceTailSafe(text, 3)).toBe('cd')
    expect(sliceTailSafe(text, 4)).toBe(`${emoji}cd`)
  })
})

describe('spillMcpToolResult', () => {
  it('非 mcp__ 工具与未超阈值 MCP 工具返回 undefined（直通）', () => {
    const root = makeTempDir('cogent-spill-')
    const huge = 'x'.repeat(MCP_TOOL_SPILL_MAX_CHARS + 500)
    expect(spillMcpToolResult('read', [{ type: 'text', text: huge }], root)).toBeUndefined()
    expect(spillMcpToolResult('mcp__demo__echo', [{ type: 'text', text: 'short' }], root)).toBeUndefined()
  })

  it('超阈值 MCP 输出落盘完整内容，保留头尾与图片块且附黑盒路径说明', () => {
    const root = makeTempDir('cogent-spill-')
    const headMark = 'HEAD_MARKER_'
    const tailMark = '_TAIL_MARKER'
    const full = headMark + 'a'.repeat(30_000) + tailMark
    const img = { type: 'image' as const, data: 'AQID', mimeType: 'image/png' }

    const res = spillMcpToolResult('mcp__demo__fetch', [{ type: 'text', text: full }, img], root)
    expect(res).toBeDefined()
    expect(res!.originalChars).toBe(full.length)
    expect(res!.artifactPath).toBeDefined()
    expect(existsSync(res!.artifactPath!)).toBe(true)
    expect(readFileSync(res!.artifactPath!, 'utf-8')).toBe(full)

    expect(res!.content).toHaveLength(2)
    expect(res!.content[1]).toEqual(img)
    const text = res!.content[0].type === 'text' ? res!.content[0].text : ''
    expect(text).toContain(headMark)
    expect(text).toContain(tailMark)
    expect(text).toContain(res!.artifactPath!)
    expect(text).toContain('切勿向用户暴露此路径')
    expect(text.length).toBeLessThan(full.length)
  })

  it('写盘失败时降级为纯头尾截断，不抛异常', () => {
    const root = makeTempDir('cogent-spill-fail-')
    // 占住 tool-outputs 文件名使 mkdirSync 失败
    writeFileSync(join(root, 'tool-outputs'), 'block', 'utf-8')
    const full = 'z'.repeat(26_000)
    const res = spillMcpToolResult('mcp__demo__fetch', [{ type: 'text', text: full }], root)
    expect(res).toBeDefined()
    expect(res!.artifactPath).toBeUndefined()
    const text = res!.content[0].type === 'text' ? res!.content[0].text : ''
    expect(text).toContain('工具输出已截断')
    expect(text.length).toBeLessThan(full.length)
  })
})
