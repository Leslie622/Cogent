/** 观测面板与文件预览共享只读、搜索和主题配置；定位、折叠等各由调用方负责。 */
import { EditorState } from '@codemirror/state'
import { EditorView, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap } from '@codemirror/commands'
import { search, searchKeymap } from '@codemirror/search'
export function readOnlyCode(label: string) {
  return [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.contentAttributes.of({
      'aria-label': label,
      'aria-readonly': 'true',
      tabindex: '0'
    }),
    lineNumbers(),
    highlightSpecialChars(),
    search({ top: true }),
    keymap.of([...searchKeymap, ...defaultKeymap]),
    EditorState.phrases.of({
      Find: '查找',
      Replace: '替换',
      next: '下一个',
      previous: '上一个',
      all: '全部',
      'match case': '区分大小写',
      regexp: '正则表达式',
      'by word': '全词匹配',
      close: '关闭'
    }),
    EditorView.theme({
      '&': { backgroundColor: 'transparent', color: 'var(--foreground)', height: '100%' },
      '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.7', overflow: 'auto' },
      '.cm-content': { padding: '12px 0' },
      '.cm-line': { paddingLeft: '8px', paddingRight: '12px' },
      '.cm-gutters': {
        backgroundColor: 'transparent',
        color: 'var(--muted-foreground)',
        border: 'none'
      },
      '.cm-search': {
        display: 'flex',
        flexWrap: 'wrap',
        gap: '4px',
        alignItems: 'center',
        fontFamily: 'var(--font-sans)'
      },
      '.cm-search input': { minWidth: '0', maxWidth: '100%' },
      '.cm-panels': {
        backgroundColor: 'var(--background)',
        color: 'var(--foreground)',
        border: 'none'
      }
    })
  ]
}
