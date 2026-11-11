/**
 * edit 工具的共享 diff 计算（步骤 3.3）。
 *
 * 搬运自 pi 上游 reference/pi/packages/coding-agent/src/core/tools/edit-diff.ts
 * （MIT License, Copyright (c) 2025 Mario Zechner）。算法逐函数原样保留，
 * 只做了三处 Cogent 化裁剪（见文末注释）。这套代码的核心价值：
 *
 * 1. **CRLF 偏移映射**（applyReplacementsToOriginal）：编辑在 LF 归一化空间
 *   匹配，但写回时把替换区间映射回原始文本 —— 未动过的行保留原始字节与
 *   行尾（CRLF 文件编辑后不会整体变 LF），新文本继承插入点所在行的行尾风格。
 *   我们是 Windows 项目，这是宝藏代码；
 * 2. **模糊匹配回退**（normalizeForFuzzyMatch）：精确匹配失败时按
 *   行尾空白/智能引号/Unicode 连字符/特殊空格归一后再匹配 —— 模型抄写
 *   引号类字符的高频笔误有第二次机会，命中后按行级放大回写（未动行保原文）；
 * 3. **窗口化 diff**（generateEditDiff）：diff 只算替换点前后 32 行的窗口，
 *   时间与内存跟随改动大小而非文件大小（万行文件改一行也秒出）。
 */

import * as Diff from 'diff'

/** CRLF/CR → LF（编辑在归一化空间匹配；写回另走 applyReplacementsToOriginal） */
export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/**
 * 把在 normalizeToLF(originalContent) 里匹配到的替换，映射回 originalContent 执行。
 * 替换区间之外的文本保留原字节（含行尾）；新文本的换行继承替换起点所在行的行尾。
 * 结果再归一化 = 替换直接作用在归一化内容上（两条路径等价，这是写回正确性的锚）。
 */
export function applyReplacementsToOriginal(
  originalContent: string,
  replacements: TextReplacement[]
): string {
  // 只有 CRLF 会改变长度：第 n 个 CRLF（原偏移 p）的 LF 在归一化文本里位于
  // p - n。给定归一化偏移，加上它前面的 CRLF 数即回到原偏移；覆盖该 LF 的
  // 区间自然覆盖整个 CRLF。
  let crlfBefore = 0
  let nextCrlf = originalContent.indexOf('\r\n')
  const toOriginal = (offset: number): number => {
    while (nextCrlf !== -1 && nextCrlf - crlfBefore < offset) {
      crlfBefore++
      nextCrlf = originalContent.indexOf('\r\n', nextCrlf + 2)
    }
    return offset + crlfBefore
  }

  const parts: string[] = []
  let endsWithCr = false
  const push = (part: string): void => {
    if (part.length === 0) return
    // 拼缝两侧的 CR + LF 会合体成一个 CRLF 换行（如保留的孤 CR 后跟以 LF
    // 开头的插入文本）：补一个 LF 让 CR 自成 CRLF，写回文件的行尾与 diff
    // 所见一致
    if (endsWithCr && part[0] === '\n') parts.push('\n')
    parts.push(part)
    endsWithCr = part[part.length - 1] === '\r'
  }
  let position = 0
  for (const replacement of replacements) {
    const start = toOriginal(replacement.matchIndex)
    push(originalContent.slice(position, start))
    const ending = getLineEndingAt(originalContent, start)
    push(ending === '\n' ? replacement.newText : replacement.newText.replaceAll('\n', ending))
    position = toOriginal(replacement.matchIndex + replacement.matchLength)
  }
  push(originalContent.slice(position))
  return parts.join('')
}

/**
 * offset 所在行的行尾：本行的 LF 或 CRLF；未收尾的末行取前一行。孤 CR 只在
 * 全文无 LF 的文件（经典 Mac 行尾）才算行尾，其余场合更可能是行内控制字符。
 */
