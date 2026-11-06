/**
 * 输入区（AI Elements「Prompt Input + Model Selector」pattern 的 Cogent 版）：
 * InputGroup（textarea + 工具条）+ Attachment（附件 chip）+ 两个下拉（模型 / 推理力度）。
 * 模型/力度从 engine store 取真数据；submit 经 chat store 走 agent.submit。
 */
import { useEffect, useRef, useState } from 'react'
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentMedia,
  AttachmentTitle
} from '@/components/ui/attachment'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group'
import { ArrowUpIcon, ChevronDownIcon, FileTextIcon, PlusIcon, SquareIcon, XIcon } from 'lucide-react'
import { useEngineStore, usableModels } from '@/stores/engine'
import { useChatStore } from '@/stores/chat'
import { useUiStore } from '@/stores/ui'

/** 附件 chip 的最小形状（真实附件等 pi 支持后扩展） */
interface AttachmentFile {
  id: string
  name: string
}

/** 推理力度（pi ThinkingLevel；off=不思考） */
const EFFORTS = [
  { id: 'off', name: '关闭' },
  { id: 'minimal', name: '极低' },
  { id: 'low', name: '低' },
  { id: 'medium', name: '中' },
  { id: 'high', name: '高' },
  { id: 'xhigh', name: '很高' },
  { id: 'max', name: '最大' }
] as const

export function ChatInput() {
  const [text, setText] = useState('')
  const [files, setFiles] = useState<AttachmentFile[]>([])
  const formRef = useRef<HTMLFormElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const models = useEngineStore((s) => s.models)
  const keyConfigured = useEngineStore((s) => s.keyConfigured)
  const activeModelId = useEngineStore((s) => s.activeModelId)
  const setActiveModel = useEngineStore((s) => s.setActiveModel)
  const thinkingLevel = useEngineStore((s) => s.thinkingLevel)
  const setThinkingLevel = useEngineStore((s) => s.setThinkingLevel)

  const running = useChatStore((s) => s.running)
  const submit = useChatStore((s) => s.submit)
  const abort = useChatStore((s) => s.abort)
  const setView = useUiStore((s) => s.setView)

  // 只展示配了 key 的 provider 的模型（用户拍板：隐藏而非置灰）
  const selectable = usableModels(models, keyConfigured)
  // 选中兜底：activeModelId 因失 key/删除而不可用时回落到第一个可用模型。
  // 回落经 useEffect（渲染期 setState 违规）；无可用模型时保持空串、发送置灰
  const effectiveModelId = selectable.some((m) => m.id === activeModelId)
    ? activeModelId
    : (selectable[0]?.id ?? '')
  useEffect(() => {
    if (effectiveModelId !== activeModelId && effectiveModelId !== '') {
      setActiveModel(effectiveModelId)
    }
  }, [effectiveModelId, activeModelId, setActiveModel])

  const currentModel = selectable.find((m) => m.id === effectiveModelId)
  const currentEffort = EFFORTS.find((e) => e.id === thinkingLevel) ?? EFFORTS[3]
  const modelUsable = effectiveModelId !== ''
  const canSend = text.trim().length > 0 && modelUsable && !running

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSend) return
    void submit(text.trim(), effectiveModelId, thinkingLevel)
    setText('')
    setFiles([])
  }

  const onAttach = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files
    if (!selected) return
    setFiles((current) => [
      ...current,
      ...Array.from(selected, (file) => ({ id: crypto.randomUUID(), name: file.name }))
    ])
    event.target.value = ''
  }

  return (
    <div className="shrink-0 p-3">
      <form ref={formRef} onSubmit={onSubmit} className="mx-auto max-w-3xl">
        <input ref={fileInputRef} type="file" multiple className="sr-only" tabIndex={-1} onChange={onAttach} />
        <InputGroup>
          {files.length > 0 && (
            <InputGroupAddon align="block-start" className="flex-wrap">
              {files.map((file) => (
                <Attachment key={file.id} size="sm">
                  <AttachmentMedia>
                    <FileTextIcon />
                  </AttachmentMedia>
                  <AttachmentContent>
                    <AttachmentTitle>{file.name}</AttachmentTitle>
                  </AttachmentContent>
                  <AttachmentActions>
                    <AttachmentAction
                      aria-label={`移除 ${file.name}`}
                      onClick={() => setFiles((current) => current.filter((f) => f.id !== file.id))}
                    >
                      <XIcon />
                    </AttachmentAction>
                  </AttachmentActions>
                </Attachment>
              ))}
            </InputGroupAddon>
          )}
          <InputGroupTextarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={modelUsable ? '输入消息，Enter 发送，Shift+Enter 换行' : '请先在设置-模型设置配置 API key'}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                formRef.current?.requestSubmit()
              }
            }}
            className="p-3"
          />
          {/* addon 必须放在 textarea 之后（官方 Callout：焦点管理依赖 DOM 顺序） */}
          <InputGroupAddon align="block-end">
            <InputGroupButton
              type="button"
              size="icon-sm"
              variant="outline"
              className="rounded-full"
              aria-label="添加附件"
              onClick={() => fileInputRef.current?.click()}
            >
              <PlusIcon />
            </InputGroupButton>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <InputGroupButton
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-label={`模型：${currentModel?.name ?? '加载中'}`}
                    className="ml-auto"
                  />
                }
              >
                {currentModel?.name ?? '加载模型…'}
                <ChevronDownIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
                {selectable.length > 0 ? (
                  <DropdownMenuRadioGroup value={effectiveModelId} onValueChange={setActiveModel}>
                    {selectable.map((m) => (
                      <DropdownMenuRadioItem key={`${m.provider}/${m.id}`} value={m.id} closeOnClick>
                        <span className="flex w-full items-center gap-2">
                          <span className="truncate">{m.name}</span>
                          <span className="ml-auto shrink-0 text-xs text-muted-foreground">{m.provider}</span>
                        </span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                ) : (
                  <DropdownMenuGroup>
                    <DropdownMenuLabel className="text-muted-foreground">
                      尚未配置 API key ——
                      <button type="button" className="underline" onClick={() => setView('settings')}>
                        去设置
                      </button>
                    </DropdownMenuLabel>
                  </DropdownMenuGroup>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <InputGroupButton
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-label={`推理力度：${currentEffort.name}`}
                  />
                }
              >
                <span className="text-muted-foreground">力度</span>
                {currentEffort.name}
                <ChevronDownIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-36">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>推理力度</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={thinkingLevel} onValueChange={setThinkingLevel}>
                    {EFFORTS.map((e) => (
                      <DropdownMenuRadioItem key={e.id} value={e.id} closeOnClick>
                        {e.name}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            {/* 官方 demo 布局：仅 Model 带 ml-auto（把右侧按钮组推到右端），
                Effort 紧随其后、Send 收尾 —— 不再加第二个 ml-auto，避免组内被撑开 */}
            {running ? (
              <InputGroupButton
                type="button"
                size="icon-sm"
                variant="outline"
                className="rounded-full"
                aria-label="停止"
                onClick={() => void abort()}
              >
                <SquareIcon />
              </InputGroupButton>
            ) : (
              <InputGroupButton
                type="submit"
                size="icon-sm"
                className="rounded-full"
                disabled={!canSend}
                aria-label="发送"
              >
                <ArrowUpIcon />
              </InputGroupButton>
            )}
          </InputGroupAddon>
        </InputGroup>
      </form>
    </div>
  )
}
