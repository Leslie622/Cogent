/** 端点模型列表发现（model-discovery）：OpenAI/Anthropic 解析、分页、鉴权与异常边界。 */
import { describe, expect, it, vi } from 'vitest'
import { discoverEndpointModels } from '../../../src/host/runtime/model-discovery'

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function requestHref(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

describe('discoverEndpointModels', () => {
  it('OpenAI 兼容接口提取元数据与 OpenRouter 推理/视觉能力', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: 'deepseek/deepseek-v4',
            name: 'DeepSeek V4',
            context_length: 1000000,
            max_output_tokens: 128000,
            supported_parameters: ['reasoning', 'temperature'],
            architecture: { input_modalities: ['text', 'image'] }
          },
          {
            id: 'custom-reasoner',
            capabilities: { thinking: { supported: true }, image_input: { supported: false } },
            thinkingLevelMap: { off: null, low: 'low', high: 'high' }
          }
        ]
      })
    )

    const result = await discoverEndpointModels(
      { providerId: 'custom/one', baseUrl: 'https://gw.example/v1', apiFormat: 'openai-completions' },
      () => 'sk-stored',
      fetchMock
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [calledUrl, init] = fetchMock.mock.calls[0]
    expect(requestHref(calledUrl)).toBe('https://gw.example/v1/models')
    expect((init?.headers as Headers).get('Authorization')).toBe('Bearer sk-stored')
    expect(init?.redirect).toBe('error')

    expect(result.models).toEqual([
      {
        id: 'deepseek/deepseek-v4',
        name: 'DeepSeek V4',
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        reasoning: true,
        input: ['text', 'image']
      },
      {
        id: 'custom-reasoner',
        reasoning: true,
        input: ['text'],
        thinkingLevelMap: { off: null, low: 'low', high: 'high' }
      }
    ])
  })

  it('Anthropic 兼容接口拼接 /v1/models 并支持分页拉取及临时明文 Key 优先', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ id: 'claude-4-6', display_name: 'Claude 4.6' }], has_more: true, last_id: 'p1' })
      )
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ id: 'claude-4-7' }], has_more: false })
      )

    const result = await discoverEndpointModels(
      {
        providerId: 'custom/ant',
        baseUrl: 'https://proxy.example/v1',
        apiFormat: 'anthropic-messages',
        apiKey: 'sk-inline'
      },
      () => 'sk-stored',
      fetchMock
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(requestHref(fetchMock.mock.calls[0][0])).toBe('https://proxy.example/v1/models')
    expect((fetchMock.mock.calls[0][1]?.headers as Headers).get('x-api-key')).toBe('sk-inline')
    expect(requestHref(fetchMock.mock.calls[1][0])).toBe('https://proxy.example/v1/models?after_id=p1')
    expect(result.models.map((m) => m.id)).toEqual(['claude-4-6', 'claude-4-7'])
  })

  it('拒绝非法 URL、循环游标、401 和缺数组响应', async () => {
    await expect(
      discoverEndpointModels({ baseUrl: 'ftp://example.com' }, () => undefined, vi.fn())
    ).rejects.toThrow('HTTP(S)')

    await expect(
      discoverEndpointModels({ baseUrl: 'https://user:pass@example.com/v1' }, () => undefined, vi.fn())
    ).rejects.toThrow('不能包含凭据')

    const authFail = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({}, 401))
    await expect(
      discoverEndpointModels({ baseUrl: 'https://example.com/v1' }, () => undefined, authFail)
    ).rejects.toThrow('401/403')

    const loopCursor = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(jsonResponse({ data: [{ id: 'a' }], has_more: true, last_id: 'same' }))
    )
    await expect(
      discoverEndpointModels({ baseUrl: 'https://example.com', apiFormat: 'anthropic-messages' }, () => undefined, loopCursor)
    ).rejects.toThrow('游标重复')
  })
})
