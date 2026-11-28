/** 普通网页仅在初始化重试/休眠恢复时重建；排序/布局变化不会搬动 guest 的父树。 */
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, Copy, Ellipsis, ExternalLink, FolderOpen, Globe, History, Minus, Plus, RotateCw, Search, Shield, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/Hint'
import { cn } from 'cn'
import { useHoverSlide } from '@/hooks/use-hover-slide'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { BrowserCloseResult, BrowserEvent, BrowserHistory, BrowserMethods, BrowserReservation, BrowserSitePermission, BrowserState } from '@shared/browser'

interface BrowserElement extends HTMLElement { getWebContentsId: () => number }
export interface BrowserPaneProps {
  scopeId: string
  tabId: string
  url?: string
  privateGroupId?: string
  active: boolean
  initialHistory?: BrowserHistory
  previewLeaseId?: string
  allowPreviewRoot?: boolean
  onState: (state: BrowserState) => void
  onHistory?: (history: BrowserHistory) => void
  onRegisterClose?: (close: () => Promise<BrowserCloseResult>) => (() => void) | void
  onOpenUrl?: (url: string) => void
  onReleased?: () => void
}
const PERMISSION_NAMES: Record<string, string> = { 'clipboard-read': '读取剪贴板', notifications: '网站通知', media: '摄像头与麦克风', geolocation: '地理位置', fullscreen: '全屏', pointerLock: '锁定指针', keyboardLock: '锁定键盘', 'speaker-selection': '选择音频输出' }
const PERMISSION_DECISIONS = [{ value: 'ask', label: '询问' }, { value: 'allow', label: '允许' }, { value: 'deny', label: '拒绝' }] satisfies Array<{ value: BrowserSitePermission['decision']; label: string }>

