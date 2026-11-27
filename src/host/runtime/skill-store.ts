/**
 * 技能 store（docs/模块/技能座.md & docs/计划/技能座升级实现.md）—— Host 侧技能目录的
 * 多源发现 / 合并 / 两级启停 / 无损编辑 / 统一执行加载 / 安全导入导出真源。
 *
 * 完整 7 级发现优先级（后者覆盖前者，近者胜 + 冲突诊断；同文件经 realpathSync.native 去重）：
 * 1. bundled 内置技能层（垫底只读，随包分发）
 * 2. [预留：插件技能根]
 * 3. 用户生态 ~/.claude/skills（只读）
 * 4. 用户生态 ~/.agents/skills（只读）
 * 5. 用户自有 ~/.cogent/skills（可读写）
 * 6. 自定义额外目录 customDirs（只读，按配置序）
 * 7. 项目目录（自 .git worktree 根逐级向下至当前 cwd，每级按 .claude → .agents → .cogent 递进）
 *
 * 加载收口：
 * - 专用 `skill` 工具与用户显式触发（$`/` 实体、`/skill:`）100% 共用 `loadForExecution`：
 *   无缓存活快照、100KB 字节截断、附属资源清单、通用变量映射表（正文强制 allowSensitive: false）
 *   与统一 `<skill_content>` 外壳。
 * - `save()` 编辑既有技能时读取原 frontmatter 并无损合并，绝不抹掉 license / compatibility /
 *   metadata / allowed-tools / context / agent 等标准或扩展字段。
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { unzipSync, zipSync } from 'fflate'
import {
  loadSkillsFromDir,
  parseFrontmatter,
  stripFrontmatter,
  type ResourceDiagnostic,
  type Skill
} from '@earendil-works/pi-coding-agent'
import type {
  SkillImportResult,
  SkillListResult,
  SkillOrigin,
  SkillReadResult,
  SkillScope
} from '../../protocol'
import { ProtocolError, RpcErrorCode } from '../../protocol'
import { expandTemplateVars } from './template-vars'

/** Agent Skills 规范上限（镜像 pi skills.ts:11-14） */
const MAX_NAME_LENGTH = 64
const MAX_DESCRIPTION_LENGTH = 1024

/** 技能正文单次加载字节上限（对齐 zcode core/src/tool/handlers/skill.ts:18） */
export const MAX_SKILL_BYTES = 100_000

/** 附属文件枚举上限（供技能正文提示与编辑页展示） */
const MAX_RESOURCE_FILES = 50

/** zip 导入安全护栏（对齐 zcode zip-source 防护线） */
const MAX_IMPORT_ZIP_BYTES = 50 * 1024 * 1024
const MAX_IMPORT_UNZIPPED_BYTES = 100 * 1024 * 1024
const MAX_IMPORT_SINGLE_FILE_BYTES = 10 * 1024 * 1024
const MAX_IMPORT_FILE_COUNT = 1000

/** user 级禁用名单（盘上形状） */
interface UserState {
  disabled: string[]
}

/** project 级覆盖（盘上形状）：name → true=强制启用 / false=强制禁用 */
interface ProjectState {
  overrides: Record<string, boolean>
}

export interface SkillStoreOptions {
  /** 用户级 ~/.claude 根（传根而非 skills 子目录，与 agentsRoot 对称；缺省则不扫用户级 .claude） */
  claudeRoot?: string
  /** 随应用打包的内置技能目录（如 resources/skills；缺省则无内置层） */
  bundledDir?: string
  /** 用户配置的额外只读技能目录列表 */
  customDirs?: readonly string[]
}

export interface SkillSaveOptions {
  whenToUse?: string
  manualOnly?: boolean
  userInvocable?: boolean
  argumentHint?: string
}

export interface SkillExecutionContext {
  cwdOrRoots?: string | readonly string[]
  projectDir?: string
  sessionId?: string
  args?: string
  /** 模型自主调用（skill 工具）为 true，拒绝 disable-model-invocation 技能；用户显式调用为 false */
  requireModelInvocable: boolean
  extra?: Readonly<Record<string, string>>
}

export interface LoadedSkillResult {
  name: string
  baseDir: string
  filePath: string
  scope: SkillScope
  origin: SkillOrigin
  /** 渲染完成的 `<skill_content>` 完整文本（已完成变量替换） */
  content: string
  truncated: boolean
  resourceFiles: string[]
}

/** 技能发现内部记录（携带完整解析后的标准/扩展元数据） */
export interface DiscoveredSkill extends Skill {
  scope: SkillScope
  origin: SkillOrigin
  readonly: boolean
  eco: boolean
  userInvocable: boolean
  whenToUse?: string
  argumentHint?: string
  license?: string
  compatibility?: string
  allowedTools?: string[]
  unsupportedRuntime?: 'context-fork'
}

/** 名字规则镜像 pi validateName（skills.ts:92-112；返回空 = 合法） */
export function validateSkillName(name: string): string[] {
  const errors: string[] = []
  if (name.length === 0) errors.push('name 不能为空')
  if (name.length > MAX_NAME_LENGTH) errors.push(`name 超过 ${MAX_NAME_LENGTH} 字符（${name.length}）`)
  if (!/^[a-z0-9-]+$/.test(name)) errors.push('name 只能是小写字母、数字、连字符')
  if (name.startsWith('-') || name.endsWith('-')) errors.push('name 不能以连字符开头或结尾')
  if (name.includes('--')) errors.push('name 不能含连续连字符')
  return errors
}

/** 描述规则镜像 pi validateDescription（skills.ts:117-127） */
function validateDescription(description: string): string | undefined {
  if (description.trim() === '') return 'description 不能为空'
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return `description 超过 ${MAX_DESCRIPTION_LENGTH} 字符（${description.length}）`
  }
  return undefined
}

