/**
 * template-vars.ts 单元测试（docs/计划/技能座升级实现.md §3.3）：
 * 通用变量映射表、生态别名、单遍防递归、未知变量保留、$ARGUMENTS/$N 替换与尾附、
 * 以及 allowSensitive: false 对机密凭据的硬隔离。
 */
import { describe, expect, it } from 'vitest'
import { expandTemplateVars, splitArguments } from '../../../src/host/runtime/template-vars'

describe('splitArguments', () => {
  it('按空白与单双引号切分位置参数', () => {
    expect(splitArguments('a "hello world" \'foo bar\' c')).toEqual(['a', 'hello world', 'foo bar', 'c'])
    expect(splitArguments('  --flag="a b"   x  ')).toEqual(['--flag=a b', 'x'])
  })
})

describe('expandTemplateVars', () => {
  it('展开技能、工作区、会话与生态兼容别名变量', () => {
    const out = expandTemplateVars(
      'dir=${COGENT_SKILL_DIR} claude=${CLAUDE_SKILL_DIR} proj=${COGENT_PROJECT_DIR} sid=${CLAUDE_SESSION_ID}',
      {
        skillDir: '/skills/demo',
        projectDir: '/repo/app',
        sessionId: 'sess-123'
      },
      { allowSensitive: false }
    )
    expect(out).toBe('dir=/skills/demo claude=/skills/demo proj=/repo/app sid=sess-123')
  })

  it('单遍替换防二次递归展开，且保留未定义变量不破坏代码块', () => {
    const out = expandTemplateVars(
      'path=${COGENT_SKILL_DIR} shell=${HOME} js=${user.id}',
      {
        skillDir: '/tmp/${COGENT_PROJECT_DIR}/$1',
        projectDir: '/should-not-expand',
        arguments: 'arg1'
      },
      { allowSensitive: false, appendUnusedArguments: false }
    )
    expect(out).toBe('path=/tmp/${COGENT_PROJECT_DIR}/$1 shell=${HOME} js=${user.id}')
  })

  it('支持 $ARGUMENTS、$ARGUMENTS[N] 与 $1..$9，未消费时自动尾附参数块', () => {
    const explicit = expandTemplateVars(
      'all=$ARGUMENTS first=$1 second=$ARGUMENTS[1] third=$3',
      { arguments: 'alpha "beta gamma"' },
      { allowSensitive: false }
    )
    expect(explicit).toBe('all=alpha "beta gamma" first=alpha second=beta gamma third=')

    const appended = expandTemplateVars(
      '执行默认检查步骤',
      { arguments: 'src/host' },
      { allowSensitive: false }
    )
    expect(appended).toBe('执行默认检查步骤\n\n<arguments>\nsrc/host\n</arguments>')
  })

  it('正文模式（allowSensitive: false）严禁替换 secrets，仅 extra 非机密变量生效', () => {
    const body = expandTemplateVars(
      'server=${API_BASE} token=${USER_TOKEN}',
      {
        extra: { API_BASE: 'https://api.example.com' },
        secrets: { USER_TOKEN: 'sk-secret-999' }
      },
      { allowSensitive: false }
    )
    expect(body).toBe('server=https://api.example.com token=${USER_TOKEN}')

    const sensitiveSink = expandTemplateVars(
      'token=${USER_TOKEN}',
      { secrets: { USER_TOKEN: 'sk-secret-999' } },
      { allowSensitive: true }
    )
    expect(sensitiveSink).toBe('token=sk-secret-999')
  })
})
