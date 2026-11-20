/**
 * 设置 · 存储分区：存储根（~/.cogent）的占用统计 + 数据文件夹位置。
 * 数据源 = main 的 storage:usage 只读扫描（只回顶层条目字节数事实），
 * 归类 / 明细两档聚合 / 字节格式化在 storage-view.ts 纯函数（单测钉行为）。
 * 快照缓存 stale-while-revalidate（MCP 页同款）：切分区回来先渲染旧值，
 * 后台照常刷新，不闪加载卡；总量行右端的刷新钮显式重扫。
 * 「浏览」经 shell:open-path 开资源管理器（失败错误串就地呈现）。
 */
import { useCallback, useEffect, useState } from 'react'
import { IconChevronDown, IconFolderOpen, IconRefresh } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { unwrapIpcError } from '@/lib/ipc'
import type { StorageUsageResult } from '@/env.d'
import { SettingsGroup, SettingsPage, SettingsRow } from './SettingsParts'
import { buildDetail, buildLegend, formatBytes } from './storage-view'

/** IPC / 打开错误 → 文案（失败原样呈现给用户） */
const messageOf = (error: unknown): string => unwrapIpcError(error)

/** 快照缓存（模块级）：分区切换 = 组件重挂载，本地 state 归零会先塌加载卡 */
let usageCache: StorageUsageResult | null = null

export function StorageSection() {
  /** null = 加载中（仅首次访问、缓存未命中时短暂出现） */
  const [usage, setUsage] = useState<StorageUsageResult | null>(usageCache)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)

  const refresh = useCallback(async () => {
    setScanning(true)
    try {
      const next = await window.cogent.getStorageUsage()
      usageCache = next
      setUsage(next)
      setError(null)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setScanning(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 无快照（首访扫描中 / 首扫失败）：单卡占位，拿到数据前不铺半截布局
  if (usage === null) {
    return (
      <SettingsPage title="存储" desc="应用数据占用的磁盘空间与存储位置">
        <div className="mt-8 rounded-lg border border-border px-5 py-10 text-center text-xs text-muted-foreground">
          {error ?? '正在统计占用…'}
        </div>
      </SettingsPage>
    )
  }

  const legend = buildLegend(usage.entries)
  const detail = buildDetail(usage.entries)

  /** 打开存储根（资源管理器）；失败错误串就地呈现，不抛 */
  const openRoot = async (): Promise<void> => {
    const failure = await window.cogent.openPath(usage.root)
    if (failure !== null) setError(failure)
  }

  return (
    <SettingsPage title="存储" desc="应用数据占用的磁盘空间与存储位置">
      <SettingsGroup label="空间占用">
        <div className="px-5 py-4">
          {/* 总量行：数值右置，刷新钮贴行尾（参考稿同位 —— 重扫动作就属于这行数据） */}
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm">
              应用数据共占用
              <span className="ml-2 font-semibold tabular-nums">{formatBytes(usage.totalBytes)}</span>
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              disabled={scanning}
              onClick={() => void refresh()}
              aria-label="重新统计占用"
            >
              <IconRefresh className="size-4" />
            </Button>
          </div>
          {/* 分段条：flexGrow 按字节数分宽（免百分比取整误差）；空根（0 字节）不画。
              圆角 sm 档（2026-11-20 用户定调弃胶囊）：条高 h-4 仅 16px，CSS 会把
              ≥8px 的圆角（md/lg/full）钳成高度一半 = 半圆，与胶囊无异；
              只有 sm（6px）能收出可见的方角端头 */}
          {legend.length > 0 && (
            <div
              className="mt-3 flex h-4 overflow-hidden rounded-sm"
              role="img"
              aria-label={legend.map((s) => `${s.label} ${formatBytes(s.bytes)}`).join('，')}
            >
              {legend.map((segment) => (
                <div key={segment.id} className={segment.swatch} style={{ flexGrow: segment.bytes }} />
              ))}
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
            {legend.map((segment) => (
              <span key={segment.id} className="flex items-center gap-1.5 text-xs">
                <span className={`size-2 shrink-0 rounded-full ${segment.swatch}`} aria-hidden="true" />
                {segment.label}
                <span className="text-muted-foreground tabular-nums">{formatBytes(segment.bytes)}</span>
              </span>
            ))}
          </div>
          {error !== null && <div className="mt-3 text-xs text-destructive">{error}</div>}
        </div>
        {/* 明细折叠：不铺内部条目清单 —— 会话转录单列 + 「其他」聚合（用户定调） */}
        {detail.length > 0 && (
          <Collapsible open={detailOpen} onOpenChange={setDetailOpen}>
            {/* 裸 button 触发（组卡行内无库形态可套，归档组头同款基础档） */}
            <CollapsibleTrigger
              render={
                <button
                  type="button"
                  className="flex w-full items-center gap-1.5 px-5 py-3 text-sm text-muted-foreground outline-none hover:bg-muted/50"
                />
              }
            >
              占用明细
              <IconChevronDown
                className={`size-[13px] transition-transform ${!detailOpen ? '-rotate-90' : ''}`}
              />
            </CollapsibleTrigger>
            {/* 导航变体承载 200ms 高度+透明度过渡（归档组同款）；变体内层的
                pt-0.5 行间隙是给侧栏悬停行备的，明细卡自带 border-t 贴着触发行，
                归零覆盖防 2px 透缝 */}
            <CollapsibleContent
              variant="navigation"
              className="data-open:[&>div]:pt-0 data-starting-style:[&>div]:pt-0 data-ending-style:[&>div]:pt-0"
            >
              <div className="flex flex-col divide-y divide-border border-t border-border">
                {detail.map((row) => (
                  <div key={row.label} className="flex items-center justify-between gap-4 px-5 py-2.5">
                    <span className="min-w-0 truncate text-sm">{row.label}</span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {formatBytes(row.bytes)}
                    </span>
                  </div>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </SettingsGroup>

      <SettingsGroup label="数据文件夹">
        <SettingsRow
          title="应用数据文件夹"
          desc={
            // 路径是本页最常被复制的内容：放开选择 + 等宽换行展示全文
            <span className="select-text break-all font-mono">{usage.root}</span>
          }
        >
          <Button size="default" onClick={() => void openRoot()}>
            <IconFolderOpen className="size-4" />
            浏览
          </Button>
        </SettingsRow>
      </SettingsGroup>
    </SettingsPage>
  )
}
