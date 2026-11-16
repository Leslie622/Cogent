/**
 * 对外 MCP Server 入口（阶段 5a，D9）：独立 Node 进程，由外部 MCP 客户端
 * （zcode / Codex / Claude Code 等）stdio spawn —— stdout 只承载 MCP 协议，
 * 一切诊断写 stderr（stdio transport 的铁律，Pi-meme main.ts 同款）。
 *
 * 构建位：electron.vite.config.ts main 三入口之一（out/main/mcp.js），
 * 与 host.js 同管线、同 node22 运行时拉起（外部客户端的 spawn 命令见
 * docs/测试用例/对外MCP.md）。
 */
import process from 'node:process'
import { parseArgs } from 'node:util'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { initialAccess } from './host-client'
import { createCogentMcpServer } from './tools'

const help = `cogent-mcp —— Cogent 对外 MCP Server（stdio）

  node mcp.js

无参数无配置文件：凭据来自 ~/.cogent/mcp-access.json（Cogent 桌面应用在
设置 externalMcp.enabled 时自动写入），每次工具调用重读 —— Host 重启换
token 无需重启本进程。测试可用 COGENT_MCP_ACCESS_FILE 覆写路径。
写组工具仅在凭据 scope=write（externalMcp.allowWrites）时注册。
`

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { help: { type: 'boolean', short: 'h' } } })
  if (values.help) {
    process.stderr.write(help)
    return
  }
  // 启动快照：凭据 scope 决定写组是否注册（tools.ts 头注的快照语义）
  const scope = initialAccess()?.scope ?? null
  const server = createCogentMcpServer(scope)
  await server.connect(new StdioServerTransport())
  process.stderr.write(`[cogent-mcp] ready（scope=${scope ?? '无凭据：只读组'}）\n`)

  let closing: Promise<void> | undefined
  const stop = (): void => {
    closing ??= server.close()
    void closing.then(
      () => process.exit(0),
      () => process.exit(1)
    )
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  // stdio MCP 的自然退出：客户端关闭管道（它退出/重连）即本进程使命结束
  process.stdin.once('end', stop)
  process.stdin.once('error', stop)
}

await main().catch((cause: unknown) => {
  process.stderr.write(cause instanceof Error ? cause.message : 'cogent-mcp 启动失败')
  process.exitCode = 1
})
