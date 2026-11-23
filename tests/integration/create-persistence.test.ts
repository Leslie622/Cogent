/** 显式创建的成功响应以写盘为前提，验证真实 Host 不发布未保存的摘要。 */
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { RpcErrorCode, type ProjectCreateResult, type SessionSummary } from '../../src/protocol'
import { makeTempDir, removeDir, startEngine } from './harness'

it('项目与会话创建写盘失败时返回错误，解除故障后可重试', async () => {
  const home = makeTempDir('cogent-create-persistence-')
  const engine = startEngine(home)
  const sessionsDir = join(home, 'sessions')
  const projectsDir = join(home, 'projects')
  try {
    expect((await engine.send('initialize', { client: 'create-persistence-test', protocolVersion: 3 })).error).toBeUndefined()
    // 用普通文件阻止创建集合目录，不依赖平台权限或真实满盘。
    for (const path of [sessionsDir, projectsDir]) writeFileSync(path, '磁盘故障夹具')

    const sessionParams = { title: '保存测试' }
    const projectParams = { name: '保存测试', cwds: [home] }
    expect((await engine.send('session.create', sessionParams)).error?.code).toBe(RpcErrorCode.InternalError)
    expect((await engine.send('project.create', projectParams)).error?.code).toBe(RpcErrorCode.InternalError)
    expect((await engine.send('session.list', {})).result).toEqual([])
    expect((await engine.send('project.list', {})).result).toEqual([])

    for (const path of [sessionsDir, projectsDir]) unlinkSync(path)
    const session = (await engine.send<SessionSummary>('session.create', sessionParams)).result!
    const project = (await engine.send<ProjectCreateResult>('project.create', projectParams)).result!.summary
    expect((await engine.send('session.list', {})).result).toEqual([session])
    expect((await engine.send('project.list', {})).result).toEqual([project])
    expect(JSON.parse(readFileSync(join(sessionsDir, `${session.id}.json`), 'utf8'))).toMatchObject({ summary: session })
    expect(JSON.parse(readFileSync(join(projectsDir, `${project.id}.json`), 'utf8'))).toMatchObject({ summary: project })
  } finally {
    await engine.stop()
    removeDir(home)
  }
})