function getLineEndingAt(content: string, offset: number): '\r\n' | '\n' | '\r' {
  let lineFeed = content.indexOf('\n', offset)
  if (lineFeed === -1) lineFeed = content.lastIndexOf('\n', offset)
  if (lineFeed === -1) return content.includes('\r') ? '\r' : '\n'
  return content[lineFeed - 1] === '\r' ? '\r\n' : '\n'
}

/**
 * 模糊匹配的归一化：渐进式变换 ——
 * 每行去尾随空白 → 智能引号归 ASCII → Unicode 连字符/破折号归 - → 特殊空格归普通空格。
 */
export function normalizeForFuzzyMatch(text: string): string {
  return (
    text
      .normalize('NFKC')
      // 每行去尾随空白
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      // 智能单引号 → '
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      // 智能双引号 → "
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      // 各类连字符/破折号 → -
      // U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
      // U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
      // 特殊空格 → 普通空格
      // U+00A0 NBSP, U+2002-U+200A 各种空格, U+202F narrow NBSP,
      // U+205F medium math space, U+3000 全角空格
      .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ')
  )
}

function splitLinesWithEndings(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? []
}

interface LineSpan {
  start: number
  end: number
}

interface MatchedEdit {
  editIndex: number
  matchIndex: number
  matchLength: number
  newText: string
}

/** 在 matchIndex 处把 matchLength 个字符替换为 newText */
export type TextReplacement = Pick<MatchedEdit, 'matchIndex' | 'matchLength' | 'newText'>

function getLineSpans(content: string): LineSpan[] {
  let offset = 0
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length }
    offset = span.end
    return span
  })
}

function getReplacementLineRange(lines: LineSpan[], replacement: TextReplacement) {
  const replacementStart = replacement.matchIndex
  const replacementEnd = replacement.matchIndex + replacement.matchLength

  let startLine = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (replacementStart >= line.start && replacementStart < line.end) {
      startLine = i
      break
    }
  }
  if (startLine === -1) {
    throw new Error('Replacement range is outside the base content.')
  }

  let endLine = startLine
  while (endLine < lines.length && lines[endLine].end < replacementEnd) {
    endLine++
  }
  if (endLine >= lines.length) {
    throw new Error('Replacement range is outside the base content.')
  }

  return { startLine, endLine: endLine + 1 }
}

function applyReplacements(content: string, replacements: TextReplacement[], offset = 0): string {
  let result = content
  // 倒序应用：后面的先替换，前面的偏移不受影响
  for (let i = replacements.length - 1; i >= 0; i--) {
    const replacement = replacements[i]
    const matchIndex = replacement.matchIndex - offset
    result =
      result.substring(0, matchIndex) +
      replacement.newText +
      result.substring(matchIndex + replacement.matchLength)
  }
  return result
}

/**
 * 把在 baseContent（归一化视图）上匹配的替换，放大成 originalContent 上的
 * 行级替换：被触碰的行从归一化基重写，其余行保留原文。
 * 以真实替换区间驱动保留 —— 归一化后重复的行不会对齐到错误的出现位置。
 */
function widenReplacementsToLines(
  originalContent: string,
  baseContent: string,
  replacements: TextReplacement[]
): TextReplacement[] {
  const originalLines = getLineSpans(originalContent)
  const baseLines = getLineSpans(baseContent)
  if (originalLines.length !== baseLines.length) {
    throw new Error('Cannot preserve unchanged lines because the base content has a different line count.')
  }

  const groups: Array<{ startLine: number; endLine: number; replacements: TextReplacement[] }> = []
  const sortedReplacements = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex)
  for (const replacement of sortedReplacements) {
    const range = getReplacementLineRange(baseLines, replacement)
    // at(-1)：空数组返回 undefined（索引访问在无 noUncheckedIndexedAccess 的
    // tsconfig 下类型不体现空态，真值检查会被 no-unnecessary-condition 打掉）
    const current = groups.at(-1)
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine)
      current.replacements.push(replacement)
      continue
    }
    groups.push({ ...range, replacements: [replacement] })
  }

  return groups.map((group) => {
    const groupStartOffset = baseLines[group.startLine].start
    const groupEndOffset = baseLines[group.endLine - 1].end
    const originalStart = originalLines[group.startLine].start
    return {
      matchIndex: originalStart,
      matchLength: originalLines[group.endLine - 1].end - originalStart,
      newText: applyReplacements(
        baseContent.slice(groupStartOffset, groupEndOffset),
        group.replacements,
        groupStartOffset
      )
    }
  })
}

