/** 真 Chromium 验证源默认值、主题导入、重要层、明暗与恢复跟随；不依赖外部 Themd。 */
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Markdown } from '@/components/ui/markdown'
import { useChatTheme } from '@/features/home/ChatTheme'
import { useThemeStore, DEFAULT_THEME_ID } from '@/stores/theme'
import { useAppearanceStore } from '@/stores/appearance'
import { bindAppearanceDom } from '@/lib/appearance-dom'
import sourceCss from '@/lib/theme/upstream/theme-base.css.txt?raw'
import '@/globals.css'

declare global { interface Window { themeResult?: { passed: boolean; results: string[]; error?: string } } }
const unbind = bindAppearanceDom()
const follow = { latin: 'theme', cjk: 'theme' } as const
const picture = './sample.svg'
const text = '# 一级\n\n正文 **加粗** *强调* ~~删除~~ [链接](https://example.com) `inline`\n\n## 二级\n\n### 三级\n\n#### 四级\n\n##### 五级\n\n###### 六级\n\n- 列表\n  - 嵌套\n\n任务：\n\n- [x] 已完成\n- [ ] 未完成\n\n> 引用\n\n> [!NOTE]\n> 提示正文\n\n| 表头 | 第二列 |\n| --- | --- |\n| 内容 | 内容 |\n\n```js\nconst value = 1;\nconsole.log(value);\n```' + `\n\n![样例](${picture})\n\n<script>window.badScript=true</script>`
const source = '<h1>一级</h1><p>正文 <strong>加粗</strong></p><h2>二级</h2><h3>三级</h3><h4>四级</h4><h5>五级</h5><h6>六级</h6><ul><li>列表<ul><li>嵌套</li></ul></li></ul><blockquote><p>引用</p></blockquote><table><thead><tr><th>表头</th></tr></thead><tbody><tr><td>内容</td></tr></tbody></table>'
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
const style = (selector: string) => getComputedStyle(document.querySelector(selector)!)
const assert = (value: boolean, message: string) => { if (!value) throw new Error(message) }

