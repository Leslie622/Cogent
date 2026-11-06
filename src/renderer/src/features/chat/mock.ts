/**
 * 占位 mock 数据：storage 落地（路线第 3 项）后整个文件删除，
 * 会话/消息改为从引擎拉取。形状即未来协议消息模型的参考草稿。
 */

export interface MockSession {
  id: string
  title: string
  /** 相对时间文案（真实实现改为时间戳，由 UI 格式化） */
  time: string
}

export interface MockMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
}

export const mockSessions: MockSession[] = [
  { id: 's1', title: '探索 pi 源码的简洁实现', time: '2 分钟前' },
  { id: 's2', title: 'Electron + pi + React + shadcn', time: '16 小时前' },
  { id: 's3', title: '拉取最新代码', time: '昨天' }
]

export const mockMessages: MockMessage[] = [
  { id: 'm1', role: 'user', content: '帮我看看 pi 的 agent-loop 是怎么实现的？' },
  {
    id: 'm2',
    role: 'assistant',
    content:
      'pi-agent-core 的核心是 agent-loop.js（680 行）：外层循环处理 follow-up 队列，内层循环处理工具调用与 steering 消息，每轮把 LLM 流式输出转译成事件推给订阅者。这是一条占位消息，用于撑起消息流布局。'
  }
]
