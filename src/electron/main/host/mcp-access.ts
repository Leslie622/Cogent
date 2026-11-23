/**
 * 对外 MCP 凭据写入（阶段 5a，决定 29）：Host 每次启动后，若设置开了
 * externalMcp.enabled，main 经现有签票链（stdio capability.issue，血缘
 * 全权）→ /auth/exchange 换长期 token → 原子写 <storageRoot>/mcp-access.json
 * （{port, token, scope}）。cogent-mcp 进程每次工具调用重读此文件 ——
 * Host 重启换 token/换端口无需通知它（docs/模块/对外MCP.md）。
 *
 * 关闭态卫生：enabled=false（含从未开）时**删除**遗留文件 —— token 虽随
 * Host 生死，但 Host 还活着时关闭开关若不删，旧 write 档 token 在下次
 * 重启前仍然有效（设置改了 ≠ 凭据自动失效）。
 */
import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { HostManager } from './manager'
import { readSettingsFile } from '../ipc/settings'
import { ensureRoot, storageRoot, writeFileAtomic } from '../storage-root'

function accessFilePath(): string {
  return join(storageRoot(), 'mcp-access.json')
}

/**
 * 刷新（或清除）对外 MCP 凭据文件。在 Host 启动成功后调用；全程 best-effort
 * —— 凭据写不进去不该影响引擎链路，失败留 console 痕迹（外部世界边界，
 * 约定.md §1.1）。
 */
export async function refreshMcpAccessFile(host: HostManager): Promise<void> {
  const settings = readSettingsFile()
  if (settings.externalMcp?.enabled !== true) {
    if (existsSync(accessFilePath())) {
      try {
        unlinkSync(accessFilePath())
      } catch (error) {
        console.error('[main] 对外 MCP 已关闭但凭据文件删除失败:', (error as Error).message)
      }
    }
    return
  }
  const port = host.getHttpPort()
  if (port === undefined) {
    console.error('[main] 对外 MCP 已启用但 HTTP 门端口未知（引擎未就绪？），本轮不写凭据')
    return
  }
  const scope = settings.externalMcp.allowWrites ? 'write' : 'readonly'
  try {
    // 签票（stdio 血缘）→ 票据换 token：与 guest 页面同一条 2b/2c 量产链，
    // 不新增任何鉴权原语；token 随 Host 进程生死（auth.ts 无 exp 是有意的）
    const issued = await host.issueCapability(scope)
    const response = await fetch(`http://127.0.0.1:${port}/auth/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: issued.ticket })
    })
    if (!response.ok) throw new Error(`exchange HTTP ${response.status}`)
    const exchanged = (await response.json()) as { token: string }
    ensureRoot()
    writeFileAtomic(accessFilePath(), JSON.stringify({ port, token: exchanged.token, scope }, null, 2))
    console.log(`[main] 对外 MCP 凭据已写入（scope=${scope}, port=${port}）: ${accessFilePath()}`)
  } catch (error) {
    console.error('[main] 对外 MCP 凭据写入失败:', (error as Error).message)
  }
}
