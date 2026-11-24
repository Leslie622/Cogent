/** 显式创建的成功响应以写盘为前提，验证真实 Host 不发布未保存的摘要。 */
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
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

it('显式编辑写盘失败保留内存和原文件，解除故障后可重试并重启恢复', async () => {
  const home = makeTempDir('cogent-edit-persistence-')
  let engine = startEngine(home)
  try {
    await engine.send('initialize', { client: 'edit-test', protocolVersion: 3 })
    const session = (await engine.send<SessionSummary>('session.create', { title: '原会话' })).result!
    const project = (await engine.send<ProjectCreateResult>('project.create', { name: '原项目', cwds: [home] })).result!.summary
    const cases: Array<[string, object, string, string]> = [
      ['project.rename', { projectId: project.id, name: '新项目' }, 'projects', project.id],
      ['project.update', { projectId: project.id, name: '编辑项目', cwds: [join(home, 'next')] }, 'projects', project.id],
      ['project.setPinned', { projectId: project.id, pinned: true }, 'projects', project.id],
      ['session.rename', { sessionId: session.id, title: '新会话' }, 'sessions', session.id],
      ['session.setPinned', { sessionId: session.id, pinned: true }, 'sessions', session.id],
      ['session.archive', { sessionId: session.id, archived: true }, 'sessions', session.id],
      ['session.setPermission', { sessionId: session.id, mode: 'auto' }, 'sessions', session.id],
      ['session.setPlanMode', { sessionId: session.id, enabled: true }, 'sessions', session.id],
      ['session.delete', { sessionId: session.id }, 'sessions', session.id]
    ]
    for (const [method, params, collection, id] of cases) {
      const file = join(home, collection, `${id}.json`), before = readFileSync(file, 'utf8')
      mkdirSync(`${file}.tmp`)
      expect((await engine.send(method, params)).error?.code, method).toBe(RpcErrorCode.InternalError)
      expect(readFileSync(file, 'utf8'), method).toBe(before)
      expect((await engine.send('session.list', {})).result, method).toEqual([session])
      expect((await engine.send('project.list', {})).result, method).toEqual([project])
      rmSync(`${file}.tmp`, { recursive: true })
    }
    expect((await engine.send('session.archive', { sessionId: session.id, archived: true })).error).toBeUndefined()
    expect((await engine.send('project.rename', { projectId: project.id, name: '已提交' })).error).toBeUndefined()
    await engine.stop()
    engine = startEngine(home)
    await engine.send('initialize', { client: 'edit-restart', protocolVersion: 3 })
    expect((await engine.send('session.list', {})).result).toEqual([])
    expect((await engine.send<SessionSummary[]>('session.listArchived', {})).result?.[0].id).toBe(session.id)
    expect((await engine.send('project.list', {})).result).toMatchObject([{ name: '已提交' }])
  } finally { await engine.stop(); removeDir(home) }
})

it('无 renderer 启动恢复业务配置，显式/项目/全局权限优先级一致', async () => {
  const home = makeTempDir('cogent-business-restart-')
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ version: 1, defaultPermissionMode: 'auto' }))
  let engine = startEngine(home)
  const providers = { providers: [{ id: 'custom/persisted', name: '隔离模型', baseUrl: 'http://127.0.0.1:1/v1', models: ['persisted'] }], overrides: [] }
  try {
    await engine.send('initialize', { client: 'config-test', protocolVersion: 3 })
    expect((await engine.send('session.create', {})).result).toMatchObject({ permissionMode: 'auto' })
    expect((await engine.send('session.defaults.set', { defaultPermissionMode: 'ask' })).error).toBeUndefined()
    expect((await engine.send('providers.custom.sync', providers)).error).toBeUndefined()
    const project = (await engine.send<ProjectCreateResult>('project.create', { name: '优先级', cwds: [home] })).result!.summary
    await engine.stop()
    const file = join(home, 'projects', `${project.id}.json`)
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { summary: { defaultPermissionMode?: string } }
    doc.summary.defaultPermissionMode = 'auto'
    writeFileSync(file, JSON.stringify(doc))
    engine = startEngine(home)
    await engine.send('initialize', { client: 'config-restart', protocolVersion: 3 })
    expect((await engine.send('providers.custom.get', {})).result).toEqual(providers)
    expect((await engine.send<{ models: Array<{ id: string }> }>('models.list', {})).result?.models.some(model => model.id === 'persisted')).toBe(true)
    expect((await engine.send('session.create', {})).result).toMatchObject({ permissionMode: 'ask' })
    expect((await engine.send('session.create', { projectId: project.id })).result).toMatchObject({ permissionMode: 'auto' })
    expect((await engine.send('session.create', { projectId: project.id, permissionMode: 'ask' })).result).toMatchObject({ permissionMode: 'ask' })
    for (const [method, params] of [['session.defaults.set', { defaultPermissionMode: 'invalid' }], ['providers.custom.sync', { providers: [null], overrides: [] }]] as const)
      expect((await engine.send(method, params)).error?.code).toBe(RpcErrorCode.InvalidParams)
  } finally { await engine.stop(); removeDir(home) }
})

it('第二个 Host 同根启动失败，原进程已提交的修改不受影响', async () => {
  const home = makeTempDir('cogent-exclusive-host-')
  const first = startEngine(home)
  let second: ReturnType<typeof startEngine> | undefined
  try {
    await first.send('initialize', { client: 'first', protocolVersion: 3 })
    const session = (await first.send<SessionSummary>('session.create', { title: '已保存' })).result!
    second = startEngine(home)
    await expect(second.send('initialize', { client: 'second', protocolVersion: 3 })).rejects.toThrow('占用')
    expect((await first.send('session.list', {})).result).toEqual([session])
    const saved = JSON.parse(readFileSync(join(home, 'sessions', `${session.id}.json`), 'utf8')) as { summary: SessionSummary }
    expect(saved.summary.title).toBe('已保存')
  } finally { await second?.stop(); await first.stop(); removeDir(home) }
})
