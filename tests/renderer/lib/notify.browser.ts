/** 真实 Electron 解码与输出时钟验收；驱动静音，设备实际可听结果另做手测。 */
import { playNotifySound } from '@/lib/notify'
import type { NotifySettings } from '@/stores/engine'

declare global {
  interface Window {
    notifySoundResult?: { passed: boolean; error?: string; starts?: number[]; durations?: number[] }
  }
}

const NativeContext = window.AudioContext
const contexts: AudioContext[] = []
const starts: number[] = []
const sources: AudioBufferSourceNode[] = []
const ended: Promise<void>[] = []

class ObservedContext extends NativeContext {
  constructor(options?: AudioContextOptions) {
    super(options)
    contexts.push(this)
  }
  override createBufferSource(): AudioBufferSourceNode {
    const source = super.createBufferSource()
    const start = source.start.bind(source)
    source.start = (when = 0) => { starts.push(when); start(when) }
    ended.push(new Promise<void>((resolve) => source.addEventListener('ended', () => resolve(), { once: true })))
    sources.push(source)
    return source
  }
}
window.AudioContext = ObservedContext

const settings: NotifySettings = {
  turnDoneNotify: 'always', approvalNotify: true, questionNotify: true,
  toastEnabled: false, soundEnabled: true, soundVolume: 0.5, soundPitch: 660,
  turnDoneSoundFile: null, approvalSoundFile: null, questionSoundFile: null
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

try {
  for (const kind of ['turn-done', 'approval', 'question'] as const) {
    await playNotifySound(settings, kind)
    await ended[ended.length - 1]
  }
  check(contexts.length === 1, '三类提示音必须共用一个输出上下文')
  check(starts[0] >= 0.6, '冷启动第一次播放必须预留输出唤醒时间')
  const durations = sources.map((source) => source.buffer!.duration)
  for (const [index, expected] of [0.28984, 0.32533, 0.25821].entries()) {
    check(Math.abs(durations[index] - expected) < 0.001, '音源解码时长不符')
  }

  // 真实挂起与恢复，验证已缓存音源也必须重新等待输出唤醒。
  const context = contexts[0]
  await context.suspend()
  const resumedAt = context.currentTime
  await playNotifySound(settings, 'turn-done')
  check(starts[3] >= resumedAt + 0.59, '输出恢复后缺少预热')
  await ended[3]
  await context.close()
  window.notifySoundResult = { passed: true, starts, durations }
} catch (error) {
  window.notifySoundResult = { passed: false, error: String(error), starts }
} finally {
  window.AudioContext = NativeContext
}
