/** 真构建产物的启动诊断走 stderr，凭据只用于初始化，不进入诊断日志。 */
import { expect, it } from 'vitest'
import { makeTempDir, removeDir, startEngine } from './harness'

it('Host 启动阶段可定位，握手与后续 RPC 仍正常', async () => {
  const home = makeTempDir('cogent-startup-')
  const engine = startEngine(home, { COGENT_HTTP_RPC: '1' })
  const secret = 'startup-test-credential-never-log'
  try {
    const initialized = await engine.send('initialize', {
      client: 'startup-test', protocolVersion: 3,
      credentials: { openai: { apiKey: secret } }
    })
    expect(initialized.result?.service).toBe('cogent-agent')
    expect((await engine.send('session.list')).error).toBeUndefined()
    // stdout/stderr 是两根独立管道，响应到达不保证末条诊断已被父进程读到。
    await expect.poll(() => engine.stderrLines.join('\n')).toContain('initialize 完成')
    const logs = engine.stderrLines.join('\n')
    for (const stage of ['加载 Host 模块', '初始化模型运行时', '恢复本地存储与会话',
      '装配请求路由', '启动 HTTP 监听', 'stdio 就绪', '收到 initialize', 'initialize 完成']) {
      expect(logs).toContain(stage)
    }
    expect(logs).not.toContain(secret)
  } finally {
    engine.kill()
    removeDir(home)
  }
})
