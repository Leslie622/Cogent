/** 设置搜索纯函数与 store 导航状态机测试。 */
import { beforeEach, describe, expect, it } from 'vitest'
import { searchSettings, splitHighlightSegments } from '@/features/settings/search/match'
import { useSettingsStore } from '@/stores/settings'

describe('searchSettings', () => {
  it('支持中文单字/短词、英文大小写、全角 NFKC、多余空白与字面特殊字符', () => {
    expect(searchSettings('   ').items).toEqual([])
    expect(searchSettings('字').items.length).toBeGreaterThan(1)

    const fullWidth = searchSettings('　ａｐｉ  ｋｅｙ　')
    expect(fullWidth.pages.some((p) => p.entry.section === 'models')).toBe(true)

    // 字面正则特殊字符不当作正则，不抛错
    expect(() => searchSettings('[a+b](test).*?')).not.toThrow()
    expect(searchSettings('Shift+Enter').items.some((r) => r.entry.id === 'general.send-shortcut')).toBe(true)
  })

  it('支持多词组合与别名命中，标题优先级高于别名与说明，页面与配置项分别计数', () => {
    const combo = searchSettings('外观 字体')
    expect(combo.items.some((r) => r.entry.id === 'appearance.content-font')).toBe(true)
    expect(combo.items.some((r) => r.entry.id === 'appearance.code-font')).toBe(true)
    expect(combo.matchedSectionIds.has('appearance')).toBe(true)

    const aliasHit = searchSettings('字体风格')
    expect(aliasHit.items[0]?.entry.id).toBe('appearance.content-font')
    expect(aliasHit.items[0]?.primaryMatch).toBe('alias')
    expect(aliasHit.items[0]?.matchedAlias).toBe('字体风格')

    const archivedHit = searchSettings('已归档的聊天')
    expect(archivedHit.pages.some((p) => p.entry.section === 'archived-chats')).toBe(true)
    expect(archivedHit.items.length).toBe(0)
  })

  it('占位分区可搜到页面入口，不生成假配置项；平台与环境条件与原页面一致', () => {
    const shortcutHit = searchSettings('快捷键')
    expect(shortcutHit.pages.some((p) => p.entry.section === 'shortcuts')).toBe(true)

    const linuxNotify = searchSettings('系统通知设置', { platform: 'linux' })
    expect(linuxNotify.items.some((r) => r.entry.id === 'notifications.system-settings')).toBe(false)

    const winNotify = searchSettings('系统通知设置', { platform: 'win32' })
    expect(winNotify.items.some((r) => r.entry.id === 'notifications.system-settings')).toBe(true)

    const noBackdrop = searchSettings('外壳不透明度', { backdropSupported: false })
    expect(noBackdrop.items.some((r) => r.entry.id === 'appearance.shell-opacity')).toBe(false)

    const withBackdrop = searchSettings('外壳不透明度', { backdropSupported: true })
    expect(withBackdrop.items.some((r) => r.entry.id === 'appearance.shell-opacity')).toBe(true)

    const darkWithBackdrop = searchSettings('外壳不透明度', { backdropSupported: true, dark: true })
    expect(darkWithBackdrop.items.some((r) => r.entry.id === 'appearance.shell-opacity')).toBe(false)
  })

  it('splitHighlightSegments 准确切分匹配片段且不转义普通字符', () => {
    const segments = splitHighlightSegments('Shift + Enter', ['shift'])
    expect(segments).toEqual([
      { text: 'Shift', matched: true },
      { text: ' + Enter', matched: false },
    ])
  })
})

describe('useSettingsStore 搜索导航状态', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      section: 'general',
      query: '',
      viewMode: 'detail',
      locateRequest: null,
      navToken: 0,
      navReason: 'init',
    })
  })

  it('完整流转：输入搜索 → 左侧浏览 → 返回结果 → 打开配置项 → 消费与清除 → 清空保留当前页', () => {
    const store = useSettingsStore.getState()

    store.setQuery('字体')
    expect(useSettingsStore.getState()).toMatchObject({
      query: '字体',
      viewMode: 'results',
      section: 'general',
      navReason: 'search-results',
    })

    useSettingsStore.getState().browseSectionFromSearch('appearance')
    expect(useSettingsStore.getState()).toMatchObject({
      query: '字体',
      viewMode: 'detail',
      section: 'appearance',
      locateRequest: null,
      navReason: 'search-browse',
    })

    useSettingsStore.getState().backToResults()
    expect(useSettingsStore.getState()).toMatchObject({
      query: '字体',
      viewMode: 'results',
      navReason: 'search-results',
    })

    useSettingsStore.getState().openSearchResult({
      section: 'appearance',
      itemId: 'appearance.content-font',
    })
    const afterOpen = useSettingsStore.getState()
    expect(afterOpen.viewMode).toBe('detail')
    expect(afterOpen.section).toBe('appearance')
    expect(afterOpen.navReason).toBe('locate')
    expect(afterOpen.locateRequest).toMatchObject({
      section: 'appearance',
      itemId: 'appearance.content-font',
      consumed: false,
    })

    const token = afterOpen.locateRequest!.token
    useSettingsStore.getState().consumeLocate(token)
    expect(useSettingsStore.getState().locateRequest?.consumed).toBe(true)

    // 在详情中清空搜索：保留当前页且不触发回顶
    useSettingsStore.getState().setQuery('')
    expect(useSettingsStore.getState()).toMatchObject({
      query: '',
      viewMode: 'detail',
      section: 'appearance',
      locateRequest: null,
      navReason: 'clear-in-detail',
    })
  })

  it('外部 setSection 退出旧搜索并清除定位', () => {
    useSettingsStore.getState().setQuery('图片分析')
    useSettingsStore.getState().openSearchResult({
      section: 'connections',
      itemId: 'connections.media-image',
      scope: 'user',
    })

    useSettingsStore.getState().setSection('models')
    expect(useSettingsStore.getState()).toMatchObject({
      section: 'models',
      query: '',
      viewMode: 'detail',
      locateRequest: null,
      navReason: 'section',
    })
  })
})