function diagnosticsToErrors(diagnostics: ResourceDiagnostic[]): string[] {
  return diagnostics.map((d) => `${d.path !== undefined ? `${d.path}: ` : ''}${d.message}`)
}

/** 安全取真实路径（遵守约定 §1.2 第 9 条：Windows 下用 realpathSync.native 展开 8.3 短名） */
function nativeRealpath(targetPath: string): string {
  try {
    return realpathSync.native(targetPath)
  } catch {
    return resolve(targetPath)
  }
}

function readStateFile<T>(path: string, check: (value: unknown) => T | undefined): { state: T; error?: string } {
  if (!existsSync(path)) return { state: check({}) as T }
  let text = readFileSync(path, 'utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { state: check({}) as T, error: `${path}: ${error instanceof Error ? error.message : String(error)}` }
  }
  const state = check(parsed)
  if (state === undefined) return { state: check({}) as T, error: `${path}: 形状不符（期望技能状态对象）` }
  return { state }
}

function checkUserState(value: unknown): UserState | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const disabled = (value as Record<string, unknown>).disabled
  if (disabled === undefined) return { disabled: [] }
  if (!Array.isArray(disabled) || disabled.some((item) => typeof item !== 'string')) return undefined
  return { disabled: disabled as string[] }
}

function checkProjectState(value: unknown): ProjectState | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const overrides = (value as Record<string, unknown>).overrides
  if (overrides === undefined) return { overrides: {} }
  if (
    typeof overrides !== 'object' ||
    overrides === null ||
    Array.isArray(overrides) ||
    Object.values(overrides).some((item) => typeof item !== 'boolean')
  ) {
    return undefined
  }
  return { overrides: overrides as Record<string, boolean> }
}

/** 原子替换写（tmp + rename，Windows 同卷原子） */
function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, text)
  try {
    renameSync(tmp, path)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

/** 序列化单个 YAML 标量/复合值（保证 JSON 双引号标量与缩进结构 100% 合法往返） */
function serializeYamlValue(value: unknown, indent: number): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (typeof value === 'string') return JSON.stringify(value)
  const pad = ' '.repeat(indent)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return value
      .map((item) => {
        if (typeof item === 'object' && item !== null) {
          const nested = serializeYamlValue(item, indent + 2)
          return `\n${pad}- ${nested.trimStart()}`
        }
        return `\n${pad}- ${serializeYamlValue(item, indent + 2)}`
      })
      .join('')
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    if (entries.length === 0) return '{}'
    return entries
      .map(([k, v]) => {
        const keyStr = /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)
        const valStr = serializeYamlValue(v, indent + 2)
        return valStr.startsWith('\n') ? `\n${pad}${keyStr}:${valStr}` : `\n${pad}${keyStr}: ${valStr}`
      })
      .join('')
  }
  if (typeof value === 'bigint') return String(value)
  return 'null'
}

/** 将 frontmatter 记录按确定性键序序列化为合法 YAML 头（name/description 在前，其余保留原顺序） */
function serializeFrontmatter(record: Record<string, unknown>): string {
  const orderedKeys = [
    ...['name', 'description', 'when_to_use', 'disable-model-invocation', 'user-invocable', 'argument-hint'].filter(
      (k) => record[k] !== undefined
    ),
    ...Object.keys(record).filter(
      (k) =>
        record[k] !== undefined &&
        !['name', 'description', 'when_to_use', 'disable-model-invocation', 'user-invocable', 'argument-hint'].includes(k)
    )
  ]
  const lines = orderedKeys.map((k) => {
    const keyStr = /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)
    const valStr = serializeYamlValue(record[k], 2)
    return valStr.startsWith('\n') ? `${keyStr}:${valStr}` : `${keyStr}: ${valStr}`
  })
  return `---\n${lines.join('\n')}\n---`
}

function invalid(errors: string[]): never {
  throw new ProtocolError(RpcErrorCode.InvalidParams, errors.join('；'))
}

/** 归一化 allowed-tools（支持空格/逗号分隔字符串或字符串数组，对齐 agentskills.io & Claude Code） */
function parseAllowedTools(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) {
    const items = raw.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
    return items.length > 0 ? items : undefined
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed.length === 0) return undefined
    // 允许逗号或空白分隔，同时保留括号内的空格（如 Bash(git diff *)）
    const items: string[] = []
    let current = ''
    let depth = 0
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i]
      if (ch === '(') depth++
      else if (ch === ')' && depth > 0) depth--
      if (depth === 0 && (ch === ',' || /\s/.test(ch))) {
        if (current.trim().length > 0) items.push(current.trim())
        current = ''
        continue
      }
      current += ch
    }
    if (current.trim().length > 0) items.push(current.trim())
    return items.length > 0 ? items : undefined
  }
  return undefined
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** 从 SKILL.md 文件解析扩展 frontmatter 字段（解析失败静默回落，不阻断发现） */
function extractExtendedMeta(filePath: string): {
  userInvocable: boolean
  whenToUse?: string
  argumentHint?: string
  license?: string
  compatibility?: string
  allowedTools?: string[]
  unsupportedRuntime?: 'context-fork'
} {
  try {
    const { frontmatter } = parseFrontmatter<Record<string, unknown>>(readFileSync(filePath, 'utf8'))
    const userInvocable = frontmatter['user-invocable'] !== false
    const whenToUse = asNonEmptyString(frontmatter['when_to_use']) ?? asNonEmptyString(frontmatter['whenToUse'])
    const argumentHint = asNonEmptyString(frontmatter['argument-hint']) ?? asNonEmptyString(frontmatter['argumentHint'])
    const license = asNonEmptyString(frontmatter.license)
    const compatibility = asNonEmptyString(frontmatter.compatibility)
    const allowedTools = parseAllowedTools(frontmatter['allowed-tools'] ?? frontmatter.allowedTools)
    const context = asNonEmptyString(frontmatter.context)
    const unsupportedRuntime = context === 'fork' ? 'context-fork' : undefined
    return {
      userInvocable,
      ...(whenToUse !== undefined && { whenToUse }),
      ...(argumentHint !== undefined && { argumentHint }),
      ...(license !== undefined && { license }),
      ...(compatibility !== undefined && { compatibility }),
      ...(allowedTools !== undefined && { allowedTools }),
      ...(unsupportedRuntime !== undefined && { unsupportedRuntime })
    }
  } catch {
    return { userInvocable: true }
  }
}

