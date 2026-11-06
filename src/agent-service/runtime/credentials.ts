/**
 * 凭据内存表 —— 引擎侧的 API key 唯一存放点。
 *
 * 安全边界（docs/架构.md「main 是壳不是业务」的对称面）：
 * - key 经 initialize 握手（宿主持久化存储灌入）或 credentials.set（运行中更新）
 *   进入本表，只活在引擎进程内存；引擎自身零磁盘持久化；
 * - 对外只暴露 get（供 pi 请求时取 key）与 keyConfigured 布尔位，
 *   不存在"列出全部 key 明文"的路径。
 *
 * pi 对接：Agent 构造时的 getApiKey 回调直接查本表
 * （agent-loop.js:275 每轮请求前解析 provider → key）。
 */
import type { ProviderSummary } from '../../protocol'

export class CredentialRegistry {
  private keys = new Map<string, string>()

  /** 握手批量注入（initialize）；运行中的单条更新走 set */
  loadAll(credentials: Record<string, { apiKey: string }>): void {
    for (const [providerId, credential] of Object.entries(credentials)) {
      this.keys.set(providerId, credential.apiKey)
    }
  }

  set(providerId: string, apiKey: string): void {
    this.keys.set(providerId, apiKey)
  }

  /** 供 pi getApiKey 每轮解析（agent-loop.js 每次请求调用，支持过期 token 场景） */
  get(providerId: string): string | undefined {
    return this.keys.get(providerId)
  }

  /** provider 摘要列表（credentials.list 响应）；只回布尔位，不回 key */
  summaries(): ProviderSummary[] {
    return Array.from(this.keys.entries(), ([id, apiKey]) => ({
      id,
      name: id,
      keyConfigured: apiKey.length > 0
    }))
  }

  /** 某 provider 是否已配 key（模型下拉置灰判定） */
  has(providerId: string): boolean {
    const key = this.keys.get(providerId)
    return key !== undefined && key.length > 0
  }
}
