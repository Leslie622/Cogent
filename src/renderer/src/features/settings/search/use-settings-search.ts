/**
 * 派生设置搜索结果：从 store 的 query 与当前运行环境（platform / backdropSupported）
 * 同步计算匹配配置项、相关设置页与侧栏可见分区集合。
 */
import { useMemo } from 'react'
import { useIsDarkMode } from '@/stores/appearance'
import { useSettingsStore } from '@/stores/settings'
import { searchSettings, type SettingsSearchOutput } from './match'

export function readSearchEnvironment() {
  const cogent = 'cogent' in window ? window.cogent : undefined
  return {
    platform: cogent?.platform,
    backdropSupported: Boolean(cogent?.backdropSupported),
  }
}

export function useSettingsSearch(): SettingsSearchOutput & { query: string; hasQuery: boolean } {
  const query = useSettingsStore((s) => s.query)
  const dark = useIsDarkMode()
  const { platform, backdropSupported } = readSearchEnvironment()

  const output = useMemo(
    () => searchSettings(query, { platform, backdropSupported, dark }),
    [query, platform, backdropSupported, dark],
  )

  return {
    ...output,
    query,
    hasQuery: query.trim() !== '',
  }
}