export interface FuzzyMatchResult {
  /** 是否找到匹配 */
  found: boolean
  /** 匹配起点（在应当用于替换的那份内容里） */
  index: number
  /** 匹配长度 */
  matchLength: number
  /** 是否走了模糊匹配（false = 精确命中） */
  usedFuzzyMatch: boolean
  /** 替换操作应使用的内容：精确命中 = 原内容；模糊命中 = 归一化内容 */
  contentForReplacement: string
}

export interface Edit {
  oldText: string
  newText: string
}

export interface AppliedEditsResult {
  baseContent: string
  newContent: string
  /** 把 baseContent 变成 newContent 的替换列表（按位置排序） */
  replacements: TextReplacement[]
}

/**
 * 在 content 里找 oldText：先精确，后模糊。
 * 模糊命中时返回的偏移在归一化空间 —— 调用方在归一化内容上算替换，
 * 再决定多少归一化产物要写回原文。
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
  // 先试精确匹配
  const exactIndex = content.indexOf(oldText)
  if (exactIndex !== -1) {
    return {
      found: true,
      index: exactIndex,
      matchLength: oldText.length,
      usedFuzzyMatch: false,
      contentForReplacement: content
    }
  }

  // 模糊匹配 —— 全程在归一化空间
  const fuzzyContent = normalizeForFuzzyMatch(content)
  const fuzzyOldText = normalizeForFuzzyMatch(oldText)
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText)

  if (fuzzyIndex === -1) {
    return {
      found: false,
      index: -1,
      matchLength: 0,
      usedFuzzyMatch: false,
      contentForReplacement: content
    }
  }

  return {
    found: true,
    index: fuzzyIndex,
    matchLength: fuzzyOldText.length,
    usedFuzzyMatch: true,
    contentForReplacement: fuzzyContent
  }
}

function countOccurrences(content: string, oldText: string): number {
  const fuzzyContent = normalizeForFuzzyMatch(content)
  const fuzzyOldText = normalizeForFuzzyMatch(oldText)
  return fuzzyContent.split(fuzzyOldText).length - 1
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `在 ${path} 中找不到要替换的原文。oldText 必须与文件内容完全一致（含全部空白与换行）。`
    )
  }
  return new Error(
    `在 ${path} 中找不到 edits[${editIndex}] 的原文。oldText 必须与文件内容完全一致（含全部空白与换行）。`
  )
}

function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `“${path}”中该文本出现了 ${occurrences} 次。oldText 必须唯一，请多带上下文使其唯一。`
    )
  }
  return new Error(
    `“${path}”中 edits[${editIndex}] 的文本出现了 ${occurrences} 次。每个 oldText 必须唯一，请多带上下文。`
  )
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(`${path} 的 oldText 不能为空。`)
  }
  return new Error(`edits[${editIndex}].oldText 不能为空（${path}）。`)
}

function getNoChangeError(path: string, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `${path} 没有产生任何变更：替换结果与原文相同。可能是特殊字符或原文实际不存在导致的。`
    )
  }
  return new Error(`${path} 没有产生任何变更：全部替换结果与原文相同。`)
}

/**
 * 把一条或多条精确文本替换作用到 LF 归一化内容上。
 *
 * 所有 edit 都对同一份原文匹配；替换按倒序应用保持偏移稳定。任一 edit 需要
 * 模糊匹配时，整个操作在模糊归一化内容空间进行，然后把行级变更覆盖回原文 ——
 * 未触碰的行块保留原始字节。
 */