/**
 * 向上解析项目目录链至 `.git` worktree 根（返回顺序：远祖先 → 当前目录，使近者胜）。
 * 无 `.git` 标记时只包含当前目录本身（对标 zcode adapters/skills/roots.ts:74-86）。
 */
function resolveProjectAncestors(cwd: string): string[] {
  const start = resolve(cwd)
  let worktreeRoot: string | null = null
  let cursor = start
  for (;;) {
    if (existsSync(join(cursor, '.git'))) {
      worktreeRoot = cursor
      break
    }
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  if (worktreeRoot === null) return [start]
  const dirs: string[] = []
  let current = start
  for (;;) {
    dirs.push(current)
    if (current === worktreeRoot || current === dirname(current)) break
    current = dirname(current)
  }
  return dirs.reverse()
}

/**
 * 列出技能目录内的附属文件相对路径（不含 SKILL.md、隐藏目录、.git、node_modules，拒绝逃逸 symlink）。
 * 返回排序后的 POSIX 相对路径数组，最多 `limit` 条。
 */
export function listSkillResources(baseDir: string, limit: number = MAX_RESOURCE_FILES): string[] {
  if (!existsSync(baseDir)) return []
  const realBase = nativeRealpath(baseDir)
  const results: string[] = []

  const walk = (dir: string): void => {
    if (results.length >= limit) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (results.length >= limit) return
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const fullPath = join(dir, entry.name)
      const rel = relative(baseDir, fullPath).split(sep).join('/')
      if (rel === 'SKILL.md') continue
      try {
        const realPath = nativeRealpath(fullPath)
        const basePrefix = realBase.endsWith(sep) ? realBase : `${realBase}${sep}`
        if (realPath !== realBase && !realPath.startsWith(basePrefix)) continue
        const st = statSync(realPath)
        if (st.isDirectory()) {
          walk(fullPath)
        } else if (st.isFile()) {
          results.push(rel)
        }
      } catch {
        continue
      }
    }
  }

  walk(baseDir)
  return results
}

/** 按字节上限截断正文（保证 UTF-8 字符边界完整不截断半个多字节字符） */
function truncateByBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8')
  if (buf.byteLength <= maxBytes) return { text, truncated: false }
  let end = maxBytes
  // 回退跳过 UTF-8 续字节（0b10xxxxxx），避免截出 U+FFFD
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true }
}

/** 校验并归一化 zip 内部相对路径，拒绝绝对路径、驱动器盘符与 `..` 穿越 */
function sanitizeArchivePath(rawPath: string): string | null {
  const normalized = rawPath.replaceAll('\\', '/')
  if (normalized.length === 0 || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null
  const parts = normalized.split('/').filter((p) => p.length > 0 && p !== '.')
  if (parts.length === 0 || parts.some((p) => p === '..')) return null
  return posix.join(...parts)
}

/** 校验待导入目录内所有节点，拒绝任何 symlink 逃逸 */
function assertNoSymlinks(dir: string): void {
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    const st = lstatSync(fullPath)
    if (st.isSymbolicLink()) {
      invalid([`导入源包含符号链接（已拒绝）：${entry.name}`])
    }
    if (st.isDirectory()) assertNoSymlinks(fullPath)
  }
}

export class SkillStore {
  private readonly userDir: string
  private readonly userStateFile: string
  /** user 级生态兼容目录（<agentsRoot>/skills，如 ~/.agents/skills） */
  private readonly userEcoDir: string
  /** user 级 Claude 生态目录（<claudeRoot>/skills，如 ~/.claude/skills；未配置则不扫） */
  private readonly userClaudeDir?: string
  /** 随包内置技能目录（最低优先级、只读） */
  private readonly bundledDir?: string
  /** 额外自定义只读技能目录 */
  private readonly customDirs: readonly string[]

  constructor(root: string, agentsRoot: string, opts: SkillStoreOptions = {}) {
    this.userDir = join(root, 'skills')
    this.userStateFile = join(root, 'skills.json')
    this.userEcoDir = join(agentsRoot, 'skills')
    this.userClaudeDir = opts.claudeRoot !== undefined ? join(opts.claudeRoot, 'skills') : undefined
    this.bundledDir = opts.bundledDir
    this.customDirs = opts.customDirs ?? []
  }

  private projectDir(cwd: string): string {
    return join(cwd, '.cogent', 'skills')
  }

  private projectEcoDir(cwd: string): string {
    return join(cwd, '.agents', 'skills')
  }

  private projectClaudeDir(cwd: string): string {
    return join(cwd, '.claude', 'skills')
  }

  private projectStateFile(cwd: string): string {
    return join(cwd, '.cogent', 'skills.json')
  }

