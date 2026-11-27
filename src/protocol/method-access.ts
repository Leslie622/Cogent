/**
 * RPC 方法访问控制单源表：编译期强制覆盖 ProtocolMethods 的每一个方法。
 *
 * 设计：
 * - httpScope 缺省表示拒绝经 HTTP/WS 访问（仅 stdio/壳内可用），新增本地方法不会意外暴露到网络；
 * - rendererAllowed 表示是否允许主窗口/控制台经 engine:request 通用代理调用（审批/凭据写/provider 同步走专属 IPC）；
 * - http/server.ts 与 electron/main/ipc/engine.ts 均由此表派生，消除多处手抄白名单漂移。
 */
import type { ProtocolMethods, TokenScope } from './types'

export interface MethodAccessSpec {
  readonly httpScope?: TokenScope
  readonly rendererAllowed: boolean
}

export const METHOD_ACCESS = {
  // ———— 生命周期与握手 ————
  'host.shutdown': { rendererAllowed: false },
  initialize: { httpScope: 'readonly', rendererAllowed: false },
  'capability.issue': { httpScope: 'admin', rendererAllowed: false },

  // ———— 业务配置与凭据 ————
  'session.defaults.get': { httpScope: 'readonly', rendererAllowed: true },
  'session.defaults.set': { httpScope: 'admin', rendererAllowed: true },
  'providers.custom.get': { httpScope: 'readonly', rendererAllowed: false },
  'providers.custom.sync': { httpScope: 'write', rendererAllowed: false },
  'credentials.list': { httpScope: 'readonly', rendererAllowed: true },
  'credentials.set': { httpScope: 'write', rendererAllowed: false },
  'credentials.remove': { httpScope: 'write', rendererAllowed: false },
  'models.list': { httpScope: 'readonly', rendererAllowed: true },
  'models.test': { httpScope: 'write', rendererAllowed: true },
  'models.discover': { httpScope: 'write', rendererAllowed: true },

  // ———— 会话与检索 ————
  'session.list': { httpScope: 'readonly', rendererAllowed: true },
  'session.listArchived': { httpScope: 'readonly', rendererAllowed: true },
  'session.messages': { httpScope: 'readonly', rendererAllowed: true },
  'session.search': { httpScope: 'readonly', rendererAllowed: true },
  'session.search.rebuild': { httpScope: 'admin', rendererAllowed: true },
  'session.titleSettings.get': { httpScope: 'readonly', rendererAllowed: true },
  'session.titleSettings.set': { httpScope: 'admin', rendererAllowed: true },
  'session.create': { httpScope: 'write', rendererAllowed: true },
  'session.delete': { httpScope: 'write', rendererAllowed: true },
  'session.setPinned': { httpScope: 'write', rendererAllowed: true },
  'session.rename': { httpScope: 'write', rendererAllowed: true },
  'session.archive': { httpScope: 'write', rendererAllowed: true },
  'session.setPermission': { httpScope: 'write', rendererAllowed: true },
  'session.setPlanMode': { httpScope: 'write', rendererAllowed: true },
  'session.compact': { httpScope: 'write', rendererAllowed: true },
  'session.continue': { httpScope: 'write', rendererAllowed: true },

  // ———— 项目 ————
  'project.list': { httpScope: 'readonly', rendererAllowed: true },
  'project.create': { httpScope: 'write', rendererAllowed: true },
  'project.rename': { httpScope: 'write', rendererAllowed: true },
  'project.update': { httpScope: 'write', rendererAllowed: true },
  'project.delete': { httpScope: 'write', rendererAllowed: true },
  'project.setPinned': { httpScope: 'write', rendererAllowed: true },

  // ———— Agent 运行与人机裁决 ————
  'agent.submit': { httpScope: 'write', rendererAllowed: true },
  'agent.abort': { httpScope: 'write', rendererAllowed: true },
  'approval.respond': { httpScope: 'write', rendererAllowed: false },
  'question.respond': { httpScope: 'write', rendererAllowed: false },
  'plan.respond': { httpScope: 'write', rendererAllowed: false },

  // ———— 观测、MCP 与技能 ————
  'inspect.entries': { httpScope: 'readonly', rendererAllowed: true },
  'inspect.entry': { httpScope: 'readonly', rendererAllowed: true },
  'mcp.list': { httpScope: 'readonly', rendererAllowed: true },
  'mcp.sync': { httpScope: 'write', rendererAllowed: true },
  'mcp.override': { httpScope: 'write', rendererAllowed: true },
  'skills.list': { httpScope: 'readonly', rendererAllowed: true },
  'skills.read': { httpScope: 'readonly', rendererAllowed: true },
  'skills.save': { httpScope: 'write', rendererAllowed: true },
  'skills.delete': { httpScope: 'write', rendererAllowed: true },
  'skills.setEnabled': { httpScope: 'write', rendererAllowed: true },
  'skills.import': { rendererAllowed: false },
  'skills.export': { rendererAllowed: false },
  'skills.revealTarget': { rendererAllowed: false },

  // ———— 附件（仅壳内） ————
  'attachments.describe': { rendererAllowed: true },
  'attachments.importPath': { rendererAllowed: true },
  'attachments.begin': { rendererAllowed: true },
  'attachments.chunk': { rendererAllowed: true },
  'attachments.finish': { rendererAllowed: true },
  'attachments.cancel': { rendererAllowed: true },
  'attachments.release': { rendererAllowed: true },
  'attachments.resolve': { rendererAllowed: true },
  'attachments.draft': { rendererAllowed: true },
  'attachments.saveDraft': { rendererAllowed: true },
  'attachments.media': { rendererAllowed: true },
  'attachments.saveMedia': { rendererAllowed: true },

  // ———— 文件与产物（仅壳内） ————
  'files.resolve': { rendererAllowed: true },
  'files.readText': { rendererAllowed: true },
  'files.readChunk': { rendererAllowed: true },
  'files.parseDocument': { rendererAllowed: true },
  'files.cancel': { rendererAllowed: true },
  'files.actionTarget': { rendererAllowed: false },
  'outputs.get': { rendererAllowed: true },
  'outputs.resolve': { rendererAllowed: true },
  'changes.get': { rendererAllowed: true },
  'changes.diff': { rendererAllowed: true },

  // ———— 文件视图（走 fileViews 专属 IPC，不经通用代理或 HTTP） ————
  'fileViews.closeContext': { rendererAllowed: false },
  'fileViews.acquire': { rendererAllowed: false },
  'fileViews.readText': { rendererAllowed: false },
  'fileViews.readChunk': { rendererAllowed: false },
  'fileViews.parseDocument': { rendererAllowed: false },
  'fileViews.release': { rendererAllowed: false },
  'fileViews.listDirectory': { rendererAllowed: false },
  'fileViews.search': { rendererAllowed: false },
  'fileViews.cancel': { rendererAllowed: false },
  'fileViews.registerContext': { rendererAllowed: false },
  'fileViews.resetWindow': { rendererAllowed: false },
  'fileViews.releaseWindow': { rendererAllowed: false },
  'fileViews.cloneLease': { rendererAllowed: false },
  'fileViews.previewResource': { rendererAllowed: false },
  'fileViews.actionTarget': { rendererAllowed: false }
} as const satisfies Record<keyof ProtocolMethods, MethodAccessSpec>

/** 派生给 HTTP/WS 入口的最低 scope 表；未登记 httpScope 的方法拒绝网络访问。 */
export function httpMethodMinScope(method: string): TokenScope | undefined {
  if (!Object.hasOwn(METHOD_ACCESS, method)) return undefined
  return (METHOD_ACCESS as Record<string, MethodAccessSpec>)[method].httpScope
}

/** 派生给 Electron main engine:request 的 renderer 白名单集合。 */
export function rendererAllowedMethods(): ReadonlySet<string> {
  return new Set(
    Object.entries(METHOD_ACCESS)
      .filter(([, spec]) => spec.rendererAllowed)
      .map(([method]) => method)
  )
}
