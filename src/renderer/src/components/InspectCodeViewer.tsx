/**
 * 观测文本查看器：直接消费记录字符串；工具和正文由数据块放进同一分区，
 * 不再额外生成工具栏和边框。语法树只控制折叠，不改写原文。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view'
import { bracketMatching, defaultHighlightStyle, foldEffect, foldGutter, syntaxHighlighting, unfoldAll } from '@codemirror/language'
import { json } from '@codemirror/lang-json'
import { defaultKeymap } from '@codemirror/commands'
import { openSearchPanel, search, searchKeymap } from '@codemirror/search'
import { Button } from '@/components/ui/button'
import { ChevronDown } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { getJsonFoldRanges } from '@/lib/json-folding'

function applyDepth(view: EditorView, depth: string): void {
  unfoldAll(view)
  if (depth !== 'all') view.dispatch({ effects: getJsonFoldRanges(view.state.doc.toString(), Number(depth)).map((range) => foldEffect.of(range)) })
}

export default function InspectCodeViewer({ content, format, label, raw, wrap, render }: {
  content: string
  format: 'json' | 'text'
  label: string
  raw: boolean
  wrap: boolean
  render: (controls: ReactNode, body: ReactNode) => ReactNode
}) {
  const container = useRef<HTMLDivElement>(null)
  const editor = useRef<EditorView | null>(null)
  const [depth, setDepth] = useState('2')
  const depthRef = useRef('2')
  const [wrapping] = useState(() => new Compartment())

  useEffect(() => {
    if (raw) return
    const view = new EditorView({
      parent: container.current!,
      state: EditorState.create({
        doc: content,
        extensions: [
          EditorState.readOnly.of(true), EditorView.editable.of(false),
          EditorView.contentAttributes.of({ 'aria-label': label, 'aria-readonly': 'true', tabindex: '0' }),
          lineNumbers(), highlightSpecialChars(), search({ top: true }),
          keymap.of([...searchKeymap, ...defaultKeymap]), wrapping.of(EditorView.lineWrapping),
          ...(format === 'json' ? [json(), foldGutter(), bracketMatching(), syntaxHighlighting(defaultHighlightStyle)] : []),
          EditorState.phrases.of({
            'Find': '查找', 'Replace': '替换', 'next': '下一个', 'previous': '上一个',
            'all': '全部', 'match case': '区分大小写', 'regexp': '正则表达式',
            'by word': '全词匹配', 'close': '关闭', 'Fold line': '折叠此行', 'Unfold line': '展开此行',
          }),
          EditorView.theme({
            '&': { backgroundColor: 'transparent', color: 'var(--foreground)' },
            '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.7' },
            '.cm-content': { padding: '12px 0' },
            '.cm-line': { paddingLeft: '8px', paddingRight: '12px' },
            '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--muted-foreground)', border: 'none' },
            '.cm-gutterElement': { paddingLeft: '8px' },
            '.cm-search': { display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center', fontFamily: 'var(--font-sans)' },
            '.cm-search input': { minWidth: '0', maxWidth: '100%' },
            '.cm-panels': { backgroundColor: 'transparent', color: 'var(--foreground)', border: 'none' },
          }),
        ],
      }),
    })
    editor.current = view
    if (format === 'json') applyDepth(view, depthRef.current)
    return () => { editor.current = null; view.destroy() }
  }, [content, format, label, raw, wrapping])

  useEffect(() => {
    if (!raw) editor.current!.dispatch({ effects: wrapping.reconfigure(wrap ? EditorView.lineWrapping : []) })
  }, [content, format, label, raw, wrap, wrapping])

  const controls = <>
    {format === 'json' && <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="disclosure" size="console" disabled={raw} aria-label="JSON 折叠层级" />}>
        {depth === 'all' ? '全部展开' : depth === '0' ? '全部折叠' : `展开 ${depth} 层`}<ChevronDown />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={depth} onValueChange={(value: string) => { setDepth(value); depthRef.current = value; applyDepth(editor.current!, value) }}>
          <DropdownMenuRadioItem value="0" closeOnClick>全部折叠</DropdownMenuRadioItem>
          {['1', '2', '3', '4', '5'].map((level) => <DropdownMenuRadioItem key={level} value={level} closeOnClick>展开 {level} 层</DropdownMenuRadioItem>)}
          <DropdownMenuRadioItem value="all" closeOnClick>全部展开</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>}
    <Button variant="disclosure" size="console" disabled={raw} onClick={() => openSearchPanel(editor.current!)}>搜索</Button>
  </>
  const body = raw
    ? <pre className={`code-typography p-3 font-mono ${wrap ? 'whitespace-pre-wrap break-words' : 'overflow-x-auto whitespace-pre'}`}>{content}</pre>
    : <div ref={container} className="code-typography" />
  return render(controls, body)
}
