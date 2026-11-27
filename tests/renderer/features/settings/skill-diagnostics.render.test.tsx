/** SkillSection 行内警告/错误提示与不可用技能默认禁用的渲染行为。 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SkillSection } from '@/features/settings/SkillSection'
import { useChatStore } from '@/stores/chat'
import { useProjectStore } from '@/stores/project'
import type { SkillSummary } from '@/env.d'

vi.mock('@/components/ui/sonner', () => ({ showErrorToast: vi.fn() }))

const initialChat = useChatStore.getState()
const initialProject = useProjectStore.getState()

beforeEach(() => {
  useProjectStore.setState({ projects: [] })
  useChatStore.setState({ activeSessionId: null, sessions: [] })
})

afterEach(() => {
  useChatStore.setState(initialChat, true)
  useProjectStore.setState(initialProject, true)
  vi.unstubAllGlobals()
})

it('不展示配置诊断区块；警告与错误行内展示，不可用技能开关禁用', async () => {
  const skills: SkillSummary[] = [
    {
      name: 'PDF助手',
      description: '处理 PDF 文档',
      scope: 'user',
      origin: 'cogent',
      path: 'C:/skills/PDF助手/SKILL.md',
      baseDir: 'C:/skills/PDF助手',
      manualOnly: false,
      enabled: true,
      userDisabled: false,
      editable: false,
      diagnostics: [
        { severity: 'warning', message: '名称含不支持的字符（规范要求仅小写字母 a-z、数字 0-9 和连字符 -）' }
      ]
    },
    {
      name: 'test-broken',
      description: '',
      scope: 'user',
      origin: 'cogent',
      path: 'C:/skills/test-broken/SKILL.md',
      baseDir: 'C:/skills/test-broken',
      manualOnly: false,
      enabled: false,
      userDisabled: false,
      invalid: true,
      editable: true,
      diagnostics: [
        { severity: 'error', message: '缺少必填的 description，无法加载（请补充后刷新）' }
      ]
    },
    {
      name: 'badyaml',
      description: '',
      scope: 'user',
      origin: 'cogent',
      path: 'C:/skills/badyaml/SKILL.md',
      baseDir: 'C:/skills/badyaml',
      manualOnly: false,
      enabled: false,
      userDisabled: false,
      invalid: true,
      editable: false,
      diagnostics: [
        { severity: 'error', message: 'YAML frontmatter 解析失败' }
      ]
    }
  ]

  const request = vi.fn((method: string) => {
    if (method === 'skills.list') {
      return Promise.resolve({
        skills,
        errors: ['raw error should not create diagnostic group'],
        stateErrors: []
      })
    }
    if (method === 'skills.delete') return Promise.resolve({ ok: true })
    throw new Error(`未预期请求：${method}`)
  })
  const revealSkillDir = vi.fn(() => Promise.resolve({ ok: true }))
  vi.stubGlobal('cogent', {
    engineRequest: request,
    revealSkillDir,
    importSkills: vi.fn(),
    exportSkill: vi.fn()
  })

  render(<SkillSection />)

  await screen.findByText('PDF助手')

  // 无独立的「配置诊断」区块
  expect(screen.queryByText('配置诊断')).not.toBeInTheDocument()
  expect(screen.queryByText('raw error should not create diagnostic group')).not.toBeInTheDocument()

  // 工具栏仅计入可用技能数量（PDF助手 = 1）
  expect(screen.getByText('已安装 1')).toBeInTheDocument()

  // 行内徽标与本地化提示文案
  expect(screen.getByText('规范提示')).toBeInTheDocument()
  expect(screen.getByText('名称含不支持的字符（规范要求仅小写字母 a-z、数字 0-9 和连字符 -）')).toBeInTheDocument()
  expect(screen.getAllByText('不可用')).toHaveLength(2)
  expect(screen.getByText('缺少必填的 description，无法加载（请补充后刷新）')).toBeInTheDocument()
  expect(screen.getByText('YAML frontmatter 解析失败')).toBeInTheDocument()

  // 警告技能可启停，不可用技能默认关闭且开关禁用
  const pdfSwitch = screen.getByRole('switch', { name: 'PDF助手 启用' })
  expect(pdfSwitch).toBeChecked()
  expect(pdfSwitch).not.toHaveAttribute('aria-disabled', 'true')

  const brokenSwitch = screen.getByRole('switch', { name: 'test-broken 启用' })
  expect(brokenSwitch).not.toBeChecked()
  expect(brokenSwitch).toHaveAttribute('aria-disabled', 'true')

  const badYamlSwitch = screen.getByRole('switch', { name: 'badyaml 启用' })
  expect(badYamlSwitch).not.toBeChecked()
  expect(badYamlSwitch).toHaveAttribute('aria-disabled', 'true')

  // 不可用但 YAML 可解析的技能支持编辑补齐；YAML 损坏的不提供编辑或导出，但支持打开目录与删除
  expect(screen.getByRole('button', { name: '编辑 test-broken' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '查看 PDF助手' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '编辑 badyaml' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '导出 test-broken' })).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: '打开 test-broken 目录' }))
  await waitFor(() => expect(revealSkillDir).toHaveBeenCalledWith({ scope: 'user', name: 'test-broken' }))

  fireEvent.click(screen.getByRole('button', { name: '删除 badyaml' }))
  await waitFor(() => expect(request).toHaveBeenCalledWith('skills.delete', { scope: 'user', name: 'badyaml' }))
})
