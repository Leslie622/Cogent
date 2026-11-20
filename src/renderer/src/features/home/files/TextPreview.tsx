/** CodeMirror 当前文本查看器；定位越界可诊断，不以夹取行号伪装定位成功。 */
import { useEffect, useRef, useState } from 'react'
import { EditorState, StateEffect } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { openSearchPanel } from '@codemirror/search'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import type { FileLocation } from '@shared/files'
import { Button } from '@/components/ui/button'
import { readOnlyCode } from '@/lib/readonly-code'

export default function TextPreview({
  text,
  name,
  location
}: {
  text: string
  name: string
  location?: FileLocation
}) {
  const container = useRef<HTMLDivElement>(null)
  const editor = useRef<EditorView | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [position, setPosition] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    const view = new EditorView({
      parent: container.current!,
      state: EditorState.create({
        doc: text,
        extensions: [readOnlyCode(name), EditorView.lineWrapping]
      })
    })
    editor.current = view
    const load = async () => {
      if (/\.jsonl?$/i.test(name)) {
        const { json } = await import('@codemirror/lang-json')
        if (current)
          view.dispatch({
            effects: StateEffect.appendConfig.of([
              json(),
              syntaxHighlighting(defaultHighlightStyle)
            ])
          })
      } else if (/\.[cm]?[jt]sx?$/i.test(name)) {
        const { javascript } = await import('@codemirror/lang-javascript')
        if (current)
          view.dispatch({
            effects: StateEffect.appendConfig.of([
              javascript({ typescript: /\.[cm]?tsx?$/i.test(name), jsx: /x$/i.test(name) }),
              syntaxHighlighting(defaultHighlightStyle)
            ])
          })
      }
    }
    void load()
    setWarning(null)
    setPosition(null)
    if (location !== undefined) {
      if (
        location.line > view.state.doc.lines ||
        (location.endLine !== undefined && location.endLine > view.state.doc.lines)
      )
        setWarning('行号超出当前文件范围，已打开文件')
      else {
        const line = view.state.doc.line(location.line)
        if ((location.column ?? 1) > line.length + 1) setWarning('列号超出当前行范围，已打开文件')
        else {
          const anchor = line.from + (location.column ?? 1) - 1
          const head =
            location.endLine === undefined ? anchor : view.state.doc.line(location.endLine).to
          view.dispatch({
            selection: { anchor, head },
            effects: EditorView.scrollIntoView(anchor, { y: 'center' })
          })
          setPosition(location.endLine === undefined
            ? `已定位：第 ${location.line} 行，第 ${location.column ?? 1} 列`
            : `已定位：第 ${location.line}～${location.endLine} 行`)
        }
      }
    }
    return () => {
      current = false
      editor.current = null
      view.destroy()
    }
  }, [text, name, location])
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 py-2">
        <Button variant="ghost" size="sm" onClick={() => openSearchPanel(editor.current!)}>
          搜索
        </Button>
        {position !== null && <span role="status" className="text-xs">{position}</span>}
        {warning !== null && (
          <span role="status" className="text-xs">
            {warning}
          </span>
        )}
      </div>
      <div ref={container} className="code-typography min-h-0 flex-1" />
    </div>
  )
}
