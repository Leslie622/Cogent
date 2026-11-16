/**
 * QuestionPanel 组件测试（RTL + jsdom，形状同 todo-strip.render.test.tsx）——
 * 钉 2026-11-16 向导式改版的关键行为：单题视图 + ‹n/m› 切换、**点击即
 * 确定**（单选点选项/键盘选中 = 落草稿自动推进，末题即整卡提交；多选
 * 勾选切换需「继续」收题；「其他」输入框 Enter 收题）、忽略 = 清草稿
 * 推进（跳过不进提交载荷）、「其他」输入优先于选项、键盘模型
 * （Tab/上下高亮，回车或空格选中）。respondQuestion 以 mock 覆写：
 * 真实现会调 window.cogent（jsdom 无此面）。
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore, type PendingQuestion } from '@/stores/chat'
import { QuestionPanel } from './QuestionPanel'

const SID = 's-question-panel'
const initialState = { ...useChatStore.getState() }
beforeEach(() => {
  useChatStore.setState(initialState, true)
})

const TWO_QUESTIONS: PendingQuestion = {
  requestId: 'rq-1',
  questions: [
    {
      question: '界面风格选哪种？',
      header: '风格',
      options: [
        { label: '亮色', description: '浅色主题' },
        { label: '暗色', description: '深色主题' }
      ]
    },
    {
      question: '部署到哪个环境？',
      options: [{ label: '测试环境' }, { label: '生产环境' }]
    }
  ]
}

function mount(pending: PendingQuestion = TWO_QUESTIONS): HTMLElement {
  useChatStore.setState({
    activeSessionId: SID,
    pendingQuestionsBySession: { [SID]: [pending] },
    respondQuestion: vi.fn().mockResolvedValue(undefined)
  })
  const { container } = render(<QuestionPanel />)
  return container.querySelector('div[tabindex="-1"]') as HTMLElement
}

describe('QuestionPanel 向导式（单题视图 + 切换）', () => {
  it('多问题只显示当前题：头部问题正文 + 1/2 切换器，‹ 禁用 › 可点', () => {
    mount()
    expect(screen.getByText('界面风格选哪种？')).toBeInTheDocument()
    expect(screen.queryByText('部署到哪个环境？')).not.toBeInTheDocument()
    expect(screen.getByText('1/2')).toBeInTheDocument()
    expect(screen.getByLabelText('上一问')).toBeDisabled()
    expect(screen.getByLabelText('下一问')).toBeEnabled()
    // 选项带序号；header 呈胶囊文案
    expect(screen.getByText('1.')).toBeInTheDocument()
    expect(screen.getByText('风格')).toBeInTheDocument()
  })

  it('切换器翻页：› 到第 2 题（2/2、› 禁用），‹ 翻回第 1 题', () => {
    mount()
    fireEvent.click(screen.getByLabelText('下一问'))
    expect(screen.getByText('部署到哪个环境？')).toBeInTheDocument()
    expect(screen.getByText('2/2')).toBeInTheDocument()
    expect(screen.getByLabelText('下一问')).toBeDisabled()
    fireEvent.click(screen.getByLabelText('上一问'))
    expect(screen.getByText('界面风格选哪种？')).toBeInTheDocument()
  })

  it('单选点击即确定并自动推进：草稿保留可翻回改选（改选 = 点已选项取消留本题）', () => {
    mount()
    fireEvent.click(screen.getByText('暗色'))
    // 未点任何按钮，已自动翻到第 2 题
    expect(screen.getByText('2/2')).toBeInTheDocument()
    expect(useChatStore.getState().respondQuestion).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('上一问'))
    // 翻回第 1 题：草稿在（暗色选中）
    expect(screen.getByText('暗色').closest('button')).toHaveClass('bg-muted')
    // 点已选中项 = 取消，留本题重选（不推进）
    fireEvent.click(screen.getByText('暗色'))
    expect(screen.getByText('1/2')).toBeInTheDocument()
    expect(screen.getByText('暗色').closest('button')).not.toHaveClass('bg-muted')
  })

  it('单问题卡：无切换器，主钮即「提交」', () => {
    mount({
      requestId: 'rq-single',
      questions: [
        { question: '继续吗？', options: [{ label: '继续' }, { label: '停止' }] }
      ]
    })
    expect(screen.queryByText('1/1')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '提交' })).toBeInTheDocument()
  })

  it('末题单选点击即整卡提交（多题草稿一并提交）', () => {
    mount()
    fireEvent.click(screen.getByText('亮色')) // 第 1 题：自动推进
    fireEvent.click(screen.getByText('生产环境')) // 末题：点击即提交
    expect(useChatStore.getState().respondQuestion).toHaveBeenCalledWith('rq-1', [
      '亮色',
      '生产环境'
    ])
  })
})

describe('QuestionPanel 忽略（分题跳过）', () => {
  it('忽略 = 清当前题草稿并推进到下一题', () => {
    mount()
    // 第 1 题作答推进后翻回，让第 1 题带草稿再忽略
    fireEvent.click(screen.getByText('暗色'))
    fireEvent.click(screen.getByLabelText('上一问'))
    fireEvent.click(screen.getByRole('button', { name: '忽略' }))
    // 已推进到第 2 题
    expect(screen.getByText('2/2')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('上一问'))
    // 第 1 题草稿已清：无选中
    expect(screen.getByText('暗色').closest('button')).not.toHaveClass('bg-muted')
  })

  it('末题忽略 = 清草稿并整卡提交（被忽略题传空串，卡收掉不留"没反应"态）', () => {
    mount()
    fireEvent.click(screen.getByText('亮色')) // 第 1 题作答，自动推进
    fireEvent.change(screen.getByPlaceholderText('输入你的回答...'), {
      target: { value: '先看情况' }
    })
    fireEvent.click(screen.getByRole('button', { name: '忽略' })) // 末题忽略
    // 整卡提交：第 1 题草稿保留、第 2 题空串（忽略 override，不读旧 Other 草稿）
    expect(useChatStore.getState().respondQuestion).toHaveBeenCalledWith('rq-1', [
      '亮色',
      ''
    ])
  })

  it('跳过的题以空串进提交载荷（引擎按跳过处理）', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: '忽略' })) // 第 1 题跳过
    fireEvent.click(screen.getByText('生产环境')) // 末题点击即提交
    const respond = useChatStore.getState().respondQuestion
    expect(respond).toHaveBeenCalledWith('rq-1', ['', '生产环境'])
  })
})

describe('QuestionPanel 提交语义', () => {
  it('「其他」输入优先于选项；非末题「继续」以草稿收题翻页', () => {
    mount()
    fireEvent.change(screen.getByPlaceholderText('输入你的回答...'), {
      target: { value: '跟系统走' }
    })
    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    // 翻到第 2 题，未提交
    expect(useChatStore.getState().respondQuestion).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('生产环境')) // 末题点击即提交
    expect(useChatStore.getState().respondQuestion).toHaveBeenCalledWith('rq-1', [
      '跟系统走',
      '生产环境'
    ])
  })

  it('「其他」输入框 Enter = 以输入收题推进（末题即提交）', () => {
    mount()
    fireEvent.change(screen.getByPlaceholderText('输入你的回答...'), {
      target: { value: '跟系统走' }
    })
    fireEvent.keyDown(screen.getByPlaceholderText('输入你的回答...'), { key: 'Enter' })
    // 推进到末题未提交；末题输入 Enter 即整卡提交
    expect(useChatStore.getState().respondQuestion).not.toHaveBeenCalled()
    const input2 = screen.getByPlaceholderText('输入你的回答...')
    fireEvent.change(input2, { target: { value: '灰度环境' } })
    fireEvent.keyDown(input2, { key: 'Enter' })
    expect(useChatStore.getState().respondQuestion).toHaveBeenCalledWith('rq-1', [
      '跟系统走',
      '灰度环境'
    ])
  })

  it('多选题点击是勾选切换（不推进），「提交」整组收题（数组形态，引擎侧 join）', () => {
    mount({
      requestId: 'rq-multi',
      questions: [
        {
          question: '集成哪些服务？',
          multiSelect: true,
          options: [{ label: 'GitHub' }, { label: 'GitLab' }]
        }
      ]
    })
    fireEvent.click(screen.getByText('GitHub'))
    fireEvent.click(screen.getByText('GitLab'))
    // 多选不自动推进：仍在本题，未提交
    expect(useChatStore.getState().respondQuestion).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('GitHub')) // 再点取消
    fireEvent.click(screen.getByText('GitHub')) // 重新勾上
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    // 数组序 = 点击追加序（取消 GitHub 后重勾，GitHub 排在 GitLab 后）
    expect(useChatStore.getState().respondQuestion).toHaveBeenCalledWith('rq-multi', [
      ['GitLab', 'GitHub']
    ])
  })
})

describe('QuestionPanel 键盘模型（提示与行为同真：Tab/上下高亮，回车或空格选中）', () => {
  it('底部提示 = zcode 同款文案', () => {
    mount()
    expect(screen.getByText('使用 Tab / 上下键选择，回车或空格选中')).toBeInTheDocument()
  })

  it('↓ 高亮首项 → Enter = 选中并自动推进（与点击同语义）', () => {
    const card = mount()
    fireEvent.keyDown(card, { key: 'ArrowDown' })
    fireEvent.keyDown(card, { key: 'Enter' })
    expect(screen.getByText('2/2')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('上一问'))
    expect(screen.getByText('亮色').closest('button')).toHaveClass('bg-muted')
  })

  it('空格同 Enter：高亮第二项按空格 = 选中并推进', () => {
    const card = mount()
    fireEvent.keyDown(card, { key: 'ArrowDown' })
    fireEvent.keyDown(card, { key: 'ArrowDown' })
    fireEvent.keyDown(card, { key: ' ' })
    expect(screen.getByText('2/2')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('上一问'))
    expect(screen.getByText('暗色').closest('button')).toHaveClass('bg-muted')
  })

  it('高亮走到「其他」行按 Enter = 聚焦输入框（不收题）', () => {
    const card = mount()
    fireEvent.keyDown(card, { key: 'ArrowDown' }) // 选项 1
    fireEvent.keyDown(card, { key: 'ArrowDown' }) // 选项 2
    fireEvent.keyDown(card, { key: 'ArrowDown' }) // 其他行
    fireEvent.keyDown(card, { key: 'Enter' })
    expect(document.activeElement).toBe(screen.getByPlaceholderText('输入你的回答...'))
    expect(useChatStore.getState().respondQuestion).not.toHaveBeenCalled()
  })

  it('Tab 循环：Shift+Tab 从首项绕到末行（其他行）', () => {
    const card = mount()
    fireEvent.keyDown(card, { key: 'ArrowDown' }) // 高亮 0（首项）
    fireEvent.keyDown(card, { key: 'Tab', shiftKey: true }) // 绕到 rowCount-1
    // 此时 Enter 应聚焦输入框（证明高亮在「其他」行）
    fireEvent.keyDown(card, { key: 'Enter' })
    expect(document.activeElement).toBe(screen.getByPlaceholderText('输入你的回答...'))
  })

  it('输入框内敲空格不被吞（无高亮时不拦截冒泡键）', () => {
    mount()
    const input = screen.getByPlaceholderText('输入你的回答...')
    fireEvent.focus(input) // onFocus 清高亮
    fireEvent.keyDown(input, { key: ' ' })
    fireEvent.change(input, { target: { value: 'a b' } })
    expect(input).toHaveValue('a b')
    // 选项未被误选（高亮 -1 时 Enter/空格零动作）
    expect(screen.getByText('亮色').closest('button')).not.toHaveClass('bg-muted')
  })
})
