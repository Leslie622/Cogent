/** 自动标题的客户端合同；策略与持久化归 Host，界面只读写这一份配置。 */
export interface SessionTitleSettings {
  enabled: boolean
  /** 不指定时跟随首条输入实际使用的模型；双键避免不同供应商同名模型串用。 */
  model?: { provider: string; id: string }
}

export interface SessionTitleMethods {
  'session.titleSettings.get': { params: Record<string, never>; result: SessionTitleSettings }
  'session.titleSettings.set': { params: SessionTitleSettings; result: SessionTitleSettings }
}
