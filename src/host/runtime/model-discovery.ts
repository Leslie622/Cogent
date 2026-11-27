/**
 * 端点模型列表发现（models.discover）：
 * 查询 OpenAI-compatible（GET /models）或 Anthropic-compatible（GET /v1/models）接口，
 * 提取模型 id、显示名与网关附带的上下文/输出/视觉/推理元数据。
 *
 * 安全边界（对标 reference/Pi-meme discovery.ts）：
 * - 仅接受 http/https 且不含凭据、查询串、fragment 的 URL；
 * - 强制 redirect: 'error'，防止 HTTP 重定向把鉴权头带给第三方地址；
 * - 15 秒超时与 20 页游标上限防无限分页挂起。
 */
import type { DiscoveredModel, ModelsDiscoverParams, ThinkingLevelMap, ThinkingLevelWithOff } from '../../protocol'

const DISCOVERY_TIMEOUT_MS = 15_000
const MAX_PAGES = 20
const VALID_THINKING_KEYS: ReadonlySet<ThinkingLevelWithOff> = new Set([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
])

function parseEndpointUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error('Base URL 必须是完整的 HTTP(S) 地址')
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) {
    throw new Error('Base URL 必须是 HTTP(S) 地址，不能包含凭据、查询参数或片段')
  }
  return url
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function parseThinkingLevelMap(raw: unknown): ThinkingLevelMap | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: ThinkingLevelMap = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!VALID_THINKING_KEYS.has(k as ThinkingLevelWithOff)) continue
    if (v === null) out[k as ThinkingLevelWithOff] = null
    else if (typeof v === 'string' && v.trim().length > 0) out[k as ThinkingLevelWithOff] = v.trim()
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function parseDiscoveredEntry(raw: unknown): DiscoveredModel | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const item = raw as Record<string, unknown>
  const id = typeof item.id === 'string' ? item.id.trim() : ''
  if (!id) return undefined

  const model: DiscoveredModel = { id }
  const displayName = item.displayName ?? item.display_name ?? item.name
  if (typeof displayName === 'string' && displayName.trim().length > 0 && displayName.trim() !== id) {
    model.name = displayName.trim()
  }

  const topProvider =
    item.top_provider && typeof item.top_provider === 'object' && !Array.isArray(item.top_provider)
      ? (item.top_provider as Record<string, unknown>)
      : undefined
  const contextWindow = positiveInt(
    item.context_length ?? item.contextWindow ?? item.max_input_tokens ?? item.inputTokenLimit ?? topProvider?.context_length
  )
  const maxTokens = positiveInt(
    item.max_output_tokens ?? item.maxTokens ?? item.outputTokenLimit ?? topProvider?.max_completion_tokens
  )
  if (contextWindow !== undefined) model.contextWindow = contextWindow
  if (maxTokens !== undefined) model.maxTokens = maxTokens

  if (typeof item.reasoning === 'boolean') model.reasoning = item.reasoning
  else if (typeof item.thinking === 'boolean') model.reasoning = item.thinking

  // OpenRouter 等平台通过 supported_parameters 宣告推理参数
  if (Array.isArray(item.supported_parameters)) {
    const params = item.supported_parameters.filter((p): p is string => typeof p === 'string')
    if (params.includes('reasoning') || params.includes('include_reasoning')) {
      model.reasoning = true
    }
  }

  // OpenRouter architecture.input_modalities 或 capabilities
  const arch =
    item.architecture && typeof item.architecture === 'object' && !Array.isArray(item.architecture)
      ? (item.architecture as Record<string, unknown>)
      : undefined
  if (Array.isArray(arch?.input_modalities)) {
    model.input = arch.input_modalities.includes('image') ? ['text', 'image'] : ['text']
  }

  if (item.capabilities && typeof item.capabilities === 'object' && !Array.isArray(item.capabilities)) {
    const caps = item.capabilities as Record<string, { supported?: unknown } | undefined>
    if (typeof caps.thinking?.supported === 'boolean') model.reasoning = caps.thinking.supported
    if (typeof caps.image_input?.supported === 'boolean') {
      model.input = caps.image_input.supported ? ['text', 'image'] : ['text']
    }
  }

  const map = parseThinkingLevelMap(item.thinkingLevelMap)
  if (map !== undefined) model.thinkingLevelMap = map

  return model
}

export async function discoverEndpointModels(
  params: ModelsDiscoverParams,
  resolveStoredKey: (providerId: string) => string | undefined,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = DISCOVERY_TIMEOUT_MS
): Promise<{ models: DiscoveredModel[] }> {
  const url = parseEndpointUrl(params.baseUrl)
  const apiFormat = params.apiFormat ?? 'openai-completions'
  const suppliedKey = params.apiKey?.trim()
  const key =
    suppliedKey && suppliedKey.length > 0
      ? suppliedKey
      : params.providerId
        ? resolveStoredKey(params.providerId)?.trim()
        : undefined

  const headers = new Headers({ accept: 'application/json' })
  if (apiFormat === 'anthropic-messages') {
    if (key) headers.set('x-api-key', key)
    headers.set('anthropic-version', '2023-06-01')
    url.pathname = `${url.pathname.replace(/\/$/, '').replace(/\/v1$/, '')}/v1/models`
  } else {
    if (key) headers.set('Authorization', `Bearer ${key}`)
    url.pathname = `${url.pathname.replace(/\/$/, '')}/models`
  }

  const signal = AbortSignal.timeout(timeoutMs)
  const models = new Map<string, DiscoveredModel>()
  const seenCursors = new Set<string>()

  for (let page = 0; page < MAX_PAGES; page++) {
    let response: Response
    try {
      response = await fetchImpl(url.href, { headers, redirect: 'error', signal })
    } catch {
      throw new Error(
        signal.aborted
          ? '获取模型列表超时，请检查端点网络或手动添加模型'
          : '无法连接模型列表接口，请检查 Base URL、网络或代理设置'
      )
    }

    if (!response.ok) {
      throw new Error(
        response.status === 401 || response.status === 403
          ? '获取模型列表鉴权失败（HTTP 401/403），请检查 API Key'
          : `获取模型列表失败（HTTP ${response.status}），该端点可能不支持 /models 接口`
      )
    }

    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new Error('模型列表响应不是有效 JSON')
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('模型列表响应格式无效')
    }
    const payload = body as Record<string, unknown>
    const entries = Array.isArray(payload.data)
      ? payload.data
      : Array.isArray(payload.models)
        ? payload.models
        : undefined
    if (!entries) {
      throw new Error('模型列表响应缺少 data 或 models 数组')
    }

    for (const raw of entries) {
      const parsed = parseDiscoveredEntry(raw)
      if (parsed && !models.has(parsed.id)) {
        models.set(parsed.id, parsed)
      }
    }

    const nextCursor =
      apiFormat === 'anthropic-messages' && payload.has_more === true && typeof payload.last_id === 'string'
        ? payload.last_id
        : undefined
    if (!nextCursor) {
      return { models: Array.from(models.values()) }
    }
    if (seenCursors.has(nextCursor)) {
      throw new Error('模型列表分页游标重复，已终止读取')
    }
    seenCursors.add(nextCursor)
    url.searchParams.set('after_id', nextCursor)
  }

  throw new Error(`模型列表超过 ${MAX_PAGES} 页上限，已终止读取`)
}
