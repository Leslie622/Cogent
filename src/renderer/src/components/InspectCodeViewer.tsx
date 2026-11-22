/**
 * 观测文本查看器：直接消费记录字符串；工具和正文由数据块放进同一分区，
 * 不再额外生成工具栏和边框。语法树只控制折叠，不改写原文。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Compartment, EditorState, Prec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { bracketMatching, defaultHighlightStyle, foldEffect, foldGutter, syntaxHighlighting, unfoldAll } from '@codemirror/language'
import { json } from '@codemirror/lang-json'
import { openSearchPanel } from '@codemirror/search'
import { Button } from '@/components/ui/button'
import { ChevronDown } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { getJsonFoldRanges } from '@/lib/json-folding'
import { readOnlyCode } from '@/lib/readonly-code'

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
          readOnlyCode(label), wrapping.of(EditorView.lineWrapping),
          ...(format === 'json' ? [json(), foldGutter(), bracketMatching(), syntaxHighlighting(defaultHighlightStyle)] : []),
          EditorState.phrases.of({
            'Fold line': '折叠此行', 'Unfold line': '展开此行',
          }),
          // 控制台按内容长到上限；文件预览仍用共享主题的填满容器语义。
          Prec.high(EditorView.theme({
            '&': { height: 'auto', maxHeight: 'min(60cqh, 40rem)' },
            '.cm-scroller': { minHeight: '0', overflow: 'auto', overscrollBehavior: 'contain' },
            '.cm-gutterElement': { paddingLeft: '8px' },
            '.cm-panels': { backgroundColor: 'transparent' },
          })),
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
    ? <pre className={`code-typography max-h-[min(60cqh,40rem)] overflow-auto overscroll-contain p-3 font-mono ${wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'}`}>{content}</pre>
    : <div ref={container} className="code-typography" />
  return render(controls, body)
}