  /**
   * 多源发现与合并（按 7 级优先级从低到高叠加，后者覆盖前者并记录冲突诊断）。
   * - `cwds` 为空 = 仅发现 bundled + user + custom 视图；
   * - `cwds` 非空 = 逆序遍历绑定根（次根先入、主根 `cwds[0]` 最后入），每根向上扫描至 `.git` 根。
   */
  private discoverMany(cwds: readonly string[] = []): { skills: DiscoveredSkill[]; errors: string[] } {
    const errors: string[] = []
    const byName = new Map<string, DiscoveredSkill>()
    const realPaths = new Set<string>()

    const addDir = (dir: string, scope: SkillScope, origin: SkillOrigin): void => {
      if (!existsSync(dir)) return
      const { skills, diagnostics } = loadSkillsFromDir({ dir, source: scope })
      errors.push(...diagnosticsToErrors(diagnostics))
      const readonly = origin !== 'cogent'
      const eco = origin === 'agents' || origin === 'claude'
      for (const skill of skills) {
        const realPath = nativeRealpath(skill.filePath)
        if (realPaths.has(realPath)) continue
        const existing = byName.get(skill.name)
        if (existing !== undefined) {
          errors.push(`技能 "${skill.name}" 同名冲突：${skill.filePath} 覆盖 ${existing.filePath}`)
        }
        const ext = extractExtendedMeta(skill.filePath)
        const discovered: DiscoveredSkill = {
          ...skill,
          scope,
          origin,
          readonly,
          eco,
          ...ext
        }
        byName.set(skill.name, discovered)
        realPaths.add(realPath)
      }
    }

    // 1. bundled 内置技能层（最低优先级，垫底只读）
    if (this.bundledDir !== undefined) {
      addDir(this.bundledDir, 'bundled', 'bundled')
    }

    // 2. 用户生态（.claude → .agents）与用户自有（.cogent）
    if (this.userClaudeDir !== undefined) {
      addDir(this.userClaudeDir, 'user', 'claude')
    }
    addDir(this.userEcoDir, 'user', 'agents')
    addDir(this.userDir, 'user', 'cogent')

    // 3. 自定义额外只读目录
    for (const customDir of this.customDirs) {
      addDir(customDir, 'user', 'custom')
    }

    // 4. 项目多根（次根先入、主根 cwds[0] 最后入；每根从 .git worktree 祖先逐级向下至该根）
    for (let i = cwds.length - 1; i >= 0; i--) {
      const ancestors = resolveProjectAncestors(cwds[i])
      for (const dir of ancestors) {
        addDir(this.projectClaudeDir(dir), 'project', 'claude')
        addDir(this.projectEcoDir(dir), 'project', 'agents')
        addDir(this.projectDir(dir), 'project', 'cogent')
      }
    }

    return { skills: [...byName.values()], errors }
  }

  private loadStatesMany(cwds: readonly string[] = []): {
    userDisabled: Set<string>
    projectOverrides: Map<string, boolean>
    errors: string[]
  } {
    const user = readStateFile(this.userStateFile, checkUserState)
    const errors = [...(user.error !== undefined ? [user.error] : [])]
    const userDisabled = new Set(user.state.disabled)
    const projectOverrides = new Map<string, boolean>()
    for (let i = cwds.length - 1; i >= 0; i--) {
      const project = readStateFile(this.projectStateFile(cwds[i]), checkProjectState)
      if (project.error !== undefined) errors.push(project.error)
      for (const [name, enabled] of Object.entries(project.state.overrides)) {
        projectOverrides.set(name, enabled)
      }
    }
    return { userDisabled, projectOverrides, errors }
  }

  private static effective(
    skill: DiscoveredSkill,
    userDisabled: Set<string>,
    projectOverrides: Map<string, boolean>
  ): boolean {
    const override = projectOverrides.get(skill.name)
    if (override !== undefined) return override
    return !userDisabled.has(skill.name)
  }

  /**
   * skills.list 响应：摘要 + 诊断。cwd 缺省 = user + bundled 视图；
   * 带 cwd = 完整项目合并视图（含被禁用项 —— 列表即管理面）。
   */
  list(cwd?: string): SkillListResult {
    const cwds = cwd !== undefined ? [cwd] : []
    const discovered = this.discoverMany(cwds)
    const states = this.loadStatesMany(cwds)
    return {
      skills: discovered.skills.map((skill) => {
        const resourceCount = listSkillResources(skill.baseDir).length
        return {
          name: skill.name,
          description: skill.description,
          scope: skill.scope,
          origin: skill.origin,
          path: skill.filePath,
          baseDir: skill.baseDir,
          manualOnly: skill.disableModelInvocation,
          userInvocable: skill.userInvocable,
          ...(skill.whenToUse !== undefined && { whenToUse: skill.whenToUse }),
          ...(skill.argumentHint !== undefined && { argumentHint: skill.argumentHint }),
          ...(skill.allowedTools !== undefined && { allowedTools: skill.allowedTools }),
          ...(skill.unsupportedRuntime !== undefined && { unsupportedRuntime: skill.unsupportedRuntime }),
          ...(resourceCount > 0 && { resourceCount }),
          ...(skill.readonly && { readonly: true }),
          enabled: SkillStore.effective(skill, states.userDisabled, states.projectOverrides),
          userDisabled: states.userDisabled.has(skill.name),
          ...(states.projectOverrides.has(skill.name) && { override: states.projectOverrides.get(skill.name) }),
          ...(skill.eco && { eco: true })
        }
      }),
      errors: [...discovered.errors, ...states.errors]
    }
  }

  /** 单根活快照（合并发现 − 禁用项；无缓存，每回合热刷新） */
  snapshot(cwd?: string): { skills: DiscoveredSkill[]; errors: string[] } {
    return this.snapshotMany(cwd !== undefined ? [cwd] : [])
  }

