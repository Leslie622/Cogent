/**
 * 极小 stdio MCP server（集成测试专用，验收见 docs/模块/MCP座.md）——
 * 一行一帧 JSON-RPC over stdio，覆盖工具风险、资源、提示词及服务端 Elicitation。
 * 不带 id 的通知（initialized）静默；测试交互只存在该隔离进程内。
 * 协议版本回显客户端请求值（握手必成，测试不关心版本协商本身）。
 */
import { createInterface } from 'node:readline'
import { writeFileSync } from 'node:fs'

// 生命周期回归只记录本夹具自己的 PID，不涉及真实外部服务器。
if (process.env.COGENT_TEST_PID_FILE) writeFileSync(process.env.COGENT_TEST_PID_FILE, String(process.pid))

const stdin = createInterface({ input: process.stdin })
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const pending = new Map()
let nextRequest = 0
const ask = (params) => new Promise((resolve) => {
  const id = `server-ask-${++nextRequest}`
  pending.set(id, resolve)
  send({ jsonrpc: '2.0', id, method: 'elicitation/create', params })
})

stdin.on('line', async (line) => {
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
  if (frame.method === undefined) {
    pending.get(frame.id)?.(frame.result ?? { action: 'cancel' })
    pending.delete(frame.id)
    return
  }
  const { id, method, params = {} } = frame
  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params.protocolVersion ?? '2025-06-18',
          capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
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
              annotations: { readOnlyHint: true }
            },
            {
              name: 'destructive_echo', description: 'Destructive operation fixture (no real side effects)',
              inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
              annotations: { destructiveHint: true, openWorldHint: true }
            },
            {
              name: 'environment', description: 'Read explicitly named environment keys in isolated test server',
              inputSchema: { type: 'object', properties: { keys: { type: 'array', items: { type: 'string' } } }, required: ['keys'] },
              annotations: { readOnlyHint: true }
            },
            ...['ask_form', 'ask_url'].map((name) => ({ name, description: 'MCP elicitation test', inputSchema: { type: 'object', properties: {} } }))
          ]
        }
      })
    } else if (method === 'tools/call') {
      if (params.name === 'analyse_attachment') {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `视频分析：00:02 车辆开始移动；本机路径=${params.arguments.path}` }] } })
        return
      }
      if (params.name === 'environment') {
        const env = Object.fromEntries(params.arguments.keys.map((key) => [key, process.env[key] ?? null]))
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(env) }], structuredContent: env } })
        return
      }
      if (params.name === 'ask_form' || params.name === 'ask_url') {
        const result = await ask(params.name === 'ask_form'
          ? { mode: 'form', message: '请输入项目名称', requestedSchema: { type: 'object', properties: { name: { type: 'string', minLength: 2 } }, required: ['name'] } }
          : { mode: 'url', message: '请在浏览器授权', url: 'https://example.com/authorize', elicitationId: 'fixture-url' })
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
        return
      }
      if (params.name === 'destructive_echo') {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `destructive: ${params.arguments?.text ?? ''}` }] } })
        return
      }
      if (params.name !== 'echo') {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `unknown tool: ${params.name}` }], isError: true } })
        return
      }
      const text = params.arguments?.text ?? ''
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `echo: ${text}` }] } })
    } else if (method === 'resources/list') {
      send({ jsonrpc: '2.0', id, result: { resources: [{ uri: 'fixture://readme', name: 'Fixture README', mimeType: 'text/plain', description: 'MCP fixture resource' }] } })
    } else if (method === 'resources/templates/list') {
      send({ jsonrpc: '2.0', id, result: { resourceTemplates: [{ uriTemplate: 'fixture://document/{name}', name: 'Fixture document' }] } })
    } else if (method === 'resources/read') {
      send({ jsonrpc: '2.0', id, result: { contents: [{ uri: params.uri, mimeType: 'text/plain', text: `RESOURCE CONTENT: ${params.uri}` }] } })
    } else if (method === 'prompts/list') {
      send({ jsonrpc: '2.0', id, result: { prompts: [{ name: 'review', description: 'Review a test subject', arguments: [{ name: 'subject', required: true }] }] } })
    } else if (method === 'prompts/get') {
      send({ jsonrpc: '2.0', id, result: { messages: [{ role: 'user', content: { type: 'text', text: `PROMPT CONTENT: review ${params.arguments?.subject ?? 'unknown'}` } }] } })
    } else if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} })
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
    }
  } catch (error) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(error) } })
  }
})
