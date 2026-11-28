/** MCP 交互响应失败保留表单；resolved事件配对请求，跨会话结果不误清当前面板。 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ElicitationPanel } from '@/features/home/ElicitationPanel'
import { emptyBucket, useChatStore } from '@/stores/chat'
import { bindEngineEvents } from '@/stores/chat/events'
import type { EngineEvent, McpElicitationRequest } from '@/env.d'

const initialState = { ...useChatStore.getState() }
const respond = vi.fn<(params: unknown) => Promise<{ ok: true }>>()
const openUrl = vi.fn<(url: string) => Promise<void>>()
let consume: (event: EngineEvent) => void
let unbind: () => void
const base: McpElicitationRequest = { requestId: 'form-one', sessionId: 'one', server: 'docs', message: '输入项目名称', mode: 'form',
  requestedSchema: { type: 'object', properties: { name: { type: 'string', minLength: 4 } }, required: ['name'] } }
beforeEach(() => {
  useChatStore.setState(initialState, true)
  respond.mockReset().mockResolvedValue({ ok: true })
  openUrl.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('cogent', { ...window.cogent, mcp: { elicitationRespond: respond, openUrl },
    onEngineEvent: (callback: typeof consume) => { consume = callback; return () => {} } })
  unbind = bindEngineEvents()
})
afterEach(() => unbind())
function mount(request: McpElicitationRequest = base): void {
  useChatStore.setState({ activeSessionId: request.sessionId,
    bySession: { [request.sessionId]: { ...emptyBucket(), pendingElicitations: [request] } } })
  render(<ElicitationPanel />)
}

it('Host断开时清理所有挂起MCP表单，恢复输入位置', () => {
  mount()
  expect(screen.getByLabelText('name *')).toBeInTheDocument()
  act(() => consume({ method: 'host.disconnected', params: { message: '引擎已断开' } }))
  expect(useChatStore.getState().bySession.one?.pendingElicitations).toEqual([])
  expect(screen.queryByRole('form', { name: 'MCP 信息请求' })).not.toBeInTheDocument()
})

it('Host拒绝无效答案后保留输入，修正提交成功后等待匹配resolved再关闭', async () => {
  mount()
  respond.mockRejectedValueOnce(new Error('MCP 表单答案不符合字段要求'))
  fireEvent.change(screen.getByLabelText('name *'), { target: { value: 'bad' } })
  fireEvent.click(screen.getByRole('button', { name: '提交' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('字段要求')
  expect(screen.getByLabelText('name *')).toHaveValue('bad')
  expect(useChatStore.getState().bySession.one?.pendingElicitations).toHaveLength(1)
  fireEvent.change(screen.getByLabelText('name *'), { target: { value: 'valid project' } })
  fireEvent.click(screen.getByRole('button', { name: '提交' }))
  await waitFor(() => expect(respond).toHaveBeenLastCalledWith({ requestId: 'form-one', action: 'accept', content: { name: 'valid project' } }))
  expect(screen.getByLabelText('name *')).toHaveValue('valid project')
  act(() => consume({ method: 'mcp.elicitation.resolved', params: { sessionId: 'one', requestId: 'other-request' } }))
  expect(screen.getByLabelText('name *')).toBeInTheDocument()
  act(() => consume({ method: 'mcp.elicitation.resolved', params: { sessionId: 'one', requestId: 'form-one' } }))
  expect(screen.queryByRole('form', { name: 'MCP 信息请求' })).not.toBeInTheDocument()
})

it('必填布尔框未勾选也提交显式false，不遗漏必填字段', async () => {
  mount({ ...base, requestedSchema: { type: 'object', properties: { publish: { type: 'boolean', title: '是否发布' } }, required: ['publish'] } })
  fireEvent.click(screen.getByRole('button', { name: '提交' }))
  await waitFor(() => expect(respond).toHaveBeenCalledWith({ requestId: 'form-one', action: 'accept', content: { publish: false } }))
})

it('URL模式经特权浏览器接口打开，并只传用户选择的完成动作', async () => {
  mount({ requestId: 'url-one', sessionId: 'one', server: 'docs', message: '完成网站授权', mode: 'url', url: 'https://accounts.example/authorize', elicitationId: 'server-id' })
  expect(screen.getByText('accounts.example')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '在浏览器打开' }))
  expect(openUrl).toHaveBeenCalledWith('https://accounts.example/authorize')
  fireEvent.click(screen.getByRole('button', { name: '我已完成' }))
  await waitFor(() => expect(respond).toHaveBeenCalledWith({ requestId: 'url-one', action: 'accept' }))
})

it('旧会话resolved只移除旧请求，当前会话的表单与输入保留', () => {
  mount()
  act(() => {
    useChatStore.setState(state => ({ activeSessionId: 'two', bySession: { ...state.bySession,
      two: { ...emptyBucket(), pendingElicitations: [{ ...base, requestId: 'form-two', sessionId: 'two' }] } } }))
  })
  fireEvent.change(screen.getByLabelText('name *'), { target: { value: 'new project' } })
  act(() => consume({ method: 'mcp.elicitation.resolved', params: { sessionId: 'one', requestId: 'form-one' } }))
  expect(screen.getByLabelText('name *')).toHaveValue('new project')
  expect(useChatStore.getState().bySession.two?.pendingElicitations).toHaveLength(1)
})
