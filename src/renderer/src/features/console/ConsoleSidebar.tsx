/**
 * 控制台会话侧栏：会话列表（点选 = 时间线数据源切换）+ 四层过滤开关。
 * 行配方照 UI布局.md 列表行（h-8 hover 底 + active 常驻 hover 色）；
 * 运行中的会话带呼吸点（runningBySession，实时事件维护）。
 */
import { useConsoleStore } from '@/stores/console'
import { LAYERS } from './kinds'
import { Switch } from '@/components/ui/switch'

export function ConsoleSidebar() {
  const sessions = useConsoleStore((s) => s.sessions)
  const sessionId = useConsoleStore((s) => s.sessionId)
  const runningBySession = useConsoleStore((s) => s.runningBySession)
  const layers = useConsoleStore((s) => s.layers)
  const selectSession = useConsoleStore((s) => s.selectSession)
  const toggleLayer = useConsoleStore((s) => s.toggleLayer)

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1 flex-col px-3 py-4">
        <span className="mb-2 px-2 text-base font-semibold">会话</span>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {sessions.length === 0 ? (
            <p className="px-2 py-6 text-[13px] leading-relaxed text-muted-foreground">
              暂无会话。去主窗口发一条消息，这里就会出现观测记录。
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {sessions.map((session) => (
                <li key={session.id}>
                  <button
                    type="button"
                    className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] ${
                      session.id === sessionId ? 'bg-foreground/5' : 'hover:bg-foreground/5'
                    }`}
                    onClick={() => void selectSession(session.id)}
                  >
                    <span className="truncate">{session.title}</span>
                    {runningBySession[session.id] === true && (
                      <span className="ml-auto size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t px-5 py-4">
        <span className="text-base font-semibold">过滤</span>
        <ul className="mt-2 flex flex-col gap-1">
          {LAYERS.map((layer) => (
            <li key={layer.id} className="flex h-8 items-center gap-2">
              <span className={`size-1.5 rounded-full ${layer.dot}`} />
              <span className="text-[13px]">{layer.label}</span>
              <Switch
                size="sm"
                className="ml-auto"
                checked={layers[layer.id]}
                onCheckedChange={() => toggleLayer(layer.id)}
                aria-label={`显示${layer.label}层`}
              />
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
