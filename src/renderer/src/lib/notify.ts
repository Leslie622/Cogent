/**
 * 提醒分发与提示音（设置「通知」分区的 renderer 消费端）。
 *
 * 分层：chat 事件流到达 → notifyEvent(kind)：
 *   ① 触发条件判定（shouldNotify 纯函数：三行设置 × 焦点）—— 不过即什么都不做
 *   ② 呈现方式正交分发：toastEnabled → notify:toast IPC（main 弹，点击聚焦）；
 *      soundEnabled → playNotifySound（自定义文件或内置提示音）
 * 焦点判定单一源 = document.hasFocus()（事件消费在 renderer；toast 的
 * 「仅未聚焦」同源，避免 main/renderer 两处判焦不一致）。
 *
 * 内置音通过 Vite 资源导入随应用分发，不依赖用户数据目录；素材与授权见
 * docs/技术笔记/通知与提醒.md。自定义文件走 cogent-sound:// 协议，由 main
 * 代理读 ~/.cogent/sounds/（开发页面不能直读 file://）。两类音源共用
 * AudioContext 与已解码缓冲，首次输出预留唤醒时间，避免短音先于蓝牙输出播完。
 */
import turnDoneSoundUrl from '@/assets/sounds/turn-done.wav?url'
import approvalSoundUrl from '@/assets/sounds/approval.wav?url'
import questionSoundUrl from '@/assets/sounds/question.wav?url'
import { NOTIFY_SOUND_DEFAULTS, type NotifyKind, type NotifySettings } from '@/stores/engine'
import type { NotifyToastPayload } from '@/env.d'

const DEFAULT_SOUND_URLS: Record<NotifyKind, string> = {
  'turn-done': turnDoneSoundUrl,
  approval: approvalSoundUrl,
  question: questionSoundUrl
}

/** 三类事件的 toast 文案（应用无 i18n，全中文 UI） */
const TOAST_TEXT: Record<NotifyKind, NotifyToastPayload> = {
  'turn-done': { title: '轮次完成', body: 'Agent 已完成本轮工作' },
  approval: { title: '等待授权', body: 'Agent 需要你的授权才能继续' },
  question: { title: '等待回答', body: 'Agent 在等你回答问题' }
}

/**
 * 触发条件判定（纯函数，单测钉行为）：只看三行「何时提醒」设置 + 焦点；
 * 呈现方式（toast/声音开关）不在此层 —— 正交，各自分发时判。
 */
export function shouldNotify(kind: NotifyKind, n: NotifySettings, focused: boolean): boolean {
  if (kind === 'turn-done') {
    if (n.turnDoneNotify === 'never') return false
    // unfocused：盯着屏幕时不需要提醒（聚焦 = 不提醒）
    if (n.turnDoneNotify === 'unfocused' && focused) return false
    return true
  }
  if (kind === 'approval') return n.approvalNotify
  return n.questionNotify
}

// 短音只有约0.3秒；新建或恢复输出后先渲染600ms静音，再提交实际声音。
// 同一输出的后续播放不重复等待；设备最终可听状态仍以真实耳机验证为准。
const OUTPUT_WARMUP_SECONDS = 0.6
let audioContext: AudioContext | null = null
let outputReadyAt = 0
let resumePromise: Promise<void> | null = null
const bufferCache = new Map<string, Promise<AudioBuffer>>()
const activeSources = new Map<NotifyKind, AudioBufferSourceNode>()
const requests = new Map<NotifyKind, object>()

function getAudioContext(): AudioContext {
  if (audioContext === null) {
    audioContext = new AudioContext({ latencyHint: 'interactive' })
    outputReadyAt = audioContext.currentTime + OUTPUT_WARMUP_SECONDS
  }
  return audioContext
}

function resumeOutput(context: AudioContext): Promise<void> {
  if (context.state === 'running') return Promise.resolve()
  // resume 必须在点击的同步调用栈发起；加载音源放在它之后，保留用户激活。
  if (resumePromise === null) {
    resumePromise = context.resume().then(() => {
      outputReadyAt = context.currentTime + OUTPUT_WARMUP_SECONDS
    }).finally(() => {
      resumePromise = null
    })
  }
  return resumePromise
}

function loadBuffer(context: AudioContext, src: string): Promise<AudioBuffer> {
  let pending = bufferCache.get(src)
  if (pending === undefined) {
    pending = fetch(src).then(async (response) => {
      if (!response.ok) throw new Error(`提示音加载失败（HTTP ${response.status}）`)
      return context.decodeAudioData(await response.arrayBuffer())
    }).catch((error: unknown) => {
      // 网络、文件与解码是外部边界；失败不永久污染缓存，下一次用户操作可重新加载。
      bufferCache.delete(src)
      throw error
    })
    bufferCache.set(src, pending)
  }
  return pending
}

/**
 * 播放提示音（导出供设置页「试听」复用）：自定义文件优先，缺省播放内置音。
 * 加载、解码或输出恢复失败交给调用边界：试听显示原因，事件提醒只记诊断。
 */
export async function playNotifySound(n: NotifySettings, kind: NotifyKind): Promise<void> {
  const file =
    kind === 'turn-done' ? n.turnDoneSoundFile : kind === 'approval' ? n.approvalSoundFile : n.questionSoundFile
  // 自定义文件名显式编码；内置资源由 Vite 生成开发与构建环境各自可用的 URL。
  const src = file === null ? DEFAULT_SOUND_URLS[kind] : `cogent-sound://local/${encodeURIComponent(file)}`
  const request = {}
  requests.set(kind, request)
  const context = getAudioContext()
  const ready = resumeOutput(context)
  const [buffer] = await Promise.all([loadBuffer(context, src), ready])
  // 同一类连续点击只兑现最新请求；旧加载晚到时不能打断新试听。
  if (requests.get(kind) !== request) return

  const previous = activeSources.get(kind)
  if (previous !== undefined) previous.stop()
  const source = context.createBufferSource()
  const gain = context.createGain()
  source.buffer = buffer
  source.playbackRate.value = file === null ? n.soundPitch / NOTIFY_SOUND_DEFAULTS.soundPitch : 1
  gain.gain.value = n.soundVolume
  source.connect(gain)
  gain.connect(context.destination)
  source.onended = () => {
    source.disconnect()
    gain.disconnect()
    if (activeSources.get(kind) === source) activeSources.delete(kind)
  }
  // 共享就绪时刻：预热期间反复点击不会不断后移声音，也不会绕过预热。
  source.start(Math.max(context.currentTime, outputReadyAt))
  activeSources.set(kind, source)
}

/**
 * 提醒入口（chat 事件流调用）：条件过 → 按两个呈现开关正交分发。
 * 文案集中在 TOAST_TEXT（main 无语言上下文，学 zcode 由 renderer 生成）；
 * turn-done 的 failed 变体换失败文案（aborted 不走这里 —— 用户自己停的，
 * 不需要被提醒）。
 */
export function notifyEvent(kind: NotifyKind, n: NotifySettings, failed = false): void {
  if (!shouldNotify(kind, n, document.hasFocus())) return
  if (n.toastEnabled) {
    const text =
      kind === 'turn-done' && failed ? { title: '轮次失败', body: 'Agent 本轮运行失败，回来看看' } : TOAST_TEXT[kind]
    void window.cogent.notifyToast(text)
  }
  if (n.soundEnabled) {
    void playNotifySound(n, kind).catch((error: unknown) => {
      console.warn('[notify] 提示音播放失败', error)
    })
  }
}
