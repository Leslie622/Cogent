/**
 * 技能 store（阶段 4b，docs/计划/技能座实现.md §3）—— Host 侧技能目录的
 * 发现 / 合并 / 两级启停 / 编辑真源。
 *
 * 目录与状态（与 MCP 座对称的两级设计；技能是被动文本，无进程信任门 →
 * 项目级允许定义）：
 * - user 级 `<root>/skills/<name>/SKILL.md`（UI 建或手放）；
 * - project 级 `<cwd>/.cogent/skills/<name>/SKILL.md`：同名覆盖 user
 *   （zcode nearest-wins，design/v2/skill.md:185-196；pi 的 user 先得
 *   skills.ts:457-459 是异类不采）+ 冲突诊断；
 * - 启停：user `<root>/skills.json` 禁用名单 + project
 *   `<cwd>/.cogent/skills.json` overrides（可禁 user 技能 / 重新启用
 *   user 已禁 —— 近者胜，与定义优先级一致）。
 *
 * 发现直接用 pi 的 `loadSkillsFromDir`（skills.ts:168-171：SKILL.md 目录
 * 即技能根不再递归 / 根下裸 .md / 递归子目录 + ignore 文件遵循）—— 校验、
 * ignore、裸 md 规则全部白拿，Host 只选目录。名字/描述的写入校验镜像
 * pi validateName/validateDescription（skills.ts:92-127，未从包导出）。
 *
 * 快照 + 热刷新：snapshot() 无缓存，每次调用重新发现（段钩子每回合活算 =
 * 回合边界热刷新，含手动改文件；dsh 的 Chokidar 推送监视在此不成立：拉
 * 模式每回合都是完整观察，无中间态）。`/skill:` 展开也走活快照 —— pi 内建
 * 展开读 loader 静态集（agent-session.ts:2319），与回合刷新的活清单会脱节，
 * 故由本 store 承担（输出形状镜像 agent-session.ts:2325）。
 *
 * 边界：技能文件与状态文件是外部输入（约定.md §1.1 持久化读取）—— 损坏
 * JSON / 坏 frontmatter / 名字非法逐条诊断收集不炸（list/snapshot 带回
 * errors）；save/delete/setEnabled 是手动设置动作，非法输入显式 throw
 * （fail-fast，mcp-config 同款纪律）。名字字符集 ^[a-z0-9-]+$ 本身排除
 * 路径分隔符与 `..`，落点安全由校验保证（不叠加 isWithin 重复设防）。
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadSkillsFromDir, parseFrontmatter, stripFrontmatter, type ResourceDiagnostic, type Skill } from '@earendil-works/pi-coding-agent'
import type { SkillListResult, SkillScope } from '../../protocol'
import { ProtocolError, RpcErrorCode } from '../../protocol'

/** pi skills.ts:11-14 同款上限（名字 64 / 描述 1024，Agent Skills spec） */
const MAX_NAME_LENGTH = 64
const MAX_DESCRIPTION_LENGTH = 1024

/** user 级禁用名单（盘上形状） */
interface UserState {
  disabled: string[]
}

/** project 级覆盖（盘上形状）：name → true=强制启用 / false=强制禁用 */
interface ProjectState {
  overrides: Record<string, boolean>
}

