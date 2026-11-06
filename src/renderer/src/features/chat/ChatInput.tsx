/**
 * 输入区（AI Elements「Prompt Input + Model Selector」pattern 的 Cogent 版）：
 * InputGroup（textarea + 工具条）+ Attachment（附件 chip）+ 两个下拉（模型 / 推理力度）。
 * 与官方 demo 结构一一对应；模型与力度列表为占位（等凭据/模型列表落地后从引擎拉取）。
 */
import { useRef, useState } from 'react'
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
import { ArrowUpIcon, ChevronDownIcon, FileTextIcon, PlusIcon, XIcon } from 'lucide-react'

/** 附件 chip 的最小形状（真实附件等 pi 支持后扩展） */
interface AttachmentFile {
  id: string
  name: string
}

/** 占位模型列表：等 credentials/模型列表落地后从引擎拉取 */
const MODELS = [
  { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash' },
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
  { id: 'gpt-5', name: 'GPT-5' }
]

/** 推理力度（官方 Effort 下拉；pi 的 thinkingBudgets 接入后接真值） */
const EFFORTS = [
  { id: 'off', name: '关闭' },
  { id: 'medium', name: '中' },
  { id: 'high', name: '高' }
]

export function ChatInput() {
  const [text, setText] = useState('')
  const [files, setFiles] = useState<AttachmentFile[]>([])
  const [model, setModel] = useState(MODELS[0].id)
  const [effort, setEffort] = useState(EFFORTS[1].id)
  const formRef = useRef<HTMLFormElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const currentModel = MODELS.find((m) => m.id === model) ?? MODELS[0]
  const currentEffort = EFFORTS.find((e) => e.id === effort) ?? EFFORTS[1]
  const canSend = text.trim().length > 0

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSend) return
    // TODO(agent.submit): 引擎接入后在此调用 window.cogent.submit，
    // 连同附件/模型/推理力度一起提交，发送中状态改为订阅引擎事件流。
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
            placeholder="输入消息，Enter 发送，Shift+Enter 换行"
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
                    aria-label={`模型：${currentModel.name}`}
                    className="ml-auto"
                  />
                }
              >
                {currentModel.name}
                <ChevronDownIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48">
                <DropdownMenuRadioGroup value={model} onValueChange={setModel}>
                  {MODELS.map((m) => (
                    <DropdownMenuRadioItem key={m.id} value={m.id} closeOnClick>
                      {m.name}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
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
                  <DropdownMenuRadioGroup value={effort} onValueChange={setEffort}>
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
            <InputGroupButton
              type="submit"
              size="icon-sm"
              className="rounded-full"
              disabled={!canSend}
              aria-label="发送"
            >
              <ArrowUpIcon />
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </form>
    </div>
  )
}
