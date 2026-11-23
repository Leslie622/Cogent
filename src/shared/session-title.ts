/** 自动标题的客户端合同；策略与持久化归 Host，界面只读写这一份配置。 */
export interface SessionTitleSettings {
  enabled: boolean
  /** @deprecated 仅兼容旧客户端；Host 忽略此字段，标题始终使用首条输入的实际模型。 */
  model?: { provider: string; id: string }
}

export interface SessionTitleMethods {
  'session.titleSettings.get': { params: Record<string, never>; result: SessionTitleSettings }
  'session.titleSettings.set': { params: SessionTitleSettings; result: SessionTitleSettings }
}
