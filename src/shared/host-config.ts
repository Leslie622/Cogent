/** 业务配置的窄 wire 合同；定义与全局默认均由 Host 加载，界面只读/显式保存。 */
export interface SessionDefaults { defaultPermissionMode: 'ask' | 'auto' }
export interface DefaultsMethods {
  'session.defaults.get': { params: Record<string, never>; result: SessionDefaults }
  'session.defaults.set': { params: SessionDefaults; result: SessionDefaults }
}
