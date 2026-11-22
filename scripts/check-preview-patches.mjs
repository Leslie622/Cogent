/** 直接执行依赖中已补丁的函数；隔离副本逆向/重放补丁，避免干扰运行中的产品验收。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'
import ts from 'typescript'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = resolve(workspace, process.env.PREVIEW_PATCHES_EVIDENCE ?? 'tmp/preview-patches')
const isolated = mkdtempSync(join(tmpdir(), 'cogent-preview-patches-'))
const installed = new Map()
const report = { checks: [], packages: [], patchRuns: [], launchedElectron: false }
const check = (name, run) => { run(); report.checks.push(name) }
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const gitBlob = bytes => createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex')

function source(path) {
  const text = readFileSync(path, 'utf8')
  const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  assert.equal(ast.parseDiagnostics.length, 0, path + ': JavaScript语法无效')
  return ast
}

function find(root, predicate) {
  const found = []
  const visit = node => {
    if (predicate(node)) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(root)
  return found
}

function only(nodes, name) {
  assert.equal(nodes.length, 1, name + '必须唯一，依赖升级后需重新核对提取边界')
  return nodes[0]
}

function namedFunction(ast, name) {
  return only(find(ast, node => ts.isFunctionDeclaration(node) && node.name?.text === name), name)
}

function evaluate(node, ast, globals = {}) {
  return vm.runInNewContext(`(${node.getText(ast)})`, globals, { filename: ast.fileName, timeout: 1000 })
}

function formatter(ast) {
  const builder = namedFunction(ast, 'wG')
  const property = only(find(builder, node => ts.isPropertyAssignment(node) && node.name.getText(ast) === 'formatter'), 'bubble tooltip formatter')
  assert.ok(ts.isArrowFunction(property.initializer))
  return evaluate(property.initializer, ast)
}

function verifyPptx(ast, patched) {
  const format = formatter(ast)
  const dom = new JSDOM('<!doctype html><div id="tooltip"></div>')
  const tooltip = dom.window.document.getElementById('tooltip')
  const safe = (html, text) => {
    tooltip.innerHTML = html
    assert.equal(tooltip.textContent, text)
    assert.equal(tooltip.children.length, 1)
    assert.equal(tooltip.firstElementChild.tagName, 'BR')
    assert.equal(tooltip.firstElementChild.attributes.length, 0)
  }
  try {
    if (!patched) {
      const attack = '<img src=x onerror="globalThis.compromised=true">'
      tooltip.innerHTML = format({ seriesName: attack, value: [1, 2, 3] })
      assert.ok(tooltip.querySelector('img[onerror]'), '未补丁的负对照应暴露HTML注入')
      report.checks.push('PPTX未补丁负对照确实产生img/onerror节点')
      return
    }
    check('PPTX正常数字、零和负值保持可读', () => {
      safe(format({ seriesName: 'Revenue', value: [0, -2.5, 30] }), 'Revenuex: 0, y: -2.5, size: 30')
    })
    check('PPTX五个HTML元字符在所有动态字段转义', () => {
      const chars = '&<>"\''
      const escaped = '&amp;&lt;&gt;&quot;&#39;'
      assert.equal(format({ seriesName: chars, value: [chars, chars, chars] }), `${escaped}<br/>x: ${escaped}, y: ${escaped}, size: ${escaped}`)
      safe(format({ seriesName: chars, value: [chars, chars, chars] }), `${chars}x: ${chars}, y: ${chars}, size: ${chars}`)
    })
    for (const [slot, payload] of [
      ['seriesName', '<img src=x onerror="globalThis.compromised=true">&\''],
      ['x', '<svg onload="globalThis.compromised=true">&\''],
      ['y', '</div><script>globalThis.compromised=true</script>&"\''],
      ['size', '<a href="javascript:alert(1)">size</a>&\'']
    ]) check('PPTX恶意' + slot + '仅显示文字', () => {
      const values = [1, 2, 3]
      const index = ['x', 'y', 'size'].indexOf(slot)
      if (index >= 0) values[index] = payload
      const name = slot === 'seriesName' ? payload : 'series'
      safe(format({ seriesName: name, value: values }), `${name}x: ${values[0]}, y: ${values[1]}, size: ${values[2]}`)
    })
    check('PPTX null和undefined动态值变为空文本', () => {
      safe(format({ seriesName: null, value: [null, undefined, null] }), 'x: , y: , size: ')
    })
  } finally {
    dom.window.close()
  }
}

function verifyXlsx(ast, label) {
  const grid = namedFunction(ast, 'XlsxGrid')
  check(label + ' Grid解构宿主回调且hook依赖包含回调', () => {
    assert.ok(ts.isObjectBindingPattern(grid.parameters[0].name))
    assert.ok(grid.parameters[0].name.elements.some(item => item.name.getText(ast) === 'onOpenLink'))
  })
  const declaration = only(find(grid, node => ts.isVariableDeclaration(node) && node.name.getText(ast) === 'openHyperlink'), 'openHyperlink')
  const call = declaration.initializer
  assert.ok(ts.isCallExpression(call) && ts.isArrowFunction(call.arguments[0]))
  assert.ok(ts.isArrayLiteralExpression(call.arguments[1]))
  assert.ok(call.arguments[1].elements.some(item => item.getText(ast) === 'onOpenLink'))
  const parser = namedFunction(ast, 'parseInternalSheetLink')
  const cellParser = namedFunction(ast, 'parseA1CellReference3')
  const parserFunction = evaluate(parser, ast, { parseA1CellReference3: evaluate(cellParser, ast) })
  const execute = (target, location, callback, activeSheetIndex = 0, withWindow = true) => {
    const events = []
    const host = url => { events.push(['host', url]); callback(url) }
    const globals = {
      parseInternalSheetLink: parserFunction,
      sheets: [{ name: 'Summary' }, { name: "O'Brien Notes" }],
      activeSheetIndex,
      onOpenLink: callback && host,
      selectCell: cell => events.push(['select', cell.col, cell.row]),
      setPendingNavigation: navigation => events.push(['pending', navigation.sheetIndex, navigation.cell.col, navigation.cell.row]),
      setActiveSheetIndex: index => events.push(['sheet', index])
    }
    if (withWindow) globals.window = { open: (...args) => events.push(['window', ...args]) }
    evaluate(call.arguments[0], ast, globals)(target, location)
    return events
  }
  check(label + ' 外链只进入宿主一次且不回落window.open', () => {
    assert.deepEqual(execute('https://example.com/a?x=1&y=2', undefined, () => {}), [['host', 'https://example.com/a?x=1&y=2']])
  })
  check(label + ' 无宿主时保留原库的noopener原生出口', () => {
    assert.deepEqual(execute('https://example.com'), [['window', 'https://example.com', '_blank', 'noopener,noreferrer']])
    assert.deepEqual(execute('https://example.com', undefined, undefined, 0, false), [])
  })
  check(label + ' 同工作表定位保留内部选择', () => {
    assert.deepEqual(execute('#Summary!B7', undefined, () => assert.fail('内部定位不得打开宿主')), [['select', 1, 6]])
  })
  check(label + ' 跨工作表定位处理引号与单引号转义', () => {
    assert.deepEqual(execute("#'O''Brien Notes'!C9", undefined, () => assert.fail('内部定位不得打开宿主')), [['pending', 1, 2, 8], ['sheet', 1]])
  })
  check(label + ' location内部定位优先于外部target', () => {
    assert.deepEqual(execute('https://example.com', 'Summary!A2', () => assert.fail('location定位不得打开宿主')), [['select', 0, 1]])
    assert.deepEqual(execute('#Missing!A1', undefined, () => assert.fail('未知内部表不得外跳')), [])
  })
  check(label + ' 宿主负责URL校验且异常不得原生回落', () => {
    assert.deepEqual(execute('javascript:alert(1)', undefined, () => {}), [['host', 'javascript:alert(1)']])
    assert.throws(() => execute('https://example.com', undefined, () => { throw new Error('rejected by host') }), /rejected by host/)
  })
  check(label + ' 真实ViewerInner执行时将同一回调传给Grid', () => {
    const callback = () => {}
    const gridType = Symbol('XlsxGrid')
    const received = []
    const jsx = (type, props) => { if (type === gridType) received.push(props); return { type, props } }
    const inner = evaluate(namedFunction(ast, 'XlsxViewerInner'), ast, {
      useViewerPalette: () => ({}),
      XlsxFileSizeLimitExceededError: class extends Error {},
      ViewerAppearanceContext: { Provider: Symbol('appearance') },
      ViewerContext: { Provider: Symbol('controller') },
      classNames: () => '', resolveToolbar: () => null,
      XlsxGrid: gridType, jsx3: jsx, jsxs3: jsx, import_jsx_runtime3: { jsx, jsxs: jsx }
    })
    inner({ controller: { displayFileName: 'patch.xlsx', error: null }, onOpenLink: callback })
    assert.equal(received.length, 1)
    assert.equal(received[0].onOpenLink, callback)
  })
}

function verifyTypes() {
  const callers = ['mts', 'cts'].map(extension => {
    const target = resolve(workspace, 'node_modules/@extend-ai/react-xlsx/dist/index.' + (extension === 'mts' ? 'js' : 'cjs')).replaceAll('\\', '/')
    const file = join(isolated, 'contract.' + extension)
    writeFileSync(file, `import type { XlsxViewerProps } from ${JSON.stringify(target)}
type Handler = NonNullable<XlsxViewerProps['onOpenLink']>
const good: Handler = (url: string): void => { void url }
// @ts-expect-error 外链回调必须接受string，不能接受number。
const bad: Handler = (url: number): void => { void url }
type Assert<T extends true> = T
type Optional = Assert<undefined extends XlsxViewerProps['onOpenLink'] ? true : false>
type ExactlyString = Assert<Parameters<Handler>[0] extends string ? string extends Parameters<Handler>[0] ? true : false : false>
type ExactlyVoid = Assert<ReturnType<Handler> extends void ? void extends ReturnType<Handler> ? true : false : false>
export type Contract = [Optional, ExactlyString, ExactlyVoid]
void good; void bad
`)
    return file
  })
  const program = ts.createProgram(callers, { strict: true, noEmit: true, skipLibCheck: true, types: [], target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext })
  check('XLSX ESM/CJS调用者真实编译：可选(string)=>void且拒绝number', () => {
    const diagnostics = ts.getPreEmitDiagnostics(program)
    assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: name => name, getCurrentDirectory: () => workspace, getNewLine: () => '\n' }))
    for (const declaration of ['index.d.ts', 'index.d.cts']) {
      assert.ok(program.getSourceFile(resolve(workspace, 'node_modules/@extend-ai/react-xlsx/dist', declaration)), declaration + '必须由实际调用者解析加载')
    }
  })
}

function patchCommand(reverse) {
  const args = [resolve(workspace, 'node_modules/patch-package/index.js'), '--error-on-fail']
  if (reverse) args.push('--reverse')
  const result = spawnSync(process.execPath, args, { cwd: isolated, encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, CI: 'true' } })
  const entry = { reverse, status: result.status, stdout: result.stdout, stderr: result.stderr }
  report.patchRuns.push(entry)
  if (result.error) throw result.error
  assert.equal(result.status, 0, JSON.stringify(entry))
}

try {
  mkdirSync(join(isolated, 'patches'))
  writeFileSync(join(isolated, 'package.json'), JSON.stringify({ name: 'preview-patch-verification', version: '1.0.0', dependencies: { '@aiden0z/pptx-renderer': '1.2.4', '@extend-ai/react-xlsx': '0.16.0' } }))
  const patchedFiles = []
  for (const [name, version, patch] of [
    ['@aiden0z/pptx-renderer', '1.2.4', '@aiden0z+pptx-renderer+1.2.4.patch'],
    ['@extend-ai/react-xlsx', '0.16.0', '@extend-ai+react-xlsx+0.16.0.patch']
  ]) {
    const metadata = resolve(workspace, 'node_modules', name, 'package.json')
    assert.equal(JSON.parse(readFileSync(metadata, 'utf8')).version, version)
    const targetMetadata = join(isolated, 'node_modules', name, 'package.json')
    mkdirSync(dirname(targetMetadata), { recursive: true })
    copyFileSync(metadata, targetMetadata)
    const patchFile = resolve(workspace, 'patches', patch)
    copyFileSync(patchFile, join(isolated, 'patches', patch))
    const text = readFileSync(patchFile, 'utf8')
    report.packages.push({ name, version, patch, sha256: sha256(text) })
    for (const match of text.matchAll(/^diff --git a\/(.+) b\/(.+)\r?\nindex ([a-f0-9]+)\.\.([a-f0-9]+)/gm)) {
      const [, before, after, oldBlob, newBlob] = match
      assert.equal(before, after)
      const target = resolve(isolated, after)
      const nested = relative(isolated, target)
      assert.ok(!isAbsolute(nested) && nested !== '..' && !nested.startsWith('..' + sep), '补丁路径必须留在隔离根目录')
      const bytes = readFileSync(resolve(workspace, after))
      installed.set(after, bytes)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, bytes)
      patchedFiles.push({ path: after, oldBlob, newBlob, sha256: sha256(bytes) })
    }
  }
  assert.equal(patchedFiles.length, 5)
  const pptxPath = 'node_modules/@aiden0z/pptx-renderer/dist/aiden0z-pptx-renderer.browser.es.js'
  verifyPptx(source(resolve(workspace, pptxPath)), true)
  for (const [file, label] of [['index.js', 'XLSX ESM'], ['index.cjs', 'XLSX CJS']]) {
    verifyXlsx(source(resolve(workspace, 'node_modules/@extend-ai/react-xlsx/dist', file)), label)
  }
  verifyTypes()
  patchCommand(true)
  check('两个补丁实际逆向成功且五文件均还原上游Git blob', () => {
    for (const file of patchedFiles) assert.ok(gitBlob(readFileSync(resolve(isolated, file.path))).startsWith(file.oldBlob), file.path)
  })
  verifyPptx(source(resolve(isolated, pptxPath)), false)
  patchCommand(false)
  check('两个补丁真实重放后五文件匹配补丁Git blob且与安装源仅允许换行差异', () => {
    for (const file of patchedFiles) {
      const replayed = readFileSync(resolve(isolated, file.path))
      const original = installed.get(file.path)
      assert.ok(gitBlob(replayed).startsWith(file.newBlob), file.path + '重放结果必须精确匹配补丁记录')
      if (sha256(replayed) !== file.sha256) {
        assert.equal(original.toString().replaceAll('\r\n', '\n'), replayed.toString().replaceAll('\r\n', '\n'), file.path + '除换行外内容必须相同')
        report.installedNewlineDifferences ??= []
        report.installedNewlineDifferences.push({ path: file.path, originalBytes: original.length, canonicalBytes: replayed.length, canonicalBlob: gitBlob(replayed) })
      }
    }
  })
  check('活动node_modules五文件保持原字节', () => {
    for (const [path, bytes] of installed) assert.equal(sha256(readFileSync(resolve(workspace, path))), sha256(bytes), path)
  })
  report.files = patchedFiles
  report.passed = true
} catch (error) {
  report.passed = false
  report.error = error.stack
  process.exitCode = 1
} finally {
  // 临时目录来自mkdtemp；清理前再次验证绝对路径，绝不递归触碰工作区或系统临时根。
  const temporaryRelative = relative(resolve(tmpdir()), isolated)
  assert.ok(temporaryRelative.startsWith('cogent-preview-patches-') && !isAbsolute(temporaryRelative) && !temporaryRelative.includes(sep))
  rmSync(isolated, { recursive: true, force: true })
  report.temporaryCopyRemoved = true
  mkdirSync(evidence, { recursive: true })
  writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}
