import { createModels, type Model } from '@earendil-works/pi-ai'

/** 动态目录里的模型，API 类型在运行时确定 */
type AnyModel = Model<any>
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { zaiProvider } from '@earendil-works/pi-ai/providers/zai'

/**
 * LLM 接入层：pi-ai 的 Models 集合。
 *
 * - 新增 Provider：在下方追加一行工厂调用（可用工厂见
 *   `@earendil-works/pi-ai/providers/*`，或用 createProvider() 接任意
 *   OpenAI/Anthropic 兼容端点）。
 * - 凭据默认从环境变量解析（见 PROVIDER_SETUP.envKeys）；需要应用内登录/
 *   持久化时，向 createModels({ credentials }) 注入 CredentialStore。
 */
export const models = createModels()

models.setProvider(anthropicProvider())
models.setProvider(openaiProvider())
models.setProvider(zaiProvider())

interface ProviderSetup {
  provider: string
  /** 任一环境变量存在即视为该 Provider 已配置 */
  envKeys: string[]
  /** 默认模型候选，按序取第一个目录内存在的；都没有则回退到该 Provider 的第一个模型 */
  candidates: string[]
}

const PROVIDER_SETUP: ProviderSetup[] = [
  {
    provider: 'anthropic',
    envKeys: ['ANTHROPIC_API_KEY'],
    candidates: ['claude-sonnet-4-6', 'claude-sonnet-4-5']
  },
  {
    provider: 'openai',
    envKeys: ['OPENAI_API_KEY'],
    candidates: ['gpt-5-mini', 'gpt-5']
  },
  {
    provider: 'zai',
    envKeys: ['ZAI_API_KEY'],
    candidates: ['glm-4.7', 'glm-4.6']
  }
]

export interface ResolvedModel {
  model: AnyModel
  provider: string
}

/** 按注册顺序选择第一个已配置凭据的 Provider 的默认模型。 */
export function resolveDefaultModel(): ResolvedModel | null {
  for (const setup of PROVIDER_SETUP) {
    if (!setup.envKeys.some((key) => !!process.env[key])) continue
    const model = pickDefaultModel(setup)
    if (model) return { model, provider: setup.provider }
  }
  return null
}

function pickDefaultModel(setup: ProviderSetup): AnyModel | null {
  for (const id of setup.candidates) {
    const model = models.getModel(setup.provider, id)
    if (model) return model
  }
  return models.getModels(setup.provider)[0] ?? null
}