export function BrowserPane(props: BrowserPaneProps) {
  const live = useRef(props); live.current = props
  // 工具栏「后退 / 前进 / 刷新」三钮之间的悬停滑动；地址栏与菜单钮不入组
  const navSlide = useHoverSlide()
  const host = useRef<HTMLDivElement>(null)
  const addressInput = useRef<HTMLInputElement>(null)
  const reservationRef = useRef<BrowserReservation | null>(null)
  const [reservation, setReservation] = useState<BrowserReservation | null>(null)
  const [ready, setReady] = useState(false)
  const [state, setState] = useState<BrowserState | null>(null)
  const [address, setAddress] = useState(props.url ?? '')
  const [error, setError] = useState<string | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [findText, setFindText] = useState('')
  const [found, setFound] = useState({ matches: 0, active: 0 })
  const [history, setHistory] = useState<BrowserHistory>({ entries: [], index: -1 })
  const [permissionsOpen, setPermissionsOpen] = useState(false)
  const [permissions, setPermissions] = useState<BrowserSitePermission[]>([])
  const [searchProvider, setSearchProvider] = useState<'bing' | 'google' | 'duckduckgo'>('bing')
  const [clear, setClear] = useState<'cache' | 'all' | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [sleepConfirm, setSleepConfirm] = useState(false)
  const [sleeping, setSleeping] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const resumeHistory = useRef<BrowserHistory | null>(null)
  const resumeUrl = useRef<string | null>(null)
  const lastPreview = useRef<string | null>(null)
  const [prompt, setPrompt] = useState<Extract<BrowserEvent, { type: 'prompt' }> | null>(null)
  const [promptValue, setPromptValue] = useState('')
  const [authUsername, setAuthUsername] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const report = (value: unknown) => setError(value instanceof Error ? value.message : String(value))
  const request = <M extends keyof BrowserMethods>(method: M, params: Omit<BrowserMethods[M]['params'], 'lease'>): Promise<BrowserMethods[M]['result']> => {
    const item = reservationRef.current
    if (!item) return Promise.reject(new Error('浏览器尚未就绪'))
    return window.cogent.browserRequest(method, { ...params, lease: item.lease })
  }
  const refreshHistory = async () => {
    const item = reservationRef.current
    const value = await request('history', {})
    if (reservationRef.current !== item) return
    setHistory(value)
    live.current.onHistory?.(value)
  }
  const replyPrompt = async (value: string | null) => {
    if (!prompt) return
    const current = prompt
    setPrompt(null)
    setPromptValue(''); setAuthUsername(''); setAuthPassword('')
    try { await request('promptReply', { requestId: current.requestId, value }) } catch (error) { report(error) }
  }

  useEffect(() => {
    if (sleeping) return
    let disposed = false
    let element: BrowserElement | undefined
    let registeredClose: (() => void) | void
    let owned: BrowserReservation | null = null
    let initialized = false
    let initializing = false
    let failed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    setReady(false); setReservation(null); setState(null); setError(null)
    lastPreview.current = null
    const initial = live.current
    const current = () => !disposed && !failed && owned !== null && reservationRef.current === owned
    const clearTimer = () => { clearTimeout(timer); timer = undefined }
    const fail = (value: unknown) => {
      if (disposed || failed) return
      failed = true; initializing = false; clearTimer(); setReady(false); report(value)
    }
    // IPC与原生guest事件都可能永不完成；过期代次即使迟到成功，也必须等待用户重建。
    const armTimer = (message: string) => { clearTimer(); timer = setTimeout(() => fail(new Error(message)), 15_000) }
    const release = async (item: BrowserReservation) => {
      try { await window.cogent.browserRequest('release', { lease: item.lease }) }
      catch (cause) { console.error('释放浏览器标签失败', cause) }
    }
    const reportCurrent = (value: unknown) => { if (current()) report(value) }
    armTimer('浏览器初始化超时，请重试')
    const unsubscribe = window.cogent.onBrowserEvent(event => {
      if (disposed || failed) return
      if (event.tabId !== initial.tabId) return
      if (event.type === 'state') {
        if (event.state.lease !== reservationRef.current?.lease) return
        setState(event.state)
        live.current.onState(event.state)
        if (document.activeElement !== addressInput.current) setAddress(event.state.localFile ?? event.state.url)
        if (!event.state.loading && !event.state.crashed && initialized) void refreshHistory().catch(reportCurrent)
      } else if (event.type === 'find') setFound({ matches: event.matches, active: event.active })
      else if (event.type === 'released' && event.lease === reservationRef.current?.lease) { clearTimer(); reservationRef.current = null; setReservation(null); setReady(false); live.current.onReleased?.() }
      else if (event.type === 'prompt') { setPrompt(event); setPromptValue(event.defaultValue); setAuthUsername(''); setAuthPassword('') }
      else if (event.type === 'prompt-cancel') { setPrompt(current => current?.requestId === event.requestId ? null : current); setPromptValue(''); setAuthUsername(''); setAuthPassword('') }
      else if (event.type === 'shortcut' && live.current.active) {
        if (event.command === 'address') { addressInput.current?.focus(); addressInput.current?.select() }
        if (event.command === 'find') setFindOpen(true)
      }
    })
    void window.cogent.browserRequest('reserve', { scopeId: initial.scopeId, tabId: initial.tabId, ...(initial.privateGroupId !== undefined && { privateGroupId: initial.privateGroupId }) }).then(async item => {
      if (disposed || failed) { await release(item); return }
      owned = item
      reservationRef.current = item
      setReservation(item)
      armTimer('网页启动超时，未收到就绪信号，请重试')
      element = document.createElement('webview') as BrowserElement
      element.setAttribute('partition', item.partition)
      element.setAttribute('allowpopups', '')
      element.setAttribute('src', item.bootstrapUrl)
      element.setAttribute('aria-label', '网页内容')
      element.setAttribute('data-browser-guest', initial.tabId)
      element.style.width = '100%'; element.style.height = '100%'; element.style.display = 'flex'
      // Chromium透明画布使用浏览器白色底，网站仍自行决定其页面与深色主题。
      element.style.backgroundColor = '#fff'
      element.addEventListener('dom-ready', () => {
        if (!current()) return
        if (initialized) { setReady(true); return }
        if (initializing) return
        initializing = true
        armTimer('浏览器连接超时，请重试')
        void (async () => {
          await window.cogent.browserRequest('attach', { lease: item.lease, webContentsId: element!.getWebContentsId() })
          if (!current()) return
          await window.cogent.browserRequest('visibility', { lease: item.lease, active: live.current.active })
          if (!current()) return
          initialized = true; initializing = false; clearTimer()
          setReady(true)
          const preferences = await request('preferences', {})
          if (!current()) return
          setSearchProvider(preferences.search)
          if (initial.previewLeaseId) return
          if ((resumeHistory.current ?? initial.initialHistory)?.entries.length) await request('restore', (resumeHistory.current ?? initial.initialHistory)!)
          else if (resumeUrl.current ?? initial.url) await request('navigate', { url: (resumeUrl.current ?? initial.url)! })
        })().catch(cause => { if (current()) { if (initialized) report(cause); else fail(cause) } })
      })
      host.current!.append(element)
      registeredClose = live.current.onRegisterClose?.(() => { clearTimer(); return window.cogent.browserRequest('close', { lease: item.lease }) })
    }).catch(fail)
    return () => {
      disposed = true; clearTimer(); unsubscribe(); registeredClose?.()
      setReady(false)
      if (reservationRef.current === owned) reservationRef.current = null
      if (owned !== null) void release(owned)
      element?.remove()
    }
    // scope 从 draft 晋升 session 不换实例，回调通过 live ref 读取当前归属。
  }, [sleeping, attempt])

  useEffect(() => {
    if (!ready || reservation === null || reservationRef.current !== reservation) return
    let current = true
    void window.cogent.browserRequest('visibility', { lease: reservation.lease, active: props.active }).catch(error => { if (current && reservationRef.current === reservation) report(error) })
    return () => { current = false }
  }, [reservation, ready, props.active])
  useEffect(() => {
    const source = props.previewLeaseId
    if (!ready || !source || source === lastPreview.current) return
    lastPreview.current = source
    let current = true
    setError(null)
    void request('preview', { source: { leaseId: source } }).catch(error => { if (current && lastPreview.current === source) report(error) })
    return () => { current = false }
  }, [ready, props.previewLeaseId])
  const navigate = async () => { setError(null); try { await request('navigate', { url: address }); addressInput.current?.blur() } catch (error) { report(error) } }
  const changePermission = async (permission: BrowserSitePermission, decision: BrowserSitePermission['decision']) => {
    try { await request('permission', { ...permission, decision }); setPermissions(await request('permissions', {})) } catch (error) { report(error) }
  }

  const sleep = async () => {
    try {
      resumeHistory.current = await request('history', {})
      resumeUrl.current = state?.url ?? props.url ?? ''
      setSleepConfirm(false); setReservation(null); setState(null); setSleeping(true)
    } catch (error) { report(error) }
  }

  return <div className="relative flex h-full min-h-0 flex-col" data-browser-pane={props.tabId} data-browser-lease={reservation?.lease}>
    <div className="flex shrink-0 items-center gap-2 px-3 py-2" data-browser-toolbar>
      <div ref={navSlide.containerRef} className={cn(navSlide.containerClassName, 'flex shrink-0 items-center gap-1')} data-browser-navigation>
        {navSlide.pill}
        <Hint tip="网页后退" side="bottom"><Button variant="ghost" size="icon-sm" data-hover-slide aria-label="网页后退" disabled={!state?.canGoBack} onClick={() => void request('back', {}).catch(report)}><ArrowLeft /></Button></Hint>
        <Hint tip="网页前进" side="bottom"><Button variant="ghost" size="icon-sm" data-hover-slide aria-label="网页前进" disabled={!state?.canGoForward} onClick={() => void request('forward', {}).catch(report)}><ArrowRight /></Button></Hint>
        <Hint tip={state?.loading ? '停止网页加载' : '刷新网页'} side="bottom"><Button variant="ghost" size="icon-sm" data-hover-slide aria-label={state?.loading ? '停止网页加载' : '刷新网页'} disabled={!ready} onClick={() => void request(state?.loading ? 'stop' : 'reload', {}).catch(report)}>{state?.loading ? <X /> : <RotateCw />}</Button></Hint>
      </div>
      <form className="min-w-0 flex-1" data-browser-address onSubmit={event => { event.preventDefault(); void navigate() }}>
        <Input ref={addressInput} className="text-center" aria-label="网页地址或搜索" placeholder={sleeping ? '网页已休眠' : ready ? '输入网址后回车' : '浏览器正在准备…'} disabled={!ready} value={address} onChange={event => setAddress(event.target.value)} onFocus={event => event.currentTarget.select()} />
      </form>
      <DropdownMenu open={props.active && menuOpen} onOpenChange={open => { if (props.active) setMenuOpen(open) }}>
        <Hint tip="浏览器菜单" side="bottom"><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="浏览器菜单" disabled={!ready && !sleeping}><Ellipsis /></Button>} /></Hint>
        <DropdownMenuContent align="end" className="w-64 max-w-[calc(100vw-1rem)] whitespace-nowrap" data-browser-menu>
          {props.privateGroupId && <DropdownMenuItem disabled>临时浏览 · 不保留登录与历史</DropdownMenuItem>}
          <DropdownMenuItem onClick={() => void navigator.clipboard.writeText(state?.localFile ?? state?.url ?? '').catch(report)}><Copy />复制地址</DropdownMenuItem>
          <DropdownMenuItem disabled={!state?.url} onClick={() => void request('external', {}).catch(report)}><ExternalLink />系统浏览器打开</DropdownMenuItem>
          <DropdownMenuItem onClick={() => { setFindOpen(true) }}><Search />页面内查找</DropdownMenuItem>
          <DropdownMenuSub onOpenChange={open => { if (open) void refreshHistory().catch(report) }}>
            <DropdownMenuSubTrigger aria-label="网页浏览历史" disabled={!ready}><History />浏览历史</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-80 max-w-[min(20rem,calc(100vw-1rem))] overflow-y-auto whitespace-nowrap">
              {history.entries.length === 0 && <DropdownMenuItem disabled>暂无浏览历史</DropdownMenuItem>}
              {history.entries.map((entry, index) => <DropdownMenuItem key={`${index}:${entry.url}`} onClick={() => void request('goTo', { index }).catch(report)}>{index === history.index && <Check />}<Hint tip={entry.url} side="left"><span className="min-w-0 truncate">{entry.title || entry.url}</span></Hint></DropdownMenuItem>)}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onClick={() => { setPermissionsOpen(true); void request('permissions', {}).then(setPermissions).catch(report) }}><Shield />站点权限</DropdownMenuItem>
          {props.previewLeaseId !== undefined && props.allowPreviewRoot && <DropdownMenuItem onClick={() => void request('preview', { source: { leaseId: props.previewLeaseId! }, pickRoot: true }).catch(report)}><FolderOpen />选择资源目录…</DropdownMenuItem>}
          <DropdownMenuSeparator />
          <div className="flex items-center justify-between gap-3 px-2 py-1 text-sm" aria-label="网页缩放">
            <Hint tip="缩小网页"><Button variant="ghost" size="icon-xs" aria-label="缩小网页" onClick={() => void request('zoom', { factor: Math.max(0.25, (state?.zoom ?? 1) - 0.1) }).catch(report)}><Minus /></Button></Hint>
            <Hint tip="恢复网页缩放"><Button variant="ghost" size="sm" aria-label="恢复网页缩放" onClick={() => void request('zoom', { factor: 1 }).catch(report)}>{Math.round((state?.zoom ?? 1) * 100)}%</Button></Hint>
            <Hint tip="放大网页"><Button variant="ghost" size="icon-xs" aria-label="放大网页" onClick={() => void request('zoom', { factor: Math.min(5, (state?.zoom ?? 1) + 0.1) }).catch(report)}><Plus /></Button></Hint>
          </div>
          <DropdownMenuSeparator />
          {(['bing', 'google', 'duckduckgo'] as const).map(value => <DropdownMenuItem key={value} onClick={() => void request('preferences', { search: value }).then(result => setSearchProvider(result.search)).catch(report)}>{searchProvider === value && <Check />}{({ bing: 'Bing 搜索', google: 'Google 搜索', duckduckgo: 'DuckDuckGo 搜索' })[value]}</DropdownMenuItem>)}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => sleeping ? setSleeping(false) : setSleepConfirm(true)}>{sleeping ? '恢复此网页' : '休眠此网页…'}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setClear('cache')}>清除浏览缓存</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setClear('all')}>清除全部站点数据…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    {findOpen && <form className="flex items-center gap-1 border-b p-2" onSubmit={event => { event.preventDefault(); void request('find', { text: findText, forward: true, findNext: true }).catch(report) }}>
      <Input aria-label="在网页中查找" autoFocus value={findText} onChange={event => { setFindText(event.target.value); void request('find', { text: event.target.value, findNext: false }).catch(report) }} />
      <span className="shrink-0 text-xs">{found.active}/{found.matches}</span>
      <Hint tip="上一处匹配" side="bottom"><Button type="button" variant="ghost" size="icon-sm" aria-label="上一处匹配" onClick={() => void request('find', { text: findText, forward: false, findNext: true }).catch(report)}><ArrowLeft /></Button></Hint>
      <Hint tip="下一处匹配" side="bottom"><Button type="submit" variant="ghost" size="icon-sm" aria-label="下一处匹配"><ArrowRight /></Button></Hint>
      <Hint tip="关闭网页查找" side="bottom"><Button type="button" variant="ghost" size="icon-sm" aria-label="关闭网页查找" onClick={() => { setFindOpen(false); void request('find', { text: '' }).catch(report) }}><X /></Button></Hint>
    </form>}
    {(error ?? state?.error) && <div role="alert" className="flex items-center gap-2 border-b p-2 text-sm text-destructive"><span className="min-w-0 flex-1 break-words">{error ?? state?.error}</span><Button variant="outline" size="sm" onClick={() => { setError(null); if (!ready) setAttempt(value => value + 1); else void request('reload', {}).catch(report) }}>重试</Button></div>}
    <div className="relative min-h-0 flex-1" data-browser-body>
      <div ref={host} className="h-full" style={{ backgroundColor: '#fff' }} data-browser-surface />
      {sleeping ? <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6"><p className="text-sm text-muted-foreground">网页已休眠</p><Button variant="outline" onClick={() => setSleeping(false)}>恢复网页</Button></div> : !state?.url && !state?.localFile && !state?.loading && !error && !state?.error && <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center bg-background p-6 text-center" data-browser-empty>
        <Globe className="mb-6 size-20 text-muted-foreground/50" strokeWidth={1.5} aria-hidden="true" />
        <h2 className="text-base font-medium">浏览器</h2>
        <p className="mt-3 text-sm text-muted-foreground">粘贴或输入 URL 以打开网页。</p>
      </div>}
    </div>

    <Dialog open={props.active && permissionsOpen} onOpenChange={open => { if (props.active) setPermissionsOpen(open) }}>
      <DialogContent className="max-h-[80vh] overflow-y-auto"><DialogHeader><DialogTitle>站点权限</DialogTitle><DialogDescription>修改权限将重新载入此站点页面，结束旧页面的采集与授权。</DialogDescription></DialogHeader>
        {!permissions.length && <p className="text-sm text-muted-foreground">此页面没有可配置的网站权限。</p>}
        {permissions.map(value => {
          const id = `${props.tabId}-${value.permission}-${value.mediaTypes?.join(',') ?? ''}`
          return <div key={id} className="flex items-center justify-between gap-2">
            <label className="text-sm" htmlFor={id}>{value.permission === 'media' ? value.mediaTypes?.includes('audio') ? '麦克风' : '摄像头' : PERMISSION_NAMES[value.permission] ?? value.permission}</label>
            <Select value={value.decision} items={PERMISSION_DECISIONS} onValueChange={decision => { if (decision !== null) void changePermission(value, decision) }}>
              <SelectTrigger id={id} size="sm"><SelectValue /></SelectTrigger>
              <SelectContent align="end" alignItemWithTrigger={false}>{PERMISSION_DECISIONS.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        })}
        <p className="text-xs text-muted-foreground">USB、蓝牙、串口与屏幕源选择暂未接通，相关请求会明确拒绝。</p>
      </DialogContent>
    </Dialog>
    <Dialog open={props.active && prompt !== null} onOpenChange={open => { if (!open && props.active) void replyPrompt(null) }}>
      <DialogContent><DialogHeader><DialogTitle>{prompt?.kind === 'authentication' ? '网站或代理身份验证' : prompt?.kind === 'alert' ? '网页提示' : prompt?.kind === 'confirm' ? '网页请求确认' : '网页请求输入'}</DialogTitle><DialogDescription className="whitespace-pre-wrap">{prompt?.message}</DialogDescription></DialogHeader><form onSubmit={event => { event.preventDefault(); void replyPrompt(prompt?.kind === 'authentication' ? JSON.stringify({ username: authUsername, password: authPassword }) : prompt?.kind === 'prompt' || prompt?.kind === undefined ? promptValue : 'accepted') }}>{prompt?.kind === 'authentication' ? <div className="grid gap-2"><Input autoFocus autoComplete="off" aria-label="身份验证用户名" placeholder="用户名" value={authUsername} onChange={event => setAuthUsername(event.target.value)} /><Input type="password" autoComplete="off" aria-label="身份验证密码" placeholder="密码" value={authPassword} onChange={event => setAuthPassword(event.target.value)} /></div> : (prompt?.kind === 'prompt' || prompt?.kind === undefined) && <Input autoFocus aria-label="网页输入内容" value={promptValue} onChange={event => setPromptValue(event.target.value)} />}<DialogFooter className="mt-3">{prompt?.kind !== 'alert' && <Button type="button" variant="outline" onClick={() => void replyPrompt(null)}>取消</Button>}<Button type="submit">确定</Button></DialogFooter></form></DialogContent>
    </Dialog>
    <Dialog open={props.active && clear !== null} onOpenChange={open => { if (!open && props.active) setClear(null) }}><DialogContent><DialogHeader><DialogTitle>{clear === 'all' ? '清除全部站点数据？' : '清除浏览缓存？'}</DialogTitle><DialogDescription>{clear === 'all' ? '将退出此浏览组中的网站登录，网页和用户文件不会删除。' : '只删除网页缓存，保留登录 Cookie 和站点数据。'}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setClear(null)}>取消</Button><Button onClick={() => void request('clearData', { all: clear === 'all' }).then(() => setClear(null)).catch(report)}>清除</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={props.active && sleepConfirm} onOpenChange={open => { if (props.active) setSleepConfirm(open) }}><DialogContent><DialogHeader><DialogTitle>休眠此网页？</DialogTitle><DialogDescription>休眠会释放网页实例，未保存的表单与正在进行的下载将丢失。标签和浏览历史仍保留，恢复时重新载入。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setSleepConfirm(false)}>取消</Button><Button onClick={() => void sleep()}>休眠</Button></DialogFooter></DialogContent></Dialog>
  </div>
}
