/**
 * 设置页的独立模型探测：复用聊天使用的 pi 路由与鉴权，不创建会话或装配工具。
 * 网络是外部边界；只有流收到 done 才算连通，错误和提前结束都必须明确失败。
 */
import { getSupportedThinkingLevels, type Api, type Model } from '@earendil-works/pi-ai'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'

export async function testModelConnectivity(
  runtime: Pick<ModelRuntime, 'streamSimple'>,
  model: Model<Api>
): Promise<{ elapsedMs: number }> {
  const startedAt = performance.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60_000)
  // 取消请求同时结束等待；方言懒加载或上游不响应取消时也不能让测试永久挂起。
  const deadline = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('模型测试超时（60 秒）')), { once: true })
  })
  // 探测取最低可用档；512 避免部分端点拒绝过小预算，同时不超过模型输出上限。
  const level = getSupportedThinkingLevels(model)[0]
  try {
    const stream = runtime.streamSimple(model, {
      systemPrompt: 'You are Cogent connectivity probe.',
      messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }]
    }, {
      signal: controller.signal,
      maxTokens: Math.min(512, model.maxTokens),
      reasoning: level === 'off' ? undefined : level,
      maxRetries: 0
    })
    const consume = async () => {
      for await (const event of stream) {
        if (event.type === 'error') {
          throw new Error(event.error.errorMessage ?? '模型测试失败')
        }
        if (event.type === 'done') return { elapsedMs: Math.round(performance.now() - startedAt) }
      }
      throw new Error('模型测试流在完成前结束')
    }
    return await Promise.race([consume(), deadline])
  } finally {
    clearTimeout(timeout)
  }
}