  /** 多根工作区活快照（主根 `cwds[0]` 优先） */
  snapshotMany(cwds: readonly string[]): { skills: DiscoveredSkill[]; errors: string[] } {
    const discovered = this.discoverMany(cwds)
    const states = this.loadStatesMany(cwds)
    return {
      skills: discovered.skills.filter((s) => SkillStore.effective(s, states.userDisabled, states.projectOverrides)),
      errors: [...discovered.errors, ...states.errors]
    }
  }

  private writableDirFor(scope: 'user' | 'project', cwd?: string): string {
    if (scope === 'user') return this.userDir
    if (cwd === undefined) invalid(['scope=project 需要 cwd（项目技能目录所在工作区）'])
    return this.projectDir(cwd)
  }

  /**
   * 新增/编辑一枚技能（skills.save 委托）：
   * 编辑既有技能时读取原 SKILL.md 的 frontmatter 并无损合并，绝不丢失 license /
   * compatibility / metadata / allowed-tools / context / agent 等标准或扩展字段。
   */
  save(
    scope: 'user' | 'project',
    cwd: string | undefined,
    name: string,
    description: string,
    body: string,
    options: SkillSaveOptions = {}
  ): void {
    const nameErrors = validateSkillName(name)
    if (nameErrors.length > 0) invalid(nameErrors)
    const descriptionError = validateDescription(description)
    if (descriptionError !== undefined) invalid([descriptionError])
    const dir = this.writableDirFor(scope, cwd)
    const targetFile = join(dir, name, 'SKILL.md')

    // 无损合并既有 frontmatter
    let existingFm: Record<string, unknown> = {}
    if (existsSync(targetFile)) {
      try {
        existingFm = { ...parseFrontmatter<Record<string, unknown>>(readFileSync(targetFile, 'utf8')).frontmatter }
      } catch {
        existingFm = {}
      }
    }

    const merged: Record<string, unknown> = {
      ...existingFm,
      name,
      description
    }

    if (options.whenToUse !== undefined) {
      const trimmed = options.whenToUse.trim()
      delete merged.whenToUse
      if (trimmed.length > 0) merged.when_to_use = trimmed
      else delete merged.when_to_use
    }
    if (options.manualOnly !== undefined) {
      if (options.manualOnly) merged['disable-model-invocation'] = true
      else delete merged['disable-model-invocation']
    }
    if (options.userInvocable !== undefined) {
      if (!options.userInvocable) merged['user-invocable'] = false
      else delete merged['user-invocable']
    }
    if (options.argumentHint !== undefined) {
      const trimmed = options.argumentHint.trim()
      delete merged.argumentHint
      if (trimmed.length > 0) merged['argument-hint'] = trimmed
      else delete merged['argument-hint']
    }

    const content = `${serializeFrontmatter(merged)}\n\n${body}\n`
    atomicWrite(targetFile, content)
  }

  /**
   * 删除技能目录（skills.delete 委托）：仅允许删除可写作用域（user/project），
   * bundled 内置技能不可删除；只清同级状态文件的对应名。
   */
  delete(scope: SkillScope, cwd: string | undefined, name: string): void {
    if (scope === 'bundled') invalid(['内置技能（bundled）不可删除，可通过启停开关禁用'])
    const nameErrors = validateSkillName(name)
    if (nameErrors.length > 0) invalid(nameErrors)
    const dir = this.writableDirFor(scope, cwd)
    const target = join(dir, name)
    if (!existsSync(target)) invalid([`技能 "${name}" 不存在（${dir}）`])
    rmSync(target, { recursive: true, force: true })
    if (scope === 'user') {
      const { state } = readStateFile(this.userStateFile, checkUserState)
      if (state.disabled.includes(name)) {
        atomicWrite(this.userStateFile, `${JSON.stringify({ disabled: state.disabled.filter((n) => n !== name) }, null, 2)}\n`)
      }
    } else if (cwd !== undefined) {
      const path = this.projectStateFile(cwd)
      const { state } = readStateFile(path, checkProjectState)
      if (name in state.overrides) {
        delete state.overrides[name]
        atomicWrite(path, `${JSON.stringify({ overrides: state.overrides }, null, 2)}\n`)
      }
    }
  }

  /**
   * 写启停状态（skills.setEnabled 委托）：user 档写禁用名单，project 档写 overrides。
   * 任意已发现技能（含 eco / bundled）均可按名启停。
   */
  setEnabled(
    scope: 'user' | 'project',
    cwd: string | undefined,
    name: string,
    value: 'enabled' | 'disabled' | 'inherit'
  ): void {
    const nameErrors = validateSkillName(name)
    if (nameErrors.length > 0) invalid(nameErrors)
    const cwds = scope === 'project' && cwd !== undefined ? [cwd] : []
    if (!this.discoverMany(cwds).skills.some((s) => s.name === name)) {
      invalid([`技能 "${name}" 不存在`])
    }
    if (scope === 'user') {
      if (value === 'inherit') invalid(['user 档没有 inherit（无更上层可回落），用 enabled/disabled'])
      const { state } = readStateFile(this.userStateFile, checkUserState)
      const disabled = value === 'disabled' ? [...new Set([...state.disabled, name])] : state.disabled.filter((n) => n !== name)
      atomicWrite(this.userStateFile, `${JSON.stringify({ disabled }, null, 2)}\n`)
      return
    }
    if (cwd === undefined) invalid(['scope=project 需要 cwd'])
    const path = this.projectStateFile(cwd)
    const { state } = readStateFile(path, checkProjectState)
    const overrides = { ...state.overrides }
    if (value === 'inherit') delete overrides[name]
    else overrides[name] = value === 'enabled'
    atomicWrite(path, `${JSON.stringify({ overrides }, null, 2)}\n`)
  }

