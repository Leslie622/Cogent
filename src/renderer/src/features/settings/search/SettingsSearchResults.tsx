/**
 * 设置搜索结果页：复用 SettingsPage / SettingsGroup 骨架，将具体配置项与
 * 页面级入口分组呈现、分别计数；点击「打开」进入所属页并触发精确定位或顶部浏览。
 */
import { Button } from '@/components/ui/button'
import { useSettingsStore } from '@/stores/settings'
import { SettingsGroup, SettingsPage } from '../SettingsParts'
import { splitHighlightSegments } from './match'
import { useSettingsSearch } from './use-settings-search'

function HighlightText({ text, tokens }: { text: string; tokens: readonly string[] }) {
  const segments = splitHighlightSegments(text, tokens)
  return (
    <>
      {segments.map((seg, idx) =>
        seg.matched ? (
          <mark
            key={idx}
            className="rounded-xs bg-chrome-accent/15 px-0.5 text-foreground dark:bg-chrome-accent/25"
          >
            {seg.text}
          </mark>
        ) : (
          <span key={idx}>{seg.text}</span>
        ),
      )}
    </>
  )
}

export function SettingsSearchResults() {
  const { query, tokens, items, pages } = useSettingsSearch()
  const setQuery = useSettingsStore((s) => s.setQuery)
  const openSearchResult = useSettingsStore((s) => s.openSearchResult)
  const trimmed = query.trim()

  const summary =
    items.length === 0 && pages.length === 0
      ? undefined
      : `找到 ${items.length} 项匹配的设置、${pages.length} 个相关设置页`

  return (
    <SettingsPage title="搜索结果" desc={summary}>
      {items.length === 0 && pages.length === 0 ? (
        <div className="mt-8 flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-12 text-center">
          <div className="text-sm text-muted-foreground">
            没有找到与“{trimmed}”相关的设置
          </div>
          <Button variant="outline" size="default" onClick={() => setQuery('')}>
            清空搜索
          </Button>
        </div>
      ) : (
        <>
          {items.length > 0 && (
            <SettingsGroup label={`匹配的设置 (${items.length})`}>
              {items.map(({ entry, primaryMatch, matchedAlias }) => (
                <div
                  key={entry.id}
                  className="flex flex-col items-stretch justify-between gap-3 px-5 py-4 @min-[36rem]/settings:flex-row @min-[36rem]/settings:items-center @min-[36rem]/settings:gap-6"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">
                      <HighlightText text={entry.title} tokens={tokens} />
                    </div>
                    <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      <HighlightText text={entry.path} tokens={tokens} />
                    </div>
                    {primaryMatch === 'alias' && matchedAlias !== undefined && (
                      <div className="mt-1 text-xs text-muted-foreground">
                        匹配关键词：<HighlightText text={matchedAlias} tokens={tokens} />
                      </div>
                    )}
                    {primaryMatch === 'desc' && (
                      <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        <HighlightText text={entry.desc} tokens={tokens} />
                      </div>
                    )}
                  </div>
                  <div className="shrink-0">
                    <Button
                      variant="outline"
                      size="default"
                      aria-label={`打开 ${entry.title}`}
                      onClick={() =>
                        openSearchResult({
                          section: entry.section,
                          itemId: entry.id,
                          scope: entry.scope,
                        })
                      }
                    >
                      打开
                    </Button>
                  </div>
                </div>
              ))}
            </SettingsGroup>
          )}

          {pages.length > 0 && (
            <SettingsGroup label={`相关设置页 (${pages.length})`}>
              {pages.map(({ entry, primaryMatch, matchedAlias }) => (
                <div
                  key={entry.id}
                  className="flex flex-col items-stretch justify-between gap-3 px-5 py-4 @min-[36rem]/settings:flex-row @min-[36rem]/settings:items-center @min-[36rem]/settings:gap-6"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      <HighlightText text={entry.title} tokens={tokens} />
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                        设置页
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      <HighlightText text={entry.path} tokens={tokens} />
                    </div>
                    {primaryMatch === 'alias' && matchedAlias !== undefined && (
                      <div className="mt-1 text-xs text-muted-foreground">
                        匹配关键词：<HighlightText text={matchedAlias} tokens={tokens} />
                      </div>
                    )}
                  </div>
                  <div className="shrink-0">
                    <Button
                      variant="outline"
                      size="default"
                      aria-label={`打开 ${entry.title}`}
                      onClick={() => openSearchResult({ section: entry.section })}
                    >
                      打开
                    </Button>
                  </div>
                </div>
              ))}
            </SettingsGroup>
          )}
        </>
      )}
    </SettingsPage>
  )
}
