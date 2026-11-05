import type { AgentTool } from '@earendil-works/pi-agent-core'
import { obj, opt, str } from '@earendil-works/pi-schema'

/**
 * 示例工具：演示 AgentTool 的标准写法。
 * parameters 用 pi-schema 构建（JSON Schema，可序列化），
 * execute 失败时直接 throw，Agent 会把错误回传给模型并标记 isError。
 */

const getCurrentTimeParameters = obj({
  timezone: opt(str({ description: 'IANA 时区，例如 Asia/Shanghai；缺省使用本地时区' }))
})

export const timeTools: AgentTool<typeof getCurrentTimeParameters>[] = [
  {
    name: 'get_current_time',
    label: '当前时间',
    description: '获取当前日期和时间，可指定时区。',
    parameters: getCurrentTimeParameters,
    execute: async (_toolCallId, params) => {
      const timezone = params.timezone
      try {
        const text = new Intl.DateTimeFormat('zh-CN', {
          dateStyle: 'full',
          timeStyle: 'long',
          timeZone: timezone
        }).format(new Date())
        return {
          content: [{ type: 'text', text }],
          details: { timezone: timezone ?? 'local' }
        }
      } catch {
        throw new Error(`无效的时区: ${timezone ?? '(empty)'}`)
      }
    }
  }
]
