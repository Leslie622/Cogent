/** 工作区只响应手动开合/占满；窗口缩放限制可见宽度，不触发覆盖或改写用户记忆。 */
export const WORKSPACE_DEFAULT_WIDTH = 350
export const WORKSPACE_COLLAPSE_WIDTH = 160
const CHAT_REMAINDER = 160

export function workspaceWidth(contentWidth: number, collapsed: boolean, expanded: boolean, preferredWidth: number): number {
  if (collapsed) return 0
  return expanded ? contentWidth : Math.min(preferredWidth, Math.max(1, contentWidth - CHAT_REMAINDER))
}

export function resizeWorkspace(contentWidth: number, requestedWidth: number): { collapsed: true } | { width: number } {
  if (requestedWidth < WORKSPACE_COLLAPSE_WIDTH) return { collapsed: true }
  return { width: Math.max(WORKSPACE_COLLAPSE_WIDTH, workspaceWidth(contentWidth, false, false, requestedWidth)) }
}