export function applyEditsToNormalizedContent(
  normalizedContent: string,
  edits: Edit[],
  path: string
): AppliedEditsResult {
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText)
  }))

  for (let i = 0; i < normalizedEdits.length; i++) {
    if (normalizedEdits[i].oldText.length === 0) {
      throw getEmptyOldTextError(path, i, normalizedEdits.length)
    }
  }

  const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText))
  const usedFuzzyMatch = initialMatches.some((match) => match.usedFuzzyMatch)
  const replacementBaseContent = usedFuzzyMatch
    ? normalizeForFuzzyMatch(normalizedContent)
    : normalizedContent

  const matchedEdits: MatchedEdit[] = []
  for (let i = 0; i < normalizedEdits.length; i++) {
    const edit = normalizedEdits[i]
    const matchResult = fuzzyFindText(replacementBaseContent, edit.oldText)
    if (!matchResult.found) {
      throw getNotFoundError(path, i, normalizedEdits.length)
    }

    const occurrences = countOccurrences(replacementBaseContent, edit.oldText)
    if (occurrences > 1) {
      throw getDuplicateError(path, i, normalizedEdits.length, occurrences)
    }

    matchedEdits.push({
      editIndex: i,
      matchIndex: matchResult.index,
      matchLength: matchResult.matchLength,
      newText: edit.newText
    })
  }

  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex)
  for (let i = 1; i < matchedEdits.length; i++) {
    const previous = matchedEdits[i - 1]
    const current = matchedEdits[i]
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(
        `${path} 中 edits[${previous.editIndex}] 与 edits[${current.editIndex}] 重叠。请合并为一个 edit 或改指互不重叠的区域。`
      )
    }
  }

  const baseContent = normalizedContent
  const replacements = usedFuzzyMatch
    ? widenReplacementsToLines(normalizedContent, replacementBaseContent, matchedEdits)
    : matchedEdits
  const newContent = applyReplacements(baseContent, replacements)

  if (baseContent === newContent) {
    throw getNoChangeError(path, normalizedEdits.length)
  }

  return { baseContent, newContent, replacements }
}

/** 行数（text.split('\n').length 口径，不建数组） */
function countLines(text: string): number {
  return countLineFeeds(text, 0, text.length) + 1
}

function countLineFeeds(text: string, start: number, end: number): number {
  let count = 0
  for (let index = text.indexOf('\n', start); index !== -1 && index < end; index = text.indexOf('\n', index + 1)) {
    count++
  }
  return count
}

