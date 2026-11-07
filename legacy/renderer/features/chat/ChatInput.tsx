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
    // v0 稿悬浮输入卡：更宽的 990px 列 + 底部留白更大
    <div className="shrink-0 px-5 pb-5">
      <form ref={formRef} onSubmit={onSubmit} className="mx-auto w-full max-w-[990px]">
        <input ref={fileInputRef} type="file" multiple className="sr-only" tabIndex={-1} onChange={onAttach} />
        {/* v0 卡片样式覆盖：25px 大圆角 + 边框 + 投影；原语的 has-* 圆角变体
            需同变体覆盖（变体类与普通类不互相覆盖）；聚焦不加 ring，保持稿的克制观感 */}
        <InputGroup className="rounded-[25px] border border-border/90 bg-card shadow-[0_12px_36px_rgba(0,0,0,0.1)] has-[textarea]:rounded-[25px] has-data-[align=block-start]:rounded-[25px] has-data-[align=block-end]:rounded-[25px] has-[[data-slot=input-group-control]:focus-visible]:ring-0">
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
            placeholder={modelUsable ? '做任何事' : '请先在设置-模型设置配置 API key'}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                formRef.current?.requestSubmit()
              }
            }}
            className="min-h-10 px-1 pt-3 text-lg"
          />
          {/* addon 必须放在 textarea 之后（官方 Callout：焦点管理依赖 DOM 顺序） */}
          <InputGroupAddon align="block-end" className="px-4 pb-3">
            <InputGroupButton
              type="button"
              size="icon-sm"
              variant="ghost"
              className="rounded-lg text-muted-foreground"
              aria-label="添加附件"
              onClick={() => fileInputRef.current?.click()}
            >
              <PlusIcon size={18} />
            </InputGroupButton>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <InputGroupButton
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={`模型：${currentModel?.name ?? '加载中'}`}
                    className="ml-auto rounded-lg px-2 text-[15px]"
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
                    variant="ghost"
                    aria-label={`推理力度：${currentEffort.name}`}
                    className="rounded-lg px-2 text-[15px] text-muted-foreground"
                  />
                }
              >
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
                Effort 紧随其后、Send 收尾 —— 不再加第二个 ml-auto，避免组内被撑开。
                发送按钮 = v0 稿的 size-10 圆形黑底（bg-foreground）+ hover 微放大 */}
            {running ? (
              <InputGroupButton
                type="button"
                size="icon-sm"
                variant="outline"
                className="size-10 rounded-full"
                aria-label="停止"
                onClick={() => void abort()}
              >
                <SquareIcon />
              </InputGroupButton>
            ) : (
              <InputGroupButton
                type="submit"
                size="icon-sm"
                className="size-10 rounded-full bg-foreground text-background transition-transform hover:scale-105 hover:bg-foreground hover:text-background disabled:opacity-40"
                disabled={!canSend}
                aria-label="发送"
              >
                <ArrowUpIcon size={18} />
              </InputGroupButton>
            )}
          </InputGroupAddon>
        </InputGroup>
      </form>
    </div>
  )
}