  /** 按作用域查找单枚技能（read / export / reveal 共用） */
  private findSkill(scope: SkillScope, cwd: string | undefined, name: string): DiscoveredSkill {
    const nameErrors = validateSkillName(name)
    if (nameErrors.length > 0) invalid(nameErrors)
    const cwds = scope === 'project' && cwd !== undefined ? [cwd] : []
    const found = this.discoverMany(cwds).skills.find((s) => s.name === name)
    if (found === undefined) invalid([`技能 "${name}" 不存在`])
    return found
  }

  /** 读单枚技能正文与完整元信息（skills.read 委托：编辑/只读查看回填源） */
  read(scope: SkillScope, cwd: string | undefined, name: string): SkillReadResult {
    const skill = this.findSkill(scope, cwd, name)
    const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(readFileSync(skill.filePath, 'utf8'))
    const description = frontmatter.description
    if (typeof description !== 'string' || description.length === 0) {
      invalid([`${skill.filePath}: description 缺失（手放文件请补 frontmatter）`])
    }
    const resourceFiles = listSkillResources(skill.baseDir)
    return {
      description,
      body,
      ...(skill.whenToUse !== undefined && { whenToUse: skill.whenToUse }),
      manualOnly: skill.disableModelInvocation,
      userInvocable: skill.userInvocable,
      ...(skill.argumentHint !== undefined && { argumentHint: skill.argumentHint }),
      ...(skill.license !== undefined && { license: skill.license }),
      ...(skill.compatibility !== undefined && { compatibility: skill.compatibility }),
      ...(skill.allowedTools !== undefined && { allowedTools: skill.allowedTools }),
      ...(skill.unsupportedRuntime !== undefined && { unsupportedRuntime: skill.unsupportedRuntime }),
      ...(resourceFiles.length > 0 && { resourceFiles }),
      ...(skill.readonly && { readonly: true })
    }
  }

  /** 核验并返回技能目录真实路径（skills.revealTarget 委托，供主进程安全打开文件夹） */
  revealDir(scope: SkillScope, cwd: string | undefined, name: string): string {
    const skill = this.findSkill(scope, cwd, name)
    return nativeRealpath(skill.baseDir)
  }

