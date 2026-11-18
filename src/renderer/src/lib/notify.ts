/**
 * 提醒分发与提示音（设置「通知」分区的 renderer 消费端）。
 *
 * 分层：chat 事件流到达 → notifyEvent(kind)：
 *   ① 触发条件判定（shouldNotify 纯函数：三行设置 × 焦点）—— 不过即什么都不做
 *   ② 呈现方式正交分发：toastEnabled → notify:toast IPC（main 弹，点击聚焦）；
 *      soundEnabled → playNotifySound（自定义文件 or 合成音）
 * 焦点判定单一源 = document.hasFocus()（事件消费在 renderer；toast 的
 * 「仅未聚焦」同源，避免 main/renderer 两处判焦不一致）。
 *
 * 合成音：AudioContext + oscillator（零资源、无加载延迟、三平台一致）；
 * 三类音型是基频的相对模式（调 soundPitch 一处全变）。自定义文件：
 * HTMLAudioElement 走 cogent-sound:// 协议（main 代理读 ~/.cogent/sounds/，
 * dev 的 http://localhost 不能直读 file://），复用实例播前 currentTime=0
 * 重置（zcode taskNotificationSound.ts:33-38：停在结束态的实例再播是静默）。
 */
import type { NotifyKind, NotifySettings } from '@/stores/engine'
import type { NotifyToastPayload } from '@/env.d'

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

/** 合成音音符表（纯函数，单测钉音型）：freq 相对基频取值，at/duration 毫秒 */
export function synthNotes(kind: NotifyKind, pitch: number): Array<{ freq: number; at: number; duration: number }> {
  if (kind === 'turn-done') {
    // 双音上行（叮-咚）：完成的"收尾感"
    return [
      { freq: pitch, at: 0, duration: 90 },
      { freq: pitch * 1.25, at: 110, duration: 140 }
    ]
  }
  if (kind === 'approval') {
    // 同音两响（急促）：阻塞态，催一下
    return [
      { freq: pitch, at: 0, duration: 120 },
      { freq: pitch, at: 160, duration: 120 }
    ]
  }
  // 双音平行回落（问-等）：等待回答的"疑问感"
  return [
    { freq: pitch * 0.8, at: 0, duration: 90 },
    { freq: pitch, at: 110, duration: 140 }
  ]
}

let audioContext: AudioContext | null = null

/** 自定义文件的 Audio 实例缓存（src → element；同 src 复用避免重建解码） */
const fileAudioCache = new Map<string, HTMLAudioElement>()

function playSynth(n: NotifySettings, kind: NotifyKind): void {
  audioContext ??= new AudioContext()
  // resume：suspended 态（浏览器策略/系统节能）下 scheduled 的音不响
  if (audioContext.state === 'suspended') void audioContext.resume()
  const gain = audioContext.createGain()
  gain.gain.value = n.soundVolume
  gain.connect(audioContext.destination)
  const now = audioContext.currentTime
  for (const note of synthNotes(kind, n.soundPitch)) {
    const osc = audioContext.createOscillator()
    osc.frequency.value = note.freq
    osc.connect(gain)
    osc.start(now + note.at / 1000)
    osc.stop(now + (note.at + note.duration) / 1000)
  }
}

function playFile(n: NotifySettings, file: string): void {
  // 文件名走 pathname 段并显式编码（中文等非 ASCII 过 URL 会被百分号编码，
  // main 侧对称解码；hostname 段固定占位 —— hostname 会被强制小写）
  const src = `cogent-sound://local/${encodeURIComponent(file)}`
  let audio = fileAudioCache.get(src)
  if (audio === undefined) {
    audio = new Audio(src)
    audio.preload = 'auto'
    fileAudioCache.set(src, audio)
  }
  audio.volume = n.soundVolume
  // 停在上次结束态的实例再 play 是静默，重置到头部
  audio.currentTime = 0
  void audio.play()
}

/**
 * 播放提示音（导出供设置页「试听」复用）：自定义文件优先，缺省走合成。
 * 播放失败（文件损坏/解码失败）静默 —— 提醒是增强体验，不炸主链路
 * （外部边界；zcode 同款口径）
 */
export function playNotifySound(n: NotifySettings, kind: NotifyKind): void {
  const file =
    kind === 'turn-done' ? n.turnDoneSoundFile : kind === 'approval' ? n.approvalSoundFile : n.questionSoundFile
  if (file !== null) playFile(n, file)
  else playSynth(n, kind)
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
  if (n.soundEnabled) playNotifySound(n, kind)
}
