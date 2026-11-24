/**
 * 极小 stdio MCP server（集成测试专用，验收见 docs/模块/MCP座.md）——
 * 一行一帧 JSON-RPC over stdio：initialize / tools/list / tools/call。
 * 唯一工具 echo(text) → "echo: <text>"。不带 id 的通知（initialized）静默。
 * 协议版本回显客户端请求值（握手必成，测试不关心版本协商本身）。
 */
import { createInterface } from 'node:readline'
import { writeFileSync } from 'node:fs'

// 生命周期回归只记录本夹具自己的 PID，不涉及真实外部服务器。
if (process.env.COGENT_TEST_PID_FILE) writeFileSync(process.env.COGENT_TEST_PID_FILE, String(process.pid))

const stdin = createInterface({ input: process.stdin })
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

stdin.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let frame
  try {
    frame = JSON.parse(trimmed)
  } catch {
    return
  }
  // 通知（无 id）不回应
  if (frame.id === undefined || frame.id === null) return
  const { id, method, params = {} } = frame
  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'mock-mcp', version: '1.0.0' }
        }
      })
    } else if (method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'analyse_attachment', description: '分析本地附件（测试）',
              inputSchema: { type: 'object', properties: { path: { type: 'string' }, question: { type: 'string' } }, required: ['path', 'question'] }
            },
            {
              name: 'echo',
              description: 'Echo the input text back, prefixed with "echo: "',
              inputSchema: {
                type: 'object',
                properties: { text: { type: 'string', description: 'text to echo' } },
                required: ['text']
              },
              // readOnlyHint 在场：验证 Cogent 首版不消费 annotations（统一 exec 档）
              annotations: { readOnlyHint: true }
            }
          ]
        }
      })
    } else if (method === 'tools/call') {
      if (params.name === 'analyse_attachment') {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `视频分析：00:02 车辆开始移动；本机路径=${params.arguments.path}` }] } })
        return
      }
      if (params.name !== 'echo') {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `unknown tool: ${params.name}` }], isError: true } })
        return
      }
      const text = params.arguments?.text ?? ''
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `echo: ${text}` }] } })
    } else if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} })
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
    }
  } catch (error) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(error) } })
  }
})
