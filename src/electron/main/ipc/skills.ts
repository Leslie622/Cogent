/**
 * 技能座桌面特权 IPC（docs/计划/技能座升级实现.md §3.7）：
 * - skills:import：主进程弹出目录/.zip 选择框后直调 Host `skills.import`（不让 renderer 传任意本机路径）；
 * - skills:export：主进程弹出保存框后直调 Host `skills.export`；
 * - skills:reveal：先经 Host `skills.revealTarget` 核验技能真实目录，再 `shell.openPath` 打开系统文件管理器。
 */
import { dialog, shell } from 'electron'
import { IPC } from '../../../shared/ipc'
import type { SkillScope } from '../../../protocol'
import { checkCurrentCaller, handleTrusted } from './trusted'
import { requireFileWindow } from './files'
import type { IpcDeps } from './index'

interface ImportRequest {
  scope: 'user' | 'project'
  cwd?: string
  kind: 'directory' | 'zip'
  overwrite?: boolean
}

interface TargetRequest {
  scope: SkillScope
  cwd?: string
  name: string
}

function parseImportRequest(raw: unknown): ImportRequest {
  if (raw === null || typeof raw !== 'object') throw new Error('技能导入参数必须是对象')
  const p = raw as Partial<ImportRequest>
  if (p.scope !== 'user' && p.scope !== 'project') throw new Error('技能导入需要 scope: user|project')
  if (p.scope === 'project' && (typeof p.cwd !== 'string' || p.cwd.length === 0)) {
    throw new Error('项目级导入需要有效的工作区 cwd')
  }
  if (p.kind !== 'directory' && p.kind !== 'zip') throw new Error('技能导入需要 kind: directory|zip')
  if (p.overwrite !== undefined && typeof p.overwrite !== 'boolean') {
    throw new Error('技能导入的 overwrite 必须是 boolean')
  }
  return {
    scope: p.scope,
    ...(p.cwd !== undefined && { cwd: p.cwd }),
    kind: p.kind,
    ...(p.overwrite !== undefined && { overwrite: p.overwrite })
  }
}

function parseTargetRequest(raw: unknown): TargetRequest {
  if (raw === null || typeof raw !== 'object') throw new Error('技能操作参数必须是对象')
  const p = raw as Partial<TargetRequest>
  if (p.scope !== 'user' && p.scope !== 'project' && p.scope !== 'bundled') {
    throw new Error('技能操作需要 scope: user|project|bundled')
  }
  if (p.cwd !== undefined && (typeof p.cwd !== 'string' || p.cwd.length === 0)) {
    throw new Error('技能操作的 cwd 必须是非空 string')
  }
  if (typeof p.name !== 'string' || p.name.length === 0) throw new Error('技能操作需要 name: string')
  return {
    scope: p.scope,
    ...(p.cwd !== undefined && { cwd: p.cwd }),
    name: p.name
  }
}

export function registerSkillsIpc(deps: IpcDeps): void {
  handleTrusted(IPC.skillsImport, async (event, raw: unknown) => {
    requireFileWindow(event, deps)
    const req = parseImportRequest(raw)
    const win = deps.getWindow()!
    const picked = await dialog.showOpenDialog(win, {
      title: req.kind === 'zip' ? '选择技能压缩包（.zip）' : '选择技能目录',
      properties: req.kind === 'zip' ? ['openFile'] : ['openDirectory'],
      ...(req.kind === 'zip' && { filters: [{ name: '技能压缩包', extensions: ['zip'] }] })
    })
    checkCurrentCaller()
    if (picked.canceled || picked.filePaths.length === 0) {
      return { canceled: true as const, imported: [] as string[], skipped: [] as string[] }
    }
    const result = await deps.host.request('skills.import', {
      scope: req.scope,
      ...(req.cwd !== undefined && { cwd: req.cwd }),
      sourcePath: picked.filePaths[0],
      ...(req.overwrite !== undefined && { overwrite: req.overwrite })
    })
    checkCurrentCaller()
    return { canceled: false as const, ...result }
  })

  handleTrusted(IPC.skillsExport, async (event, raw: unknown) => {
    requireFileWindow(event, deps)
    const req = parseTargetRequest(raw)
    const win = deps.getWindow()!
    const picked = await dialog.showSaveDialog(win, {
      title: '导出技能压缩包',
      defaultPath: `${req.name}.zip`,
      filters: [{ name: '技能压缩包', extensions: ['zip'] }]
    })
    checkCurrentCaller()
    if (picked.canceled || picked.filePath.length === 0) {
      return { canceled: true as const }
    }
    await deps.host.request('skills.export', {
      scope: req.scope,
      ...(req.cwd !== undefined && { cwd: req.cwd }),
      name: req.name,
      destinationPath: picked.filePath
    })
    checkCurrentCaller()
    return { canceled: false as const }
  })

  handleTrusted(IPC.skillsReveal, async (event, raw: unknown) => {
    requireFileWindow(event, deps)
    const req = parseTargetRequest(raw)
    const { dir } = await deps.host.request('skills.revealTarget', {
      scope: req.scope,
      ...(req.cwd !== undefined && { cwd: req.cwd }),
      name: req.name
    })
    checkCurrentCaller()
    const error = await shell.openPath(dir)
    if (error !== '') throw new Error(error)
    return { ok: true as const }
  })
}
