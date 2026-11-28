/**
 * 基于 Lexical 的聊天输入编辑器：
 * - 承载纯文本与行内原子实体（ComposerEntityNode：技能与命令，不支持纯文本触发）；
 * - 监听 `/` 与 `$`/`￥`/`¥` 触发词并驱动毛玻璃候选浮层；
 * - 完整接管中文 IME、发送快捷键、粘贴图片/文件、草稿双向同步与独占命令插入。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  $createLineBreakNode,
  $createRangeSelection,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getNodeByKey,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isNodeSelection,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  BLUR_COMMAND,
  COMMAND_PRIORITY_HIGH,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  PASTE_COMMAND,
  type EditorState,
  type LexicalEditor
} from 'lexical'
import type { SendShortcut } from '@/stores/engine'
import type { SkillSummary } from '@/env.d'
import type { McpPromptInfo, McpResourceInfo } from '@shared/mcp'
import { cn } from '@/lib/utils'
import {
  $createComposerEntityNode,
  $isComposerEntityNode,
  ComposerEntityNode
} from './ComposerEntityNode'
import { CommandSuggestionPanel } from './CommandSuggestionPanel'
import { McpPromptArgumentsDialog } from './McpPromptArgumentsDialog'
import {
  buildCommandSuggestions,
  buildMcpPromptSuggestions,
  buildMcpResourceSuggestions,
  buildSkillSuggestions,
  type CommandAvailabilityContext
} from './commands'
import {
  bestSuggestionIndex,
  extractActiveTrigger,
  filterSuggestions,
  triggerSignature
} from './triggers'
import {
  ENTITY_SENTINEL,
  type ActiveTrigger,
  type ComposerEntity,
  type ComposerSuggestionItem,
  type SlashCommandExecution
} from './types'

export type LocalSlashAction = Extract<SlashCommandExecution, { kind: 'action' }>['action']

export interface ComposerLexicalEditorProps {
  draftId: string
  text: string
  entities: readonly ComposerEntity[]
  disabled: boolean
  placeholder?: string
  sendShortcut: SendShortcut
  primaryCwd?: string
  projectId?: string
  commandContext: CommandAvailabilityContext
  onChange: (text: string, entities: ComposerEntity[]) => void
  onSend: () => void
  onExecuteAction: (action: LocalSlashAction) => void
  onPasteFiles: (files: Array<File | string>) => void
  onPasteError: (error: unknown) => void
}

function isSendKeyEvent(event: KeyboardEvent, shortcut: SendShortcut): boolean {
  if (event.isComposing || event.keyCode === 229) return false
  if (event.key !== 'Enter') return false
  if (shortcut === 'enter') return !event.shiftKey
  if (shortcut === 'shift+enter') return event.shiftKey && !event.ctrlKey
  return event.ctrlKey && !event.shiftKey
}

function readDraftFromEditorState(editorState: EditorState): { text: string; entities: ComposerEntity[] } {
  let text = ''
  const entities: ComposerEntity[] = []
  editorState.read(() => {
    const root = $getRoot()
    const blocks = root.getChildren()
    blocks.forEach((block, blockIndex) => {
      if (blockIndex > 0) text += '\n'
      if (!$isParagraphNode(block)) {
        text += block.getTextContent().replaceAll(ENTITY_SENTINEL, '')
        return
      }
      for (const child of block.getChildren()) {
        if ($isComposerEntityNode(child)) {
          entities.push(child.getEntity())
          text += ENTITY_SENTINEL
        } else if ($isLineBreakNode(child)) {
          text += '\n'
        } else {
          text += child.getTextContent().replaceAll(ENTITY_SENTINEL, '')
        }
      }
    })
  })
  return { text, entities }
}

function writeDraftToEditor(editor: LexicalEditor, text: string, entities: readonly ComposerEntity[]): void {
  editor.update(
    () => {
      const root = $getRoot()
      root.clear()
      const paragraph = $createParagraphNode()
      let entityIndex = 0
      let buffer = ''
      const flushBuffer = (): void => {
        if (buffer.length > 0) {
          paragraph.append($createTextNode(buffer))
          buffer = ''
        }
      }
      for (let i = 0; i < text.length; i++) {
        const ch = text[i]
        if (ch === ENTITY_SENTINEL) {
          flushBuffer()
          const entity = entities.at(entityIndex++)
          if (entity !== undefined) paragraph.append($createComposerEntityNode(entity))
        } else if (ch === '\n') {
          flushBuffer()
          paragraph.append($createLineBreakNode())
        } else {
          buffer += ch
        }
      }
      flushBuffer()
      root.append(paragraph)
      paragraph.selectEnd()
    },
    { tag: 'cogent-hydrate' }
  )
}

function entitiesEqual(a: readonly ComposerEntity[], b: readonly ComposerEntity[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const left = a[i]
    const right = b[i]
    if (JSON.stringify(left) !== JSON.stringify(right)) return false
  }
  return true
}

interface PromptSelection {
  item: ComposerSuggestionItem & { payload: { kind: 'mcp-prompt'; prompt: McpPromptInfo } }
  anchorKey: string
  start: number
  end: number
  token: string
  draftId: string
  scopeKey: string
}

// IPC响应是版本与传输边界：MCP目录响应损坏只令该组报错，不能让既有命令/技能输入崩溃。
const mcpResourceList = z.object({ resources: z.array(z.object({ server: z.string(), name: z.string(), uri: z.string(), description: z.string().optional(), mimeType: z.string().optional() })) })
const mcpPromptList = z.object({ prompts: z.array(z.object({ server: z.string(), name: z.string(), description: z.string().optional(), arguments: z.array(z.object({ name: z.string(), description: z.string().optional(), required: z.boolean().optional() })).optional() })) })

function EditorControllerPlugin({
  draftId,
  text,
  entities,
  disabled,
  sendShortcut,
  primaryCwd,
  projectId,
  commandContext,
  onChange,
  onSend,
  onExecuteAction,
  onPasteFiles,
  onPasteError
}: Omit<ComposerLexicalEditorProps, 'placeholder'>) {
  const [editor] = useLexicalComposerContext()
  const [activeTrigger, setActiveTrigger] = useState<ActiveTrigger | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [selectionSource, setSelectionSource] = useState<'keyboard' | 'pointer'>('keyboard')
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const scopeKey = JSON.stringify([primaryCwd, projectId])
  const [mcpSnapshot, setMcpSnapshot] = useState<{ scopeKey: string; resources: McpResourceInfo[]; prompts: McpPromptInfo[] }>({ scopeKey: '', resources: [], prompts: [] })
  const [mcpLoading, setMcpLoading] = useState(false)
  const [mcpError, setMcpError] = useState<string | undefined>()
  const [mcpRevision, setMcpRevision] = useState(0)
  const [pendingPrompt, setPendingPrompt] = useState<PromptSelection | null>(null)
  const statusSignatureRef = useRef('')

  const dismissedSigRef = useRef<string | null>(null)
  const lastDraftIdRef = useRef<string | null>(null)
  const lastSyncedRef = useRef<{ text: string; entities: readonly ComposerEntity[] }>({
    text: '',
    entities: []
  })
  const callbacksRef = useRef({ onChange, onSend, onExecuteAction, onPasteFiles, onPasteError, sendShortcut })
  callbacksRef.current = { onChange, onSend, onExecuteAction, onPasteFiles, onPasteError, sendShortcut }

  // 同步编辑器的只读状态
  useEffect(() => {
    editor.setEditable(!disabled)
  }, [editor, disabled])

  // 草稿切换、初载或发送清空时水合到 Lexical
  useEffect(() => {
    const draftSwitched = lastDraftIdRef.current !== draftId
    const externallyChanged =
      text !== lastSyncedRef.current.text || !entitiesEqual(entities, lastSyncedRef.current.entities)
    if (!draftSwitched && !externallyChanged) return
    lastDraftIdRef.current = draftId
    lastSyncedRef.current = { text, entities }
    writeDraftToEditor(editor, text, entities)
    if (draftSwitched) {
      dismissedSigRef.current = null
      setActiveTrigger(null)
      setPendingPrompt(null)
    }
  }, [editor, draftId, text, entities])

  // 打开面板或切换工作区时刷新可用技能快照（与 Host 活快照对齐）
  useEffect(() => {
    if (activeTrigger === null || activeTrigger.kind === '@') return
    let cancelled = false
    setSkillsLoading(true)
    void window.cogent
      .engineRequest('skills.list', primaryCwd !== undefined ? { cwd: primaryCwd } : {})
      .then((result) => {
        if (!cancelled) setSkills(result.skills)
      })
      .catch(() => {
        if (!cancelled) setSkills([])
      })
      .finally(() => {
        if (!cancelled) setSkillsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeTrigger?.kind, primaryCwd])

  // 状态通知只按实际能力修订刷新；不同项目的迟到回包不得出现在当前候选列表。
  useEffect(() => window.cogent.onEngineEvent(event => {
    if (event.method !== 'mcp.statusChanged') return
    if (event.params.projectId !== undefined && event.params.projectId !== projectId) return
    if (event.params.cwd !== undefined && event.params.cwd !== primaryCwd) return
    const signature = JSON.stringify(event.params.servers.map(server => [server.poolKey, server.state, server.revision]))
    if (signature === statusSignatureRef.current) return
    statusSignatureRef.current = signature
    setMcpRevision(revision => revision + 1)
  }), [primaryCwd, projectId])

  useEffect(() => {
    if (activeTrigger === null || activeTrigger.kind === '$') return
    let cancelled = false
    setMcpLoading(true)
    setMcpError(undefined)
    const scope = { ...(primaryCwd !== undefined && { cwd: primaryCwd }), ...(projectId !== undefined && { projectId }) }
    const request = activeTrigger.kind === '@'
      ? window.cogent.engineRequest('mcp.resources.list', scope).then((value: unknown) => {
        const result = mcpResourceList.safeParse(value)
        if (!result.success) throw new Error('MCP 资源目录响应格式不合法，请重试连接')
        return { resources: result.data.resources, prompts: [] }
      })
      : window.cogent.engineRequest('mcp.prompts.list', scope).then((value: unknown) => {
        const result = mcpPromptList.safeParse(value)
        if (!result.success) throw new Error('MCP 提示词目录响应格式不合法，请重试连接')
        return { resources: [], prompts: result.data.prompts }
      })
    void request.then(result => {
      if (!cancelled) setMcpSnapshot({ scopeKey, ...result })
    }).catch((error: unknown) => {
      if (cancelled) return
      setMcpSnapshot({ scopeKey, resources: [], prompts: [] })
      setMcpError(`MCP 候选加载失败：${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => { if (!cancelled) setMcpLoading(false) })
    return () => { cancelled = true }
  }, [activeTrigger?.kind, primaryCwd, projectId, scopeKey, mcpRevision])

  useEffect(() => { setPendingPrompt(null) }, [scopeKey])

  const allSuggestions = useMemo<ComposerSuggestionItem[]>(() => {
    if (activeTrigger === null) return []
    if (activeTrigger.kind === '@') return buildMcpResourceSuggestions(mcpSnapshot.scopeKey === scopeKey ? mcpSnapshot.resources : [])
    const skillItems = buildSkillSuggestions(skills)
    if (activeTrigger.kind === '$') return skillItems
    return [...buildCommandSuggestions(commandContext), ...skillItems, ...buildMcpPromptSuggestions(mcpSnapshot.scopeKey === scopeKey ? mcpSnapshot.prompts : [])]
  }, [activeTrigger?.kind, skills, commandContext, mcpSnapshot, scopeKey])

  const filteredSuggestions = useMemo(
    () => (activeTrigger === null ? [] : filterSuggestions(allSuggestions, activeTrigger.query)),
    [allSuggestions, activeTrigger]
  )

  const isOpen = !disabled && activeTrigger !== null

  useEffect(() => {
    if (disabled || activeTrigger === null) {
      setSelectedIndex(0)
      return
    }
    setSelectionSource('keyboard')
    setSelectedIndex(bestSuggestionIndex(filteredSuggestions, activeTrigger.query))
  }, [disabled, activeTrigger, filteredSuggestions])

  const applySuggestion = useCallback(
    (item: ComposerSuggestionItem, promptArguments?: Record<string, string>, savedSelection?: PromptSelection) => {
      if (item.payload.kind === 'mcp-prompt' && (item.payload.prompt.arguments?.length ?? 0) > 0 && promptArguments === undefined) {
        const payload = item.payload
        editor.getEditorState().read(() => {
          const selection = $getSelection()
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return
          const node = selection.anchor.getNode()
          if (!$isTextNode(node)) return
          const trigger = extractActiveTrigger(node.getTextContent().slice(0, selection.anchor.offset))
          if (trigger === null) return
          setPendingPrompt({ item: { ...item, payload }, anchorKey: node.getKey(), start: trigger.start, end: trigger.end,
            token: node.getTextContent().slice(trigger.start, trigger.end), draftId, scopeKey })
        })
        dismissedSigRef.current = triggerSignature(activeTrigger)
        setActiveTrigger(null)
        return
      }
      if (savedSelection !== undefined && (savedSelection.draftId !== draftId || savedSelection.scopeKey !== scopeKey)) return
      let pendingAction: LocalSlashAction | undefined
      editor.update(
        () => {
          if (savedSelection !== undefined) {
            const node = $getNodeByKey(savedSelection.anchorKey)
            if (!$isTextNode(node) || node.getTextContent().slice(savedSelection.start, savedSelection.end) !== savedSelection.token) return
            const restored = $createRangeSelection()
            restored.setTextNodeRange(node, savedSelection.end, node, savedSelection.end)
            $setSelection(restored)
          }
          const selection = $getSelection()
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return
          const anchorNode = selection.anchor.getNode()
          if (!$isTextNode(anchorNode)) return
          const offset = selection.anchor.offset
          const before = anchorNode.getTextContent().slice(0, offset)
          const trigger = extractActiveTrigger(before)
          if (trigger === null) return

          selection.setTextNodeRange(anchorNode, trigger.start, anchorNode, trigger.end)
          if (item.payload.kind === 'command') {
            const exec = item.payload.command.execution
            if (exec.kind === 'action') {
              selection.removeText()
              pendingAction = exec.action
              return
            }
            const entity: ComposerEntity = {
              id: crypto.randomUUID(),
              kind: 'command',
              name: exec.name,
              mode: exec.kind === 'standalone' ? 'standalone' : 'prompt'
            }
            const entityNode = $createComposerEntityNode(entity)
            const trailingSpace = $createTextNode(' ')
            selection.insertNodes([entityNode, trailingSpace])
            trailingSpace.selectEnd()
            return
          }

          const payload = item.payload
          const entity: ComposerEntity = payload.kind === 'mcp-resource' ? {
            id: crypto.randomUUID(), kind: 'mcp-resource', name: payload.name, server: payload.server, uri: payload.uri
          } : payload.kind === 'mcp-prompt' ? {
            id: crypto.randomUUID(), kind: 'mcp-prompt', name: payload.prompt.name, server: payload.prompt.server,
            ...(promptArguments !== undefined && { arguments: promptArguments })
          } : {
            id: crypto.randomUUID(),
            kind: 'skill',
            name: payload.name,
            scope: payload.scope,
            ...(payload.eco === true && { eco: true })
          }

          const entityNode = $createComposerEntityNode(entity)
          const trailingSpace = $createTextNode(' ')
          selection.insertNodes([entityNode, trailingSpace])
          trailingSpace.selectEnd()
        },
        {
          // Lexical 的 editor.update 默认微任务批处理；动作回调必须在 onUpdate 内触发，
          // 否则同步读取时 pendingAction 仍为 undefined
          onUpdate: () => {
            if (pendingAction !== undefined) {
              callbacksRef.current.onExecuteAction(pendingAction)
            }
            requestAnimationFrame(() => editor.focus())
          }
        }
      )

      dismissedSigRef.current = null
      setActiveTrigger(null)
      setSelectedIndex(0)
    },
    [editor, draftId, scopeKey, activeTrigger]
  )

  // 监听选区与文本变化提取触发词
  useEffect(() => {
    return editor.registerUpdateListener(({ editorState, tags }) => {
      if (tags.has('cogent-hydrate') || editor.isComposing()) return
      editorState.read(() => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          // 选区展开（如全选）意味着当前触发词已不活跃，抑制记录随之作废
          dismissedSigRef.current = null
          setActiveTrigger(null)
          return
        }
        const anchorNode = selection.anchor.getNode()
        if (!$isTextNode(anchorNode)) {
          // 锚点不在文本节点（如全删后的空段落）：触发词已不存在，抑制记录随之作废
          dismissedSigRef.current = null
          setActiveTrigger(null)
          return
        }
        const before = anchorNode.getTextContent().slice(0, selection.anchor.offset)
        const next = extractActiveTrigger(before)
        if (next === null) {
          dismissedSigRef.current = null
          setActiveTrigger(null)
          return
        }
        next.anchorKey = anchorNode.getKey()
        const sig = triggerSignature(next)
        if (dismissedSigRef.current !== null && dismissedSigRef.current !== sig) {
          dismissedSigRef.current = null
        }
        if (dismissedSigRef.current === sig) {
          setActiveTrigger(null)
          return
        }
        setActiveTrigger((prev) =>
          prev?.kind === next.kind && prev.query === next.query && prev.start === next.start &&
          prev.anchorKey === next.anchorKey
            ? prev
            : next
        )
      })
    })
  }, [editor])

  // 失焦收起面板（点击浮层选项时由 onMouseDown preventDefault 保护不失焦）
  useEffect(() => {
    return editor.registerCommand(
      BLUR_COMMAND,
      () => {
        setActiveTrigger(null)
        return false
      },
      COMMAND_PRIORITY_HIGH
    )
  }, [editor])

  // 粘贴拦截：图片/文件附件沿用原逻辑，纯文本剥离伪造哨兵
  useEffect(() => {
    return editor.registerCommand(
      PASTE_COMMAND,
      (event) => {
        if (!(event instanceof ClipboardEvent)) return false
        const data = event.clipboardData
        if (data === null) return false
        const plain = data.getData('text/plain')
        if (plain !== '' && /<table[\s>]/i.test(data.getData('text/html'))) return false
        const files = Array.from(data.files)
        if (files.length > 0) {
          event.preventDefault()
          callbacksRef.current.onPasteFiles(files)
          return true
        }
        if (
          plain === '' ||
          data.getData('text/uri-list').split(/\r?\n/).some((line) => line.startsWith('file://')) ||
          data.types.includes('Files')
        ) {
          event.preventDefault()
          void window.cogent
            .clipboardFiles()
            .then(callbacksRef.current.onPasteFiles, callbacksRef.current.onPasteError)
          return true
        }
        if (plain.includes(ENTITY_SENTINEL)) {
          event.preventDefault()
          editor.update(() => {
            const selection = $getSelection()
            if ($isRangeSelection(selection)) {
              selection.insertRawText(plain.replaceAll(ENTITY_SENTINEL, ''))
            }
          })
          return true
        }
        return false
      },
      COMMAND_PRIORITY_HIGH
    )
  }, [editor])

  // 键盘导航、实体整块删除与发送快捷键
  useEffect(() => {
    const unregisters = [
      editor.registerCommand(
        KEY_BACKSPACE_COMMAND,
        (event) => {
          const selection = $getSelection()
          if ($isNodeSelection(selection)) {
            const nodes = selection.getNodes()
            if (nodes.some($isComposerEntityNode)) {
              event.preventDefault()
              for (const node of nodes) node.remove()
              return true
            }
            return false
          }
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false
          const anchorNode = selection.anchor.getNode()
          const offset = selection.anchor.offset
          if ($isTextNode(anchorNode) && offset === 0) {
            const prev = anchorNode.getPreviousSibling()
            if ($isComposerEntityNode(prev)) {
              event.preventDefault()
              prev.remove()
              return true
            }
          } else if ($isElementNode(anchorNode) && offset > 0) {
            const prev = anchorNode.getChildAtIndex(offset - 1)
            if ($isComposerEntityNode(prev)) {
              event.preventDefault()
              prev.remove()
              return true
            }
          }
          return false
        },
        COMMAND_PRIORITY_HIGH
      ),
      editor.registerCommand(
        KEY_DELETE_COMMAND,
        (event) => {
          const selection = $getSelection()
          if ($isNodeSelection(selection)) {
            const nodes = selection.getNodes()
            if (nodes.some($isComposerEntityNode)) {
              event.preventDefault()
              for (const node of nodes) node.remove()
              return true
            }
            return false
          }
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false
          const anchorNode = selection.anchor.getNode()
          const offset = selection.anchor.offset
          if ($isTextNode(anchorNode) && offset === anchorNode.getTextContentSize()) {
            const next = anchorNode.getNextSibling()
            if ($isComposerEntityNode(next)) {
              event.preventDefault()
              next.remove()
              return true
            }
          } else if ($isElementNode(anchorNode)) {
            const next = anchorNode.getChildAtIndex(offset)
            if ($isComposerEntityNode(next)) {
              event.preventDefault()
              next.remove()
              return true
            }
          }
          return false
        },
        COMMAND_PRIORITY_HIGH
      ),
      editor.registerCommand(
        KEY_ARROW_DOWN_COMMAND,
        (event) => {
          if (!isOpen || filteredSuggestions.length === 0) return false
          event.preventDefault()
          setSelectionSource('keyboard')
          setSelectedIndex((prev) => (prev + 1) % filteredSuggestions.length)
          return true
        },
        COMMAND_PRIORITY_HIGH
      ),
      editor.registerCommand(
        KEY_ARROW_UP_COMMAND,
        (event) => {
          if (!isOpen || filteredSuggestions.length === 0) return false
          event.preventDefault()
          setSelectionSource('keyboard')
          setSelectedIndex((prev) => (prev - 1 + filteredSuggestions.length) % filteredSuggestions.length)
          return true
        },
        COMMAND_PRIORITY_HIGH
      ),
      editor.registerCommand(
        KEY_TAB_COMMAND,
        (event) => {
          if (!isOpen || filteredSuggestions.length === 0) return false
          event.preventDefault()
          const picked = filteredSuggestions.at(selectedIndex) ?? filteredSuggestions.at(0)
          if (picked !== undefined) applySuggestion(picked)
          return true
        },
        COMMAND_PRIORITY_HIGH
      ),
      editor.registerCommand(
        KEY_ESCAPE_COMMAND,
        (event) => {
          if (!isOpen) return false
          event.preventDefault()
          dismissedSigRef.current = triggerSignature(activeTrigger)
          setActiveTrigger(null)
          return true
        },
        COMMAND_PRIORITY_HIGH
      ),
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event) => {
          if (event === null) return false
          if (event.isComposing || event.keyCode === 229) return false
          if (isOpen && filteredSuggestions.length > 0) {
            event.preventDefault()
            const picked = filteredSuggestions.at(selectedIndex) ?? filteredSuggestions.at(0)
            if (picked !== undefined) applySuggestion(picked)
            return true
          }
          if (isSendKeyEvent(event, callbacksRef.current.sendShortcut)) {
            event.preventDefault()
            callbacksRef.current.onSend()
            return true
          }
          return false
        },
        COMMAND_PRIORITY_HIGH
      )
    ]
    return () => {
      for (const unregister of unregisters) unregister()
    }
  }, [editor, isOpen, filteredSuggestions, selectedIndex, activeTrigger, applySuggestion])

  const handleEditorChange = useCallback((editorState: EditorState, _ed: LexicalEditor, tags: Set<string>) => {
    if (tags.has('cogent-hydrate')) return
    const next = readDraftFromEditorState(editorState)
    if (
      next.text === lastSyncedRef.current.text &&
      entitiesEqual(next.entities, lastSyncedRef.current.entities)
    ) {
      return
    }
    lastSyncedRef.current = next
    callbacksRef.current.onChange(next.text, next.entities)
  }, [])

  return (
    <>
      <OnChangePlugin onChange={handleEditorChange} ignoreSelectionChange />
      {!disabled && activeTrigger !== null && (
        <CommandSuggestionPanel
          triggerKind={activeTrigger.kind}
          items={filteredSuggestions}
          selectedIndex={selectedIndex}
          selectionSource={selectionSource}
          loading={activeTrigger.kind === '@' ? mcpLoading : skillsLoading || mcpLoading}
          error={mcpError}
          onSelectIndex={(index) => {
            setSelectionSource('pointer')
            setSelectedIndex(index)
          }}
          onPick={applySuggestion}
        />
      )}
      {pendingPrompt !== null && <McpPromptArgumentsDialog key={`${pendingPrompt.draftId}:${pendingPrompt.scopeKey}:${pendingPrompt.item.id}`}
        prompt={pendingPrompt.item.payload.prompt}
        onCancel={() => { setPendingPrompt(null); requestAnimationFrame(() => editor.focus()) }}
        onConfirm={args => { applySuggestion(pendingPrompt.item, args, pendingPrompt); setPendingPrompt(null) }} />}
    </>
  )
}

const COMPOSER_INITIAL_CONFIG = {
  namespace: 'cogent-composer',
  editable: true,
  nodes: [ComposerEntityNode],
  theme: {
    paragraph: 'm-0 leading-relaxed'
  },
  onError: (error: Error) => {
    console.error('[composer] lexical error:', error)
  }
}

export function ComposerLexicalEditor(props: ComposerLexicalEditorProps) {
  return (
    <LexicalComposer initialConfig={COMPOSER_INITIAL_CONFIG}>
      <div className="relative w-full min-w-0">
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              data-slot="input-group-control"
              aria-label="聊天输入框"
              aria-placeholder={props.placeholder ?? '随心输入'}
              placeholder={
                <div className="content-typography pointer-events-none absolute top-5 right-4 left-4 text-placeholder select-none">
                  {props.placeholder ?? '随心输入'}
                </div>
              }
              className={cn(
                'content-typography max-h-52 min-h-[3.5rem] w-full overflow-y-auto px-4 pt-5 pb-2 outline-none break-words',
                props.disabled && 'cursor-not-allowed opacity-60'
              )}
            />
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <EditorControllerPlugin
          draftId={props.draftId}
          text={props.text}
          entities={props.entities}
          disabled={props.disabled}
          sendShortcut={props.sendShortcut}
          primaryCwd={props.primaryCwd}
          projectId={props.projectId}
          commandContext={props.commandContext}
          onChange={props.onChange}
          onSend={props.onSend}
          onExecuteAction={props.onExecuteAction}
          onPasteFiles={props.onPasteFiles}
          onPasteError={props.onPasteError}
        />
      </div>
    </LexicalComposer>
  )
}
