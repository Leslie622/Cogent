/**
 * 端点模型列表发现弹窗（ModelDiscoveryDialog）：
 * 向当前自定义供应商的 /models 端点请求可用模型列表，支持搜索筛选、全选/反选可见项、
 * 增量合入（自动结合目录与家族预设补齐能力，保留已手动调优的模型定义）。
 */
import { useEffect, useMemo, useState } from 'react'
import { IconLoader2, IconSearch } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useEngineStore } from '@/stores/engine'
import { matchModelPreset } from '@shared/model-presets'
import type { CustomProviderDef, DiscoveredModel, ModelDef, ModelSummary } from '@/env.d'
import { BADGE, formatContext } from './models-recipes'

type ApiFormat = NonNullable<CustomProviderDef['apiFormat']>

export function ModelDiscoveryDialog({
  open,
  onClose,
  providerId,
  baseUrl,
  apiFormat,
  existingIds,
  catalog,
  onApply,
}: {
  open: boolean
  onClose: () => void
  providerId: string
  baseUrl: string
  apiFormat: ApiFormat
  existingIds: Set<string>
  catalog: Map<string, ModelSummary>
  onApply: (addedDefs: ModelDef[]) => void
}) {
  const discoverModels = useEngineStore((s) => s.discoverModels)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<DiscoveredModel[]>([])
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    if (!open) return
    let canceled = false
    setLoading(true)
    setError(null)
    setQuery('')
    void discoverModels({ providerId, baseUrl, apiFormat })
      .then((res) => {
        if (canceled) return
        setCandidates(res.models)
        // 默认只勾选尚未添加的模型，或若当前列表为空则全选
        const initial = new Set<string>()
        if (existingIds.size === 0) {
          for (const m of res.models) initial.add(m.id)
        }
        setSelected(initial)
      })
      .catch((err: unknown) => {
        if (canceled) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!canceled) setLoading(false)
      })
    return () => {
      canceled = true
    }
  }, [open, providerId, baseUrl, apiFormat, discoverModels, existingIds])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return candidates
    return candidates.filter(
      (m) => m.id.toLowerCase().includes(q) || (m.name?.toLowerCase().includes(q) ?? false)
    )
  }, [candidates, query])

  const newVisible = useMemo(
    () => filtered.filter((m) => !existingIds.has(m.id)),
    [filtered, existingIds]
  )

  const toggleOne = (id: string, next: boolean): void => {
    setSelected((prev) => {
      const copy = new Set(prev)
      if (next) copy.add(id)
      else copy.delete(id)
      return copy
    })
  }

  const selectAllVisible = (): void => {
    setSelected((prev) => {
      const copy = new Set(prev)
      for (const m of newVisible) copy.add(m.id)
      return copy
    })
  }

  const clearVisible = (): void => {
    setSelected((prev) => {
      const copy = new Set(prev)
      for (const m of newVisible) copy.delete(m.id)
      return copy
    })
  }

  const confirm = (): void => {
    const addedDefs: ModelDef[] = []
    for (const candidate of candidates) {
      if (!selected.has(candidate.id) || existingIds.has(candidate.id)) continue
      const hit = catalog.get(candidate.id)
      const preset = hit ? undefined : matchModelPreset(candidate.id, apiFormat)
      const reasoning = candidate.reasoning ?? hit?.reasoning ?? preset?.reasoning ?? false
      const thinkingLevelMap =
        candidate.thinkingLevelMap ?? hit?.thinkingLevelMap ?? preset?.thinkingLevelMap
      const contextWindow = candidate.contextWindow ?? hit?.contextWindow ?? preset?.contextWindow
      const maxTokens = candidate.maxTokens ?? hit?.maxTokens ?? preset?.maxTokens
      const input = candidate.input ?? hit?.input ?? preset?.input
      addedDefs.push({
        id: candidate.id,
        ...(candidate.name && { name: candidate.name }),
        ...(contextWindow !== undefined && { contextWindow }),
        ...(maxTokens !== undefined && { maxTokens }),
        ...(input !== undefined && { input }),
        ...(reasoning && { reasoning: true }),
        ...(reasoning && thinkingLevelMap !== undefined && { thinkingLevelMap }),
        ...(preset?.compat !== undefined && { compat: preset.compat }),
      })
    }
    onApply(addedDefs)
    onClose()
  }

  const selectedNewCount = candidates.filter(
    (m) => selected.has(m.id) && !existingIds.has(m.id)
  ).length

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg" initialFocus={false}>
        <DialogHeader>
          <DialogTitle>从端点获取模型列表</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
            <IconLoader2 className="size-4 animate-spin" />
            正在查询端点模型列表…
          </div>
        ) : error !== null ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </div>
        ) : candidates.length === 0 ? (
          <div className="flex h-36 items-center justify-center text-sm text-muted-foreground">
            端点未返回任何可用模型，可返回手动添加模型 ID。
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <IconSearch className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索模型 ID…"
                  className="pl-8 text-sm"
                  autoComplete="off"
                />
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={selectAllVisible} disabled={newVisible.length === 0}>
                全选
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={clearVisible} disabled={newVisible.length === 0}>
                清空
              </Button>
            </div>

            <div className="min-h-0 max-h-80 flex-1 overflow-y-auto -mx-4 px-4">
              <div className="divide-y divide-border rounded-lg border border-border">
                {filtered.map((m) => {
                  const alreadyAdded = existingIds.has(m.id)
                  const checked = alreadyAdded || selected.has(m.id)
                  const preset = catalog.get(m.id) ?? matchModelPreset(m.id, apiFormat)
                  const ctx = m.contextWindow ?? preset?.contextWindow
                  const isReasoning = m.reasoning ?? preset?.reasoning
                  return (
                    <label
                      key={m.id}
                      className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm hover:bg-accent-foreground/5"
                    >
                      <Checkbox
                        checked={checked}
                        disabled={alreadyAdded}
                        onCheckedChange={(v) => toggleOne(m.id, v === true)}
                      />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{m.id}</span>
                      {ctx !== undefined && (
                        <span className={BADGE}>{formatContext(ctx)}</span>
                      )}
                      {isReasoning && <span className={BADGE}>思考</span>}
                      {alreadyAdded && (
                        <span className="text-xs text-muted-foreground">已添加</span>
                      )}
                    </label>
                  )
                })}
                {filtered.length === 0 && (
                  <div className="flex h-20 items-center justify-center text-xs text-muted-foreground">
                    没有匹配的模型
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button onClick={confirm} disabled={loading || error !== null || selectedNewCount === 0}>
            添加所选{selectedNewCount > 0 ? `（${selectedNewCount}）` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
