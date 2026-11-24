/** 多标签文件能力合同：桌面授权与运行期上下文分离，所有句柄只在本代 Host 有效。 */
import type { FileViewForwardMethod, FileViewRoot } from '../protocol/domains'
export type {
  FileViewContext,
  FileViewDirectory,
  FileViewEntry,
  FileViewForwardMethod,
  FileViewHostMethods,
  FileViewLease,
  FileViewMethod,
  FileViewMethods,
  FileViewOpenResult,
  FileViewPreviewPolicy,
  FileViewRead,
  FileViewRoot,
  FileViewSearch,
  FileViewSource
} from '../protocol/domains'

export const FILE_VIEWS_CHANNEL = 'fileViews:request'
/** main 的项目事实根不带grantId；原生选择授权只用于预览，不能升级成项目导航根。 */
export function projectFileRoots<T extends FileViewRoot>(roots: readonly T[]): T[] {
  return roots.filter(root => root.kind === 'directory' && root.grantId === undefined)
}
export const FILE_VIEW_PREVIEW_BLOCKED_NAMES = /^(?:\..*|credentials\.json|mcp-access\.json|id_rsa|id_ed25519)$|\.(?:pem|key|p12|pfx)$/i
export function fileViewPreviewSensitivePath(path: string): boolean { return path.split(/[\\/]/).some(part => FILE_VIEW_PREVIEW_BLOCKED_NAMES.test(part)) }
export const FILE_VIEW_FORWARD_METHODS: FileViewForwardMethod[] = ['fileViews.closeContext', 'fileViews.acquire', 'fileViews.readText', 'fileViews.readChunk', 'fileViews.parseDocument', 'fileViews.release', 'fileViews.listDirectory', 'fileViews.search', 'fileViews.cancel']
