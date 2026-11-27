/**
 * 内置命令门控与结构化提交校验单测：
 * 验证会话态门控、独占命令约束，以及纯文本 $xxx / /xxx 绝不误触发。
 */
import { describe, expect, it } from 'vitest'
import {
  buildCommandSuggestions,
  buildSkillSuggestions,
  prepareComposerSubmission
} from '../../../../src/renderer/src/features/home/composer/commands'
import { ENTITY_SENTINEL, type ComposerEntity } from '../../../../src/renderer/src/features/home/composer/types'

describe('buildCommandSuggestions', () => {
  it('新聊天草稿态不提供 /compact、/continue、/rename，无工作区时不提供 /init', () => {
    const ids = buildCommandSuggestions({
      isExistingSession: false,
      hasMessages: false,
      running: false,
      compacting: false,
      truncated: false,
      hasWorkspace: false
    }).map((item) => item.id)

    expect(ids).toContain('cmd:plan')
    expect(ids).toContain('cmd:new')
    expect(ids).toContain('cmd:settings')
    expect(ids).not.toContain('cmd:compact')
    expect(ids).not.toContain('cmd:continue')
    expect(ids).not.toContain('cmd:rename')
    expect(ids).not.toContain('cmd:init')
  })

  it('已有会话且有消息/截断/工作区时暴露全部对应命令', () => {
    const ids = buildCommandSuggestions({
      isExistingSession: true,
      hasMessages: true,
      running: false,
      compacting: false,
      truncated: true,
      hasWorkspace: true
    }).map((item) => item.id)

    expect(ids).toContain('cmd:compact')
    expect(ids).toContain('cmd:continue')
    expect(ids).toContain('cmd:rename')
    expect(ids).toContain('cmd:init')
  })
})

describe('buildSkillSuggestions', () => {
  it('仅保留已启用技能并标注项目/用户/生态徽标', () => {
    const items = buildSkillSuggestions([
      { name: 'a', description: '项目技能', scope: 'project', path: '/a', baseDir: '/', manualOnly: false, enabled: true, userDisabled: false },
      { name: 'b', description: '禁用技能', scope: 'user', path: '/b', baseDir: '/', manualOnly: false, enabled: false, userDisabled: true },
      { name: 'c', description: '生态技能', scope: 'user', path: '/c', baseDir: '/', manualOnly: true, enabled: true, userDisabled: false, eco: true }
    ])
    expect(items.map((x) => ({ label: x.label, badge: x.badge }))).toEqual([
      { label: 'a', badge: '项目' },
      { label: 'c', badge: '生态' }
    ])
  })
})

describe('prepareComposerSubmission', () => {
  it('纯文本 $control-browser 与 /compact 不产生任何实体或独占命令', () => {
    expect(prepareComposerSubmission('$control-browser 请帮我查一下', [], 0)).toEqual({
      kind: 'message',
      text: '$control-browser 请帮我查一下',
      skills: []
    })
    expect(prepareComposerSubmission('/compact', [], 0)).toEqual({
      kind: 'message',
      text: '/compact',
      skills: []
    })
  })

  it('/compact 独占实体支持无参或附带压缩说明，禁止混带技能/附件/前置正文', () => {
    const compactEntity: ComposerEntity = { id: 'c1', kind: 'command', name: 'compact', mode: 'standalone' }
    const skillEntity: ComposerEntity = { id: 's1', kind: 'skill', name: 'control-browser', scope: 'user' }

    expect(prepareComposerSubmission(`${ENTITY_SENTINEL} `, [compactEntity], 0)).toEqual({
      kind: 'standalone',
      name: 'compact'
    })
    expect(prepareComposerSubmission(`${ENTITY_SENTINEL} 保留架构决策`, [compactEntity], 0)).toEqual({
      kind: 'standalone',
      name: 'compact',
      instructions: '保留架构决策'
    })
    expect(prepareComposerSubmission(`前面有字 ${ENTITY_SENTINEL}`, [compactEntity], 0).kind).toBe('error')
    expect(prepareComposerSubmission(`${ENTITY_SENTINEL} ${ENTITY_SENTINEL}`, [compactEntity, skillEntity], 0).kind).toBe('error')
    expect(prepareComposerSubmission(`${ENTITY_SENTINEL}`, [compactEntity], 1).kind).toBe('error')
  })

  it('/continue 严格无参独占', () => {
    const cont: ComposerEntity = { id: 'c2', kind: 'command', name: 'continue', mode: 'standalone' }
    expect(prepareComposerSubmission(`${ENTITY_SENTINEL}`, [cont], 0)).toEqual({
      kind: 'standalone',
      name: 'continue'
    })
    expect(prepareComposerSubmission(`${ENTITY_SENTINEL} 多余参数`, [cont], 0).kind).toBe('error')
  })

  it('技能实体与 /init 命令可自由组合并自动去重', () => {
    const entities: ComposerEntity[] = [
      { id: 'c3', kind: 'command', name: 'init', mode: 'prompt' },
      { id: 's1', kind: 'skill', name: 'browser', scope: 'user' },
      { id: 's2', kind: 'skill', name: 'browser', scope: 'user' }
    ]
    expect(
      prepareComposerSubmission(`${ENTITY_SENTINEL} ${ENTITY_SENTINEL} ${ENTITY_SENTINEL} 重点写测试规范`, entities, 0)
    ).toEqual({
      kind: 'message',
      text: '重点写测试规范',
      skills: ['browser'],
      command: { name: 'init' }
    })
  })
})