/** 名字规则镜像 pi validateName（skills.ts:92-112；返回空 = 合法） */
function validateName(name: string): string[] {
  const errors: string[] = []
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

/** 诊断 → 协议错误串（发现诊断是 pi 形状，list/snapshot 统一折成字符串） */
function diagnosticsToErrors(diagnostics: ResourceDiagnostic[]): string[] {
  return diagnostics.map((d) => `${d.path !== undefined ? `${d.path}: ` : ''}${d.message}`)
}

/** 读状态文件（BOM 容错；损坏/形状不对 → error 诊断 + 缺省空态，不炸） */
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

/** 原子替换写（JsonStorageDriver 同款纪律，json-driver.ts:46-53：tmp + rename，Windows 同卷原子） */
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

/** frontmatter 值转义：JSON 字符串即合法 YAML 双引号标量（pi 用完整 yaml 包解析，往返安全） */
function yamlString(value: string): string {
  return JSON.stringify(value)
}

function invalid(errors: string[]): never {
  throw new ProtocolError(RpcErrorCode.InvalidParams, errors.join('；'))
}

export class SkillStore {
  private readonly userDir: string
  private readonly userStateFile: string

  constructor(root: string) {
    this.userDir = join(root, 'skills')
    this.userStateFile = join(root, 'skills.json')
  }

  private projectDir(cwd: string): string {
    return join(cwd, '.cogent', 'skills')
  }

  private projectStateFile(cwd: string): string {
    return join(cwd, '.cogent', 'skills.json')
  }

  /**
   * user（+ 可选 project）目录发现合并：同名 project 胜 + 冲突诊断；
   * realPath 去重防同一文件经 symlink 目录两处出现（pi loadSkills 的
   * realPathSet 同款，skills.ts:428-435）。
   */
  private discover(cwd?: string): { skills: Skill[]; errors: string[] } {
    const errors: string[] = []
    const byName = new Map<string, Skill>()
    const realPaths = new Set<string>()

    const addDir = (dir: string, source: SkillScope): void => {
      const { skills, diagnostics } = loadSkillsFromDir({ dir, source })
      errors.push(...diagnosticsToErrors(diagnostics))
      for (const skill of skills) {
        const realPath = realpathSync(skill.filePath)
        if (realPaths.has(realPath)) continue
        const existing = byName.get(skill.name)
        if (existing !== undefined) {
          errors.push(`技能 "${skill.name}" 同名冲突：${skill.filePath} 覆盖 ${existing.filePath}`)
        }
        byName.set(skill.name, skill)
        realPaths.add(realPath)
      }
    }

    addDir(this.userDir, 'user')
    if (cwd !== undefined) addDir(this.projectDir(cwd), 'project')
    return { skills: [...byName.values()], errors }
  }

  /** 两级启停状态装载（损坏文件 → 诊断 + 空态兜底，不炸求值） */
  private loadStates(cwd?: string): { userDisabled: Set<string>; projectOverrides: Map<string, boolean>; errors: string[] } {
    const user = readStateFile(this.userStateFile, checkUserState)
    const errors = [...user.error !== undefined ? [user.error] : []]
    const userDisabled = new Set(user.state.disabled)
    let projectOverrides = new Map<string, boolean>()
    if (cwd !== undefined) {
      const project = readStateFile(this.projectStateFile(cwd), checkProjectState)
      if (project.error !== undefined) errors.push(project.error)
      projectOverrides = new Map(Object.entries(project.state.overrides))
    }
    return { userDisabled, projectOverrides, errors }
  }

  /** list 共用底座：发现合并 + 两级状态（带 projectOverrides 原样给摘要投影） */
  private merged(cwd?: string): { skills: Skill[]; userDisabled: Set<string>; projectOverrides: Map<string, boolean>; errors: string[] } {
    const discovered = this.discover(cwd)
    const states = this.loadStates(cwd)
    return {
      skills: discovered.skills,
      userDisabled: states.userDisabled,
      projectOverrides: states.projectOverrides,
      errors: [...discovered.errors, ...states.errors]
    }
  }

  private static effective(skill: Skill, userDisabled: Set<string>, projectOverrides: Map<string, boolean>): boolean {
    const override = projectOverrides.get(skill.name)
    if (override !== undefined) return override
    return !userDisabled.has(skill.name)
  }

  /**
   * skills.list 响应：摘要 + 诊断。cwd 缺省 = 仅 user 目录视图（无项目
   * 覆盖列）；带 cwd = 两级合并视图（含被禁用项 —— 列表就是管理面）。
   */
  list(cwd?: string): SkillListResult {
    const { skills, userDisabled, projectOverrides, errors } = this.merged(cwd)
    return {
      skills: skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        scope: skill.sourceInfo.scope === 'project' ? 'project' : 'user',
        path: skill.filePath,
        baseDir: skill.baseDir,
        manualOnly: skill.disableModelInvocation,
        enabled: SkillStore.effective(skill, userDisabled, projectOverrides),
        userDisabled: userDisabled.has(skill.name),
        ...(projectOverrides.has(skill.name) && { override: projectOverrides.get(skill.name) })
      })),
      errors
    }
  }

  /**
   * 装配/展开用活快照：合并发现 − 禁用项（manualOnly 保留 —— 它们仍可
   * /skill: 手动调用，进不进模型清单由 skill-prompt 的 formatter 决定）。
   * 无缓存：每次调用重新发现（段钩子每回合调用 = 热刷新数据面）。
   */
  snapshot(cwd?: string): { skills: Skill[]; errors: string[] } {
    const { skills, userDisabled, projectOverrides, errors } = this.merged(cwd)
    return { skills: skills.filter((s) => SkillStore.effective(s, userDisabled, projectOverrides)), errors }
  }

  private dirFor(scope: SkillScope, cwd?: string): string {
    if (scope === 'user') return this.userDir
    if (cwd === undefined) invalid([`scope=project 需要 cwd（项目技能目录所在工作区）`])
    return this.projectDir(cwd)
  }

  /**
   * 新增/编辑一枚技能（skills.save 委托）：frontmatter 由引擎生成（防
   * 手写错），目录名 = name（发现规则按目录取 SKILL.md，名字一致才可往返）。
   * 写入前跑 pi 同款校验，非法即 throw（手动设置动作明确反馈）。
   */
  save(scope: SkillScope, cwd: string | undefined, name: string, description: string, body: string): void {
    const nameErrors = validateName(name)
    if (nameErrors.length > 0) invalid(nameErrors)
    const descriptionError = validateDescription(description)
    if (descriptionError !== undefined) invalid([descriptionError])
    const dir = this.dirFor(scope, cwd)
    const content = `---\nname: ${yamlString(name)}\ndescription: ${yamlString(description)}\n---\n\n${body}\n`
    atomicWrite(join(dir, name, 'SKILL.md'), content)
  }

  /**
   * 删除技能目录（skills.delete 委托）：只清同级状态文件的对应名（跨级
   * 名单可能是对另一作用域同名技能的合法状态，不动）。
   */
  delete(scope: SkillScope, cwd: string | undefined, name: string): void {
    const nameErrors = validateName(name)
    if (nameErrors.length > 0) invalid(nameErrors)
    const dir = this.dirFor(scope, cwd)
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
   * 写启停状态（skills.setEnabled 委托）：user 档写禁用名单（inherit 无
   * 更上层可回落，非法）；project 档写 overrides（inherit = 清除该名覆盖）。
   * 目标名必须在当前发现里（对空名写状态 = UI bug，fail-fast）。
   */
  setEnabled(scope: SkillScope, cwd: string | undefined, name: string, value: 'enabled' | 'disabled' | 'inherit'): void {
    const nameErrors = validateName(name)
    if (nameErrors.length > 0) invalid(nameErrors)
    if (!this.discover(scope === 'project' ? cwd : undefined).skills.some((s) => s.name === name)) {
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

  /**
   * 读单枚技能正文（skills.read 委托）：编辑表单回填源。查找视图与调用方
   * 的列表口径一致（user 档 = user 目录，project 档 = 两级合并胜者）。
   */
  read(scope: SkillScope, cwd: string | undefined, name: string): { description: string; body: string } {
    const nameErrors = validateName(name)
    if (nameErrors.length > 0) invalid(nameErrors)
    const skill = this.discover(scope === 'project' ? cwd : undefined).skills.find((s) => s.name === name)
    if (skill === undefined) invalid([`技能 "${name}" 不存在`])
    const { frontmatter, body } = parseFrontmatter(readFileSync(skill.filePath, 'utf8'))
    const description = frontmatter.description
    if (typeof description !== 'string' || description.length === 0) {
      invalid([`${skill.filePath}: description 缺失（引擎生成的技能不会这样 —— 手放文件请补 frontmatter）`])
    }
    return { description, body }
  }

  /**
   * `/skill:name args` 活展开（Cogent submit 路径委托，替代 pi 内建的
   * loader 静态集查找）：命中禁用技能 = 视为不存在原样透传；manualOnly
   * 技能可展开（这正是它存在的意义）。读文件失败也透传（模型看到字面
   * /skill: 名 = 可见信号），stderr 留痕一次。
   */
  expandSkillCommand(text: string, cwd?: string): string {
    if (!text.startsWith('/skill:')) return text
    const rest = text.slice(7)
    const spaceIndex = rest.indexOf(' ')
    const name = spaceIndex === -1 ? rest : rest.slice(0, spaceIndex)
    const args = spaceIndex === -1 ? '' : rest.slice(spaceIndex + 1).trim()
    const skill = this.snapshot(cwd).skills.find((s) => s.name === name)
    if (skill === undefined) return text
    try {
      const content = readFileSync(skill.filePath, 'utf8')
      const body = stripFrontmatter(content).trim()
      const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`
      return args === '' ? block : `${block}\n\n${args}`
    } catch (error) {
      process.stderr.write(`[skills] 展开 /skill:${name} 失败：${error instanceof Error ? error.message : String(error)}\n`)
      return text
    }
  }
}