/** 把 jsdiff 的行级分块格式化为带行号的展示 diff（1 起的老/新行号各自推进） */
function formatDisplayDiff(
  parts: Diff.ChangeObject<string>[],
  oldStartLine: number,
  newStartLine: number,
  lineNumWidth: number,
  contextLines: number
): { output: string[]; firstChangedLine: number | undefined } {
  const output: string[] = []

  let oldLineNum = oldStartLine
  let newLineNum = newStartLine
  let lastWasChange = false
  let firstChangedLine: number | undefined

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const raw = part.value.split('\n')
    if (raw[raw.length - 1] === '') {
      raw.pop()
    }

    if (part.added || part.removed) {
      // 首个变更行（新文件侧行号，供 UI 定位）
      if (firstChangedLine === undefined) {
        firstChangedLine = newLineNum
      }

      for (const line of raw) {
        if (part.added) {
          const lineNum = String(newLineNum).padStart(lineNumWidth, ' ')
          output.push(`+${lineNum} ${line}`)
          newLineNum++
        } else {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, ' ')
          output.push(`-${lineNum} ${line}`)
          oldLineNum++
        }
      }
      lastWasChange = true
    } else {
      // 上下文行 —— 只在紧邻变更处显示几行
      const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed)
      const hasLeadingChange = lastWasChange
      const hasTrailingChange = nextPartIsChange

      if (hasLeadingChange && hasTrailingChange) {
        if (raw.length <= contextLines * 2) {
          for (const line of raw) {
            const lineNum = String(oldLineNum).padStart(lineNumWidth, ' ')
            output.push(` ${lineNum} ${line}`)
            oldLineNum++
            newLineNum++
          }
        } else {
          const leadingLines = raw.slice(0, contextLines)
          const trailingLines = raw.slice(raw.length - contextLines)
          const skippedLines = raw.length - leadingLines.length - trailingLines.length

          for (const line of leadingLines) {
            const lineNum = String(oldLineNum).padStart(lineNumWidth, ' ')
            output.push(` ${lineNum} ${line}`)
            oldLineNum++
            newLineNum++
          }

          output.push(` ${''.padStart(lineNumWidth, ' ')} ...`)
          oldLineNum += skippedLines
          newLineNum += skippedLines

          for (const line of trailingLines) {
            const lineNum = String(oldLineNum).padStart(lineNumWidth, ' ')
            output.push(` ${lineNum} ${line}`)
            oldLineNum++
            newLineNum++
          }
        }
      } else if (hasLeadingChange) {
        const shownLines = raw.slice(0, contextLines)
        const skippedLines = raw.length - shownLines.length

        for (const line of shownLines) {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, ' ')
          output.push(` ${lineNum} ${line}`)
          oldLineNum++
          newLineNum++
        }

        if (skippedLines > 0) {
          output.push(` ${''.padStart(lineNumWidth, ' ')} ...`)
          oldLineNum += skippedLines
          newLineNum += skippedLines
        }
      } else if (hasTrailingChange) {
        const skippedLines = Math.max(0, raw.length - contextLines)
        if (skippedLines > 0) {
          output.push(` ${''.padStart(lineNumWidth, ' ')} ...`)
          oldLineNum += skippedLines
          newLineNum += skippedLines
        }

        for (const line of raw.slice(skippedLines)) {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, ' ')
          output.push(` ${lineNum} ${line}`)
          oldLineNum++
          newLineNum++
        }
      } else {
        // 与任何变更都不相邻的上下文：整段跳过（行号照常推进）
        oldLineNum += raw.length
        newLineNum += raw.length
      }

      lastWasChange = false
    }
  }

  return { output, firstChangedLine }
}

/** edit 工具 details 里的展示 diff 与统一 patch */
export interface EditDiff {
  diff: string
  patch: string
  firstChangedLine: number | undefined
}

/**
 * 替换点两侧各多留的未变更行数。远超展示用的 4 行上下文 —— jsdiff 在窗口内
 * 对齐变更的方式与全文件一致。
 */
const DIFF_WINDOW_MARGIN_LINES = 32

/**
 * 只在替换点周围做 diff：时间与内存跟随变更大小而非文件大小。结果与全文件
 * generateDiffString / 全文件 unified patch 一致（jsdiff 对窗口内重复行的对齐
 * 可能与全文件不同，属可接受的展示差异）。
 */
export function generateEditDiff(
  path: string,
  baseContent: string,
  newContent: string,
  replacements: TextReplacement[],
  contextLines = 4
): EditDiff {
  const lineNumWidth = String(Math.max(countLines(baseContent), countLines(newContent))).length
  const skipMarker = ` ${''.padStart(lineNumWidth, ' ')} ...`
  const output: string[] = []
  const hunks: Diff.StructuredPatchHunk[] = []
  let firstChangedLine: number | undefined
  for (const window of getDiffWindows(baseContent, replacements)) {
    const oldText = baseContent.slice(window.oldStart, window.oldEnd)
    const newText = newContent.slice(window.newStart, window.newEnd)
    const shown = formatDisplayDiff(
      Diff.diffLines(oldText, newText),
      window.oldLine + 1,
      window.newLine + 1,
      lineNumWidth,
      contextLines
    )
    firstChangedLine ??= shown.firstChangedLine
    // 不变行带两侧窗口都会标 skip：全文件 diff 只标一个，去重
    if (output.at(-1) === skipMarker && shown.output[0] === skipMarker) shown.output.shift()
    // 循环入列而非 spread：替换行数极多时展开会爆调用栈
    for (const line of shown.output) output.push(line)
    const patch = Diff.structuredPatch(path, path, oldText, newText, undefined, undefined, {
      context: contextLines
    })
    for (const hunk of patch.hunks) {
      hunks.push({ ...hunk, oldStart: hunk.oldStart + window.oldLine, newStart: hunk.newStart + window.newLine })
    }
  }
  const patch = Diff.formatPatch(
    { oldFileName: path, newFileName: path, oldHeader: undefined, newHeader: undefined, hunks },
    Diff.FILE_HEADERS_ONLY
  )
  return { diff: output.join('\n'), patch, firstChangedLine }
}

