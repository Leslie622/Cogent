/**
 * 对外 MCP Server 的配置域（阶段 5a，决定 29 出口座）：
 * 凭据文件解析 + 常量。独立入口进程（cogent-mcp）唯一的本地状态来源是
 * main 写的 mcp-access.json —— Host 每次（重）启动后 main 经 stdio 签票
 * → /auth/exchange 换 token → 原子写（见 electron/main/host/mcp-access.ts）。
 *
 * 为什么每次工具调用重读：token 随 Host 进程生死（rootSecret 每次启动
 * 重生成，auth.ts），Host 重启后文件内容整体作废 —— Pi-meme「按工具调用
 * 连接上游」（apps/mcp hosts.ts:176）的本地版：读旧文件 → 连不上/401，
 * 重读已换新。凭据缺失不炸进程：MCP 仍可初始化与列工具，业务调用返回
 * 引导开启的错误（Host 离线同理，README:25 同款语义）。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getStorageDirName } from '../../shared/brand'

/** 凭据文件里 main 写入的形状（信任边界：磁盘文件，形状校验后使用） */
export interface McpAccess {
  port: number
  token: string
  scope: 'readonly' | 'write'
}

/** 凭据文件路径：默认与 settings.json 同根（~/.cogent），env 覆写供测试 */
export function accessFilePath(): string {
  if (process.env.COGENT_MCP_ACCESS_FILE) return process.env.COGENT_MCP_ACCESS_FILE
  return join(process.env.COGENT_HOME || join(homedir(), getStorageDirName()), 'mcp-access.json')
}

/**
 * 读凭据（每次工具调用调一次）。缺失/损坏/形状不对 → null（不抛：这是
 * 持久化读取边界，坏数据要能引导用户修，而不是让 MCP 进程跟着死）。
 */
export function readAccess(): McpAccess | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(accessFilePath(), 'utf-8'))
  } catch {
    return null
  }
  if (raw === null || typeof raw !== 'object') return null
  const candidate = raw as Partial<McpAccess>
  if (
    typeof candidate.port !== 'number' ||
    !Number.isInteger(candidate.port) ||
    candidate.port <= 0 ||
    candidate.port > 65535 ||
    typeof candidate.token !== 'string' ||
    candidate.token.length === 0 ||
    (candidate.scope !== 'readonly' && candidate.scope !== 'write')
  ) {
    return null
  }
  return { port: candidate.port, token: candidate.token, scope: candidate.scope }
}

/** cogent_session_submit 的 waitMs 上限：MCP 客户端自身也有超时，太长只会两边比谁先断 */
export const MAX_WAIT_MS = 120_000

/** 单次 /rpc 请求超时：与 Pi-meme requestTimeoutMs 默认同档（30s） */
export const REQUEST_TIMEOUT_MS = 30_000