  /**
   * 统一技能执行加载管线（专用 `skill` 工具、结构化 `$`/`/` 实体、`/skill:` 命令三路共用）：
   * 1. 无缓存活快照查名；
   * 2. 模型调用路径严格拦截 `disable-model-invocation`；
   * 3. 100KB 字节截断 + 通用变量替换（正文强制 `allowSensitive: false`）；
   * 4. 封装 `<skill_content>` 规范外壳 + `Base directory` + 附属资源列表。
   */
  loadForExecution(name: string, ctx: SkillExecutionContext): LoadedSkillResult {
    const cwds: readonly string[] =
      ctx.cwdOrRoots === undefined
        ? []
        : typeof ctx.cwdOrRoots === 'string'
          ? [ctx.cwdOrRoots]
          : ctx.cwdOrRoots
    const snapshot = this.snapshotMany(cwds)
    const skill = snapshot.skills.find((s) => s.name === name)
    if (skill === undefined) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, `技能 "${name}" 不存在或已禁用`)
    }
    if (ctx.requireModelInvocable && skill.disableModelInvocation) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, `技能 "${name}" 已设为仅手动调用，不允许模型自动加载`)
    }

    let rawContent: string
    try {
      rawContent = readFileSync(skill.filePath, 'utf8')
    } catch (error) {
      throw new ProtocolError(
        RpcErrorCode.InvalidParams,
        `读取技能 "${name}" 失败：${error instanceof Error ? error.message : String(error)}`
      )
    }

    const stripped = stripFrontmatter(rawContent).trim()
    const { text: bounded, truncated } = truncateByBytes(stripped, MAX_SKILL_BYTES)
    const expanded = expandTemplateVars(
      bounded,
      {
        skillDir: skill.baseDir,
        projectDir: ctx.projectDir ?? cwds[0],
        sessionId: ctx.sessionId,
        arguments: ctx.args,
        extra: ctx.extra
      },
      { allowSensitive: false }
    )

    const resourceFiles = listSkillResources(skill.baseDir)
    const lines: string[] = [
      `<skill_content name="${skill.name}">`,
      `# Skill: ${skill.name}`,
      '',
      expanded,
      '',
      `Base directory for this skill: ${skill.baseDir}`,
      'Relative paths in this skill are relative to this base directory.'
    ]
    if (resourceFiles.length > 0) {
      lines.push('Bundled files:')
      for (const file of resourceFiles) lines.push(`- ${file}`)
    }
    if (truncated) {
      lines.push('[Skill content truncated]')
    }
    lines.push('</skill_content>')

    return {
      name: skill.name,
      baseDir: skill.baseDir,
      filePath: skill.filePath,
      scope: skill.scope,
      origin: skill.origin,
      content: lines.join('\n'),
      truncated,
      resourceFiles
    }
  }

  /** 校验用户显式指定的技能均存在且已启用（submit 前置快速失败，不提前读全文） */
  assertSkillsAvailable(names: readonly string[], cwdOrRoots?: string | readonly string[]): void {
    if (names.length === 0) return
    const cwds: readonly string[] =
      cwdOrRoots === undefined
        ? []
        : typeof cwdOrRoots === 'string'
          ? [cwdOrRoots]
          : cwdOrRoots
    const active = new Set(this.snapshotMany(cwds).skills.map((s) => s.name))
    for (const name of names) {
      if (!active.has(name)) {
        throw new ProtocolError(RpcErrorCode.InvalidParams, `技能 "${name}" 不存在或已禁用`)
      }
    }
  }

  /** 解析 `/skill:name args` 纯文本命令（仅在技能存在且已启用时命中） */
  parseSkillCommand(
    text: string,
    cwdOrRoots?: string | readonly string[]
  ): { name: string; args: string } | undefined {
    if (!text.startsWith('/skill:')) return undefined
    const rest = text.slice(7)
    const spaceIndex = rest.indexOf(' ')
    const name = spaceIndex === -1 ? rest : rest.slice(0, spaceIndex)
    const args = spaceIndex === -1 ? '' : rest.slice(spaceIndex + 1).trim()
    const cwds: readonly string[] =
      cwdOrRoots === undefined
        ? []
        : typeof cwdOrRoots === 'string'
          ? [cwdOrRoots]
          : cwdOrRoots
    const skill = this.snapshotMany(cwds).skills.find((s) => s.name === name)
    if (skill === undefined) return undefined
    return { name: skill.name, args }
  }

  /**
   * 按名活展开多个技能实体（结构化 agent.submit.skills 专用）：
   * 复用 `loadForExecution`（requireModelInvocable: false），返回完整结果供会话记录观测。
   */
  expandSkillsDetailed(
    names: readonly string[],
    cwdOrRoots?: string | readonly string[],
    runtimeCtx?: { projectDir?: string; sessionId?: string }
  ): LoadedSkillResult[] {
    if (names.length === 0) return []
    return names.map((name) =>
      this.loadForExecution(name, {
        cwdOrRoots,
        projectDir: runtimeCtx?.projectDir,
        sessionId: runtimeCtx?.sessionId,
        requireModelInvocable: false
      })
    )
  }

  /** 向后兼容包装：直接返回展开后的 `<skill_content>` 块字符串数组 */
  expandSkillsByName(
    names: readonly string[],
    cwdOrRoots?: string | readonly string[],
    runtimeCtx?: { projectDir?: string; sessionId?: string }
  ): string[] {
    return this.expandSkillsDetailed(names, cwdOrRoots, runtimeCtx).map((r) => r.content)
  }

  /**
   * `/skill:name args` 活展开（Cogent submit 路径委托）：
   * 命中禁用/不存在技能原样透传；成功则统一走 `loadForExecution`（含 `$ARGUMENTS` 替换）。
   */
  expandSkillCommand(
    text: string,
    cwdOrRoots?: string | readonly string[],
    runtimeCtx?: { projectDir?: string; sessionId?: string }
  ): string {
    return this.expandSkillCommandDetailed(text, cwdOrRoots, runtimeCtx).prompt
  }

  expandSkillCommandDetailed(
    text: string,
    cwdOrRoots?: string | readonly string[],
    runtimeCtx?: { projectDir?: string; sessionId?: string }
  ): { prompt: string; loaded?: LoadedSkillResult } {
    if (!text.startsWith('/skill:')) return { prompt: text }
    const rest = text.slice(7)
    const spaceIndex = rest.indexOf(' ')
    const name = spaceIndex === -1 ? rest : rest.slice(0, spaceIndex)
    const args = spaceIndex === -1 ? '' : rest.slice(spaceIndex + 1).trim()
    const cwds: readonly string[] =
      cwdOrRoots === undefined
        ? []
        : typeof cwdOrRoots === 'string'
          ? [cwdOrRoots]
          : cwdOrRoots
    const skill = this.snapshotMany(cwds).skills.find((s) => s.name === name)
    if (skill === undefined) return { prompt: text }
    try {
      const loaded = this.loadForExecution(name, {
        cwdOrRoots,
        projectDir: runtimeCtx?.projectDir,
        sessionId: runtimeCtx?.sessionId,
        args: args.length > 0 ? args : undefined,
        requireModelInvocable: false
      })
      return { prompt: loaded.content, loaded }
    } catch (error) {
      process.stderr.write(`[skills] 展开 /skill:${name} 失败：${error instanceof Error ? error.message : String(error)}\n`)
      return { prompt: text }
    }
  }

  /**
   * 从本地目录或 `.zip` 压缩包安全导入技能（skills.import 委托）：
   * - 支持单个技能目录（根含 SKILL.md）或包含多个技能子目录的根目录；
   * - zip 经 fflate 内存安全解压：拒绝路径穿越、超量文件、超大体积；目录拒绝符号链接；
   * - 全部校验通过后经 staging 原子安装，失败无半装残留。
   */
  importFromPath(
    scope: 'user' | 'project',
    cwd: string | undefined,
    sourcePath: string,
    overwrite: boolean = false
  ): SkillImportResult {
    if (!isAbsolute(sourcePath) || !existsSync(sourcePath)) {
      invalid([`导入路径不存在：${sourcePath}`])
    }
    const targetRoot = this.writableDirFor(scope, cwd)
    const stagingRoot = join(targetRoot, `.staging-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(stagingRoot, { recursive: true })

    try {
      const st = statSync(sourcePath)
      let inspectRoot = stagingRoot
      if (st.isDirectory()) {
        assertNoSymlinks(sourcePath)
        inspectRoot = join(stagingRoot, 'src')
        cpSync(sourcePath, inspectRoot, { recursive: true, dereference: false })
      } else if (st.isFile() && extname(sourcePath).toLowerCase() === '.zip') {
        if (st.size > MAX_IMPORT_ZIP_BYTES) {
          invalid([`压缩包超过 ${Math.round(MAX_IMPORT_ZIP_BYTES / 1024 / 1024)}MB 上限`])
        }
        const rawZip = readFileSync(sourcePath)
        let entries: Record<string, Uint8Array>
        try {
          entries = unzipSync(new Uint8Array(rawZip.buffer, rawZip.byteOffset, rawZip.byteLength))
        } catch (error) {
          invalid([`压缩包解压失败：${error instanceof Error ? error.message : String(error)}`])
        }
        const entryList = Object.entries(entries)
        if (entryList.length > MAX_IMPORT_FILE_COUNT) {
          invalid([`压缩包内文件数超过 ${MAX_IMPORT_FILE_COUNT} 上限`])
        }
        let totalBytes = 0
        inspectRoot = join(stagingRoot, 'unzipped')
        mkdirSync(inspectRoot, { recursive: true })
        for (const [rawName, data] of entryList) {
          if (rawName.endsWith('/')) continue
          const safeRel = sanitizeArchivePath(rawName)
          if (safeRel === null) {
            invalid([`压缩包包含非法路径（已拒绝）：${rawName}`])
          }
          if (data.byteLength > MAX_IMPORT_SINGLE_FILE_BYTES) {
            invalid([`压缩包内单文件超过 ${Math.round(MAX_IMPORT_SINGLE_FILE_BYTES / 1024 / 1024)}MB 上限：${safeRel}`])
          }
          totalBytes += data.byteLength
          if (totalBytes > MAX_IMPORT_UNZIPPED_BYTES) {
            invalid([`压缩包解压总大小超过 ${Math.round(MAX_IMPORT_UNZIPPED_BYTES / 1024 / 1024)}MB 上限`])
          }
          const destFile = join(inspectRoot, ...safeRel.split('/'))
          mkdirSync(dirname(destFile), { recursive: true })
          writeFileSync(destFile, data)
        }
      } else {
        invalid(['仅支持导入本地技能目录或 .zip 压缩包'])
      }

      // 定位所有候选技能目录（根含 SKILL.md，或扫描一层/多层子目录中的 SKILL.md）
      const skillDirs = this.findImportableSkillDirs(inspectRoot)
      if (skillDirs.length === 0) {
        invalid(['导入源中未找到任何包含有效 SKILL.md 的技能目录'])
      }

      // 校验每个技能目录的 frontmatter 与名称唯一性
      const candidates: Array<{ name: string; dir: string }> = []
      const seenNames = new Set<string>()
      for (const dir of skillDirs) {
        const skillFile = join(dir, 'SKILL.md')
        const { frontmatter } = parseFrontmatter<Record<string, unknown>>(readFileSync(skillFile, 'utf8'))
        const name = asNonEmptyString(frontmatter.name) ?? basename(dir)
        const nameErrors = validateSkillName(name)
        if (nameErrors.length > 0) invalid([`${skillFile}: ${nameErrors.join('；')}`])
        const desc = typeof frontmatter.description === 'string' ? frontmatter.description : ''
        const descError = validateDescription(desc)
        if (descError !== undefined) invalid([`${skillFile}: ${descError}`])
        if (seenNames.has(name)) invalid([`导入包内存在重复技能名 "${name}"`])
        seenNames.add(name)
        candidates.push({ name, dir })
      }

      const imported: string[] = []
      const skipped: string[] = []
      mkdirSync(targetRoot, { recursive: true })

      for (const candidate of candidates) {
        const destDir = join(targetRoot, candidate.name)
        if (existsSync(destDir)) {
          if (!overwrite) {
            skipped.push(candidate.name)
            continue
          }
          const backupDir = join(targetRoot, `.backup-${candidate.name}-${Date.now()}`)
          renameSync(destDir, backupDir)
          try {
            cpSync(candidate.dir, destDir, { recursive: true })
            rmSync(backupDir, { recursive: true, force: true })
          } catch (error) {
            rmSync(destDir, { recursive: true, force: true })
            renameSync(backupDir, destDir)
            throw error
          }
        } else {
          cpSync(candidate.dir, destDir, { recursive: true })
        }
        imported.push(candidate.name)
      }

      if (imported.length === 0 && skipped.length > 0) {
        invalid([`同名技能已存在（${skipped.join('、')}），如需替换请勾选覆盖导入`])
      }
      return { imported, skipped }
    } finally {
      rmSync(stagingRoot, { recursive: true, force: true })
    }
  }

  /** 在待导入目录中收集技能根（目录含 SKILL.md 即止步不继续下钻） */
  private findImportableSkillDirs(root: string): string[] {
    const found: string[] = []
    const walk = (dir: string, depth: number): void => {
      if (depth > 4) return
      if (existsSync(join(dir, 'SKILL.md'))) {
        found.push(dir)
        return
      }
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name.startsWith('.') || entry.name === '__MACOSX' || entry.name === 'node_modules') continue
        walk(join(dir, entry.name), depth + 1)
      }
    }
    walk(root, 0)
    return found
  }

  /** 将指定技能整目录打包导出为标准 `.zip` 压缩包（含 SKILL.md 与全部附属文件） */
  exportToZip(scope: SkillScope, cwd: string | undefined, name: string, destinationPath: string): void {
    if (!isAbsolute(destinationPath)) invalid([`导出目标必须是绝对路径：${destinationPath}`])
    const skill = this.findSkill(scope, cwd, name)
    const files: Record<string, Uint8Array> = {}
    const prefix = skill.name
    files[`${prefix}/SKILL.md`] = new Uint8Array(readFileSync(skill.filePath))
    for (const rel of listSkillResources(skill.baseDir, MAX_IMPORT_FILE_COUNT)) {
      const fullPath = join(skill.baseDir, ...rel.split('/'))
      files[`${prefix}/${rel}`] = new Uint8Array(readFileSync(fullPath))
    }
    const zipped = zipSync(files, { level: 6 })
    mkdirSync(dirname(destinationPath), { recursive: true })
    const tmp = `${destinationPath}.tmp`
    writeFileSync(tmp, zipped)
    try {
      renameSync(tmp, destinationPath)
    } catch (error) {
      rmSync(tmp, { force: true })
      throw error
    }
  }
}
