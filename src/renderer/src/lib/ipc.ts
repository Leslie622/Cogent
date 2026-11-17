/**
 * renderer→main 的 IPC 错误剥壳（R10）：ipcRenderer.invoke 对 main 侧拒绝统一
 * 包一层 "Error invoking remote method 'engine:request': Error: " 前缀（Electron
 * 行为，非协议内容），协议帧的 message 才是给人读的文案 —— 直出渲染前剥掉，
 * 否则用户看到的是裸 IPC 报文（验收实测）。
 */
export function unwrapIpcError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}