function App() {
  const vars = useChatTheme()
  const [streaming, setStreaming] = useState(false)
  useEffect(() => {
    const results: string[] = []
    const run = async () => {
      useAppearanceStore.setState({ contentFont: follow, codeFont: follow, codeFontSize: null, colorMode: 'light', uiFontSize: 14 })
      useThemeStore.getState().setActive(DEFAULT_THEME_ID)
      await document.fonts.ready
      for (let i = 0; i < 400 && !document.querySelector('.md-body pre code'); i++) await new Promise(resolve => setTimeout(resolve, 25))
      await frame()
      assert(style('.md-body').fontSize === '14px' && style('.md-body pre').fontSize === '14px', '内置聊天密度变化')
      results.push('内置默认保留 14px 正文与代码')
      const load = async (tokens: object, extraCss = '', dark?: object) => {
        const id = useThemeStore.getState().importTheme(JSON.stringify({ name: '浏览器验证', tokens, extraCss, dark }))
        assert(id !== null, '主题导入失败')
        await frame()
      }
      await load({})
      assert(style('.md-body pre').fontSize === '14px', `源代码字号未按正文派生：${style('.md-body pre').fontSize}`)
      const comparisons: Record<string, string[]> = {
        '': ['fontSize', 'lineHeight'], h1: ['fontSize', 'lineHeight', 'fontWeight', 'marginTop', 'marginBottom'],
        h2: ['fontSize', 'lineHeight', 'marginTop', 'marginBottom'], h3: ['fontSize'], h4: ['fontSize'], h5: ['fontSize'], h6: ['fontSize'],
        p: ['marginBottom', 'textAlign', 'textIndent'], ul: ['paddingLeft', 'listStyleType'], 'ul ul': ['listStyleType'],
        li: ['fontSize', 'lineHeight'], blockquote: ['paddingLeft', 'marginTop', 'marginBottom'], table: ['fontSize', 'borderCollapse'], th: ['paddingLeft', 'fontWeight'],
      }
      for (const [element, props] of Object.entries(comparisons)) {
        const actual = style(`.md-body ${element}`.trim())
        const expected = style(`.themd-source ${element}`.trim())
        for (const prop of props) {
          const key = prop.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
          assert(actual.getPropertyValue(key) === expected.getPropertyValue(key), `${element || 'root'}.${prop}: ${actual.getPropertyValue(key)} / ${expected.getPropertyValue(key)}`)
        }
      }
      assert(document.querySelector('.md-body .themd-callout-note') !== null, '提示块未适配')
      assert(style('.md-body li.task-list-item input').appearance === 'none', '任务列表未适配')
      results.push('空主题的 H1–H6、段落、列表、引用和表格几何与源 CSS 一致；提示块与任务列表生效')

      await load({ 'h1.size': '18px', 'h2.size': '15px', 'heading.marginTop': '12px', 'heading.marginBottom': '6px', 'p.align': 'center', 'root.size': '16px', 'img.width': '50%', 'img.margin': '12px', 'img.align': 'auto' })
      assert(style('.md-body h1').fontSize === '18px' && style('.md-body h2').fontSize === '15px', '导入标题字号未消费')
      assert(style('.md-body h1').marginTop === '0px' && style('.md-body h2').marginTop === '12px', '首标题/后续标题间距不符')
      assert(style('.md-body p').textAlign === 'center', '段落令牌未消费')
      const image = document.querySelector('.md-body [data-streamdown="image"]')!
      assert(Math.abs(image.getBoundingClientRect().width - 450) < 1, `图片百分比宽度未相对正文计算：${image.getBoundingClientRect().width}，包装 ${image.parentElement!.getBoundingClientRect().width}`)
      assert(style('.md-body [data-streamdown="image-wrapper"]').marginTop === '12px', '图片留白未留在包装层')
      assert(document.querySelector('.md-body script') === null, '原生安全清洗被破坏')
      results.push('Themd 格式 JSON 导入的标题与段落配置生效')

      const conflict = 'h1,p {font-family: fantasy !important} pre, pre * {font-family: fantasy !important; font-size:48px !important; --t-code-size:48px !important}'
      const tokens = { 'h1.fontLatin': 'Georgia', 'h1.fontCjk': 'SimSun', 'codeBlock.size': '17px' }
      await load(tokens, conflict, { 'hr.thickness': '3px' })
      useAppearanceStore.setState({ contentFont: { latin: 'local:Arial', cjk: 'theme' }, codeFont: { latin: 'local:Consolas', cjk: 'theme' }, codeFontSize: 20 })
      await frame()
      assert(style('.md-body h1').fontFamily.startsWith('Arial'), `标题用户字体未胜出: ${style('.md-body h1').fontFamily}`)
      assert(style('.md-body h1').fontFamily.includes('SimSun'), '用户英文覆盖误删主题中文')
      assert(style('.md-body p').fontFamily.startsWith('Arial'), '正文用户字体未胜出')
      assert(style('.md-body pre').fontSize === '20px' && style('.md-body pre code span').fontSize === '20px', '用户代码字号被附加 CSS 或高亮子节点覆盖')
      assert(style('.md-body pre code span').fontFamily.startsWith('Consolas'), '用户代码字体被附加 CSS 覆盖')
      results.push('用户字体/代码字号压过主题令牌、子元素属性和 !important；另一文字系统保留')

      useAppearanceStore.getState().setColorMode('dark')
      await frame()
      assert(style('.md-body h1').fontSize === '32px', '暗面缺键错误继承亮面')
      assert(style('.md-body pre').fontSize === '20px' && style('.md-body h1').fontFamily.startsWith('Arial'), '暗色切换丢用户覆盖')
      await useAppearanceStore.persist.rehydrate()
      await useThemeStore.persist.rehydrate()
      await frame()
      assert(style('.md-body pre').fontSize === '20px', '持久化重读丢覆盖')
      useThemeStore.getState().setActive(DEFAULT_THEME_ID)
      await frame()
      assert(style('.md-body pre').fontSize === '20px', '换主题丢覆盖')
      results.push('暗面整面替换、换主题与持久化重读均保留用户覆盖')

      useAppearanceStore.setState({ contentFont: follow, codeFont: follow, codeFontSize: null })
      await load(tokens, conflict)
      assert(style('.md-body h1').fontFamily === 'fantasy' && style('.md-body pre').fontSize === '48px', '清除用户覆盖后未恢复主题 CSS')
      await load({})
      assert(style('.md-body [data-streamdown="code-block-body"]').backgroundColor === style('[data-color-probe]').backgroundColor, '暗色代码底色未使用宿主缺省')
      results.push('恢复跟随不冻结旧值；无暗套时缺省代码底色适应暗色')
      setStreaming(true)
      await frame()
      assert(style('.md-body h1').fontSize === '32px', '流式排版变化')
      setStreaming(false)
      await frame()
      assert(style('.md-body h1').fontSize === '32px', '收口排版变化')
      for (const width of [320, 900]) {
        document.querySelector<HTMLElement>('[data-subject]')!.style.width = `${width}px`
        await frame()
        const root = document.querySelector<HTMLElement>('[data-subject]')!
        assert(root.scrollWidth <= root.clientWidth + 1, `窄面板溢出：${width}`)
      }
      results.push('静态/流式/收口样式一致，320/900px 无横向溢出')
      window.themeResult = { passed: true, results }
    }
    void run().catch((error: unknown) => { window.themeResult = { passed: false, results, error: error instanceof Error ? error.message : String(error) } })
  }, [])
  return <>
    <style>{sourceCss.replaceAll('.themd-prose', '.themd-source')}</style>
    <article className="themd-source" dangerouslySetInnerHTML={{ __html: source }} />
    <div data-subject style={{ ...vars, width: 900 }}><Markdown content={text} streaming={streaming} /></div>
    <div data-color-probe style={{ backgroundColor: 'var(--muted)' }} />
  </>
}
const app = createRoot(document.getElementById('root')!)
app.render(<App />)
if (import.meta.hot) import.meta.hot.dispose(() => { unbind(); app.unmount() })