/** 一个或多个替换周围的_old/_new 匹配区间：偏移 + 0 起始行号 */
interface DiffWindow {
  oldStart: number
  oldEnd: number
  oldLine: number
  newStart: number
  newEnd: number
  newLine: number
}

/** offset 所在行的行首 */
function lineStartBefore(text: string, offset: number): number {
  // lastIndexOf 把负位置当 0，会把 offset 0 处的换行找出来
  return offset === 0 ? 0 : text.lastIndexOf('\n', offset - 1) + 1
}

/** 替换（已排序、互不重叠）周围带边距的整行窗口；相邻窗口合并 */
function getDiffWindows(baseContent: string, replacements: TextReplacement[]): DiffWindow[] {
  const windows: DiffWindow[] = []
  // 当前替换之前各替换累计的偏移差与行数差 + 行计数游标
  let offsetDelta = 0
  let lineDelta = 0
  let cursorOffset = 0
  let cursorLine = 0
  for (const replacement of replacements) {
    const matchEnd = replacement.matchIndex + replacement.matchLength
    let start = lineStartBefore(baseContent, replacement.matchIndex)
    for (let i = 0; i < DIFF_WINDOW_MARGIN_LINES && start > 0; i++) {
      start = lineStartBefore(baseContent, start - 1)
    }
    let end = matchEnd
    for (let i = 0; i <= DIFF_WINDOW_MARGIN_LINES && end < baseContent.length; i++) {
      const lineFeed = baseContent.indexOf('\n', i === 0 ? Math.max(matchEnd - 1, replacement.matchIndex) : end)
      end = lineFeed === -1 ? baseContent.length : lineFeed + 1
    }
    const replacementOffsetDelta = replacement.newText.length - replacement.matchLength
    const replacementLineDelta =
      countLineFeeds(replacement.newText, 0, replacement.newText.length) -
      countLineFeeds(baseContent, replacement.matchIndex, matchEnd)
    const previous = windows.at(-1)
    if (previous && start <= previous.oldEnd) {
      previous.oldEnd = Math.max(previous.oldEnd, end)
      previous.newEnd = previous.oldEnd + offsetDelta + replacementOffsetDelta
    } else {
      cursorLine += countLineFeeds(baseContent, cursorOffset, start)
      cursorOffset = start
      windows.push({
        oldStart: start,
        oldEnd: end,
        oldLine: cursorLine,
        newStart: start + offsetDelta,
        newEnd: end + offsetDelta + replacementOffsetDelta,
        newLine: cursorLine + lineDelta
      })
    }
    offsetDelta += replacementOffsetDelta
    lineDelta += replacementLineDelta
  }
  return windows
}

/*
 * Cogent 化裁剪记录（相对上游 edit-diff.ts）：
 * - computeEditsDiff / computeEditDiff（TUI 执行前预览专用）未搬 —— Cogent 无
 *   审批卡内 diff 预览消费者；将来做「审批卡显示将要做的改动」时随用随搬；
 * - generateUnifiedPatch / generateDiffString（全文件 diff，上游供渲染器与
 *   其他调用方）未搬 —— edit 工具只用 generateEditDiff（窗口化版本）；
 * - splitBom 从 utils/text.ts 并入 edit.ts（一处小函数不值得单独文件）。
 */
