/**
 * 提醒判定与播放器行为契约：
 * - shouldNotify：三行触发条件 × 焦点；呈现开关（toast/声音）不在此层（正交）
 * - 三类内置音、自定义覆盖、冷启动预热、输出恢复、加载并发与失败可重试。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shouldNotify } from '@/lib/notify'
import type { NotifySettings } from '@/stores/engine'

const settings = (patch: Partial<NotifySettings> = {}): NotifySettings => ({
  turnDoneNotify: 'unfocused',
  approvalNotify: true,
  questionNotify: true,
  toastEnabled: false,
  soundEnabled: true,
  soundVolume: 0.5,
  soundPitch: 660,
  turnDoneSoundFile: null,
  approvalSoundFile: null,
  questionSoundFile: null,
  ...patch
})

describe('shouldNotify · 轮次完成三档', () => {
  it('unfocused（缺省）：聚焦不提醒、失焦提醒', () => {
    expect(shouldNotify('turn-done', settings(), true)).toBe(false)
    expect(shouldNotify('turn-done', settings(), false)).toBe(true)
  })
  it('always：聚焦也提醒；never：永不提醒', () => {
    expect(shouldNotify('turn-done', settings({ turnDoneNotify: 'always' }), true)).toBe(true)
    expect(shouldNotify('turn-done', settings({ turnDoneNotify: 'always' }), false)).toBe(true)
    expect(shouldNotify('turn-done', settings({ turnDoneNotify: 'never' }), true)).toBe(false)
    expect(shouldNotify('turn-done', settings({ turnDoneNotify: 'never' }), false)).toBe(false)
  })
})

describe('shouldNotify · 权限/问答开关（与焦点无关）', () => {
  it('开则提醒（聚焦与否都提醒 —— 阻塞态催办优先于打扰规避）', () => {
    expect(shouldNotify('approval', settings(), true)).toBe(true)
    expect(shouldNotify('question', settings(), false)).toBe(true)
  })
  it('关则不提醒', () => {
    expect(shouldNotify('approval', settings({ approvalNotify: false }), true)).toBe(false)
    expect(shouldNotify('question', settings({ questionNotify: false }), false)).toBe(false)
  })
})

class SourceFake {
  buffer: AudioBuffer | null = null
  playbackRate = { value: 1 }
  connect = vi.fn()
  disconnect = vi.fn()
  start = vi.fn()
  stop = vi.fn()
  onended: (() => void) | null = null
}

class ContextFake {
  static instances: ContextFake[] = []
  state: AudioContextState = 'running'
  currentTime = 0
  destination = {}
  sources: SourceFake[] = []
  gains: Array<{ gain: { value: number }; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = []
  resume = vi.fn(() => { this.state = 'running'; return Promise.resolve() })
  decodeAudioData = vi.fn(() => Promise.resolve({ duration: 0.29 } as AudioBuffer))
  createBufferSource() {
    const source = new SourceFake()
    this.sources.push(source)
    return source
  }
  createGain() {
    const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }
    this.gains.push(gain)
    return gain
  }
  constructor() { ContextFake.instances.push(this) }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('playNotifySound · 输出预热与音源缓存', () => {
  let playNotifySound: typeof import('@/lib/notify')['playNotifySound']
  const fetchSound = vi.fn()
  beforeEach(async () => {
    vi.resetModules()
    ContextFake.instances.length = 0
    fetchSound.mockReset().mockImplementation(() => Promise.resolve(new Response(new ArrayBuffer(4))))
    vi.stubGlobal('AudioContext', ContextFake)
    vi.stubGlobal('fetch', fetchSound)
    ;({ playNotifySound } = await import('@/lib/notify'))
  })
  afterEach(() => vi.unstubAllGlobals())

  it.each(['turn-done', 'approval', 'question'] as const)('%s 第一次点击即加载并安排完整原音，预留600ms输出唤醒', async (kind) => {
    await playNotifySound(settings(), kind)
    const context = ContextFake.instances[0]
    expect(fetchSound).toHaveBeenCalledWith(expect.stringContaining(`/sounds/${kind}.wav`))
    expect(context.sources[0].playbackRate.value).toBe(1)
    expect(context.gains[0].gain.value).toBe(0.5)
    expect(context.sources[0].start).toHaveBeenCalledExactlyOnceWith(0.6)
  })

  it('已就绪的输出直接重播，复用已解码数据并读取当前音量和音调', async () => {
    await playNotifySound(settings(), 'turn-done')
    const context = ContextFake.instances[0]
    context.currentTime = 2
    await playNotifySound(settings({ soundVolume: 0.2, soundPitch: 990 }), 'turn-done')
    expect(fetchSound).toHaveBeenCalledTimes(1)
    expect(context.decodeAudioData).toHaveBeenCalledTimes(1)
    expect(context.sources[0].stop).toHaveBeenCalledTimes(1)
    expect(context.sources[1].buffer).toBe(context.sources[0].buffer)
    expect(context.sources[1].start).toHaveBeenCalledExactlyOnceWith(2)
    expect(context.sources[1].playbackRate.value).toBe(1.5)
    expect(context.gains[1].gain.value).toBe(0.2)
  })

  it('自定义文件优先且保持原音高，清除字段后回到对应内置音', async () => {
    const file = 'approval-自选 提示音.wav'
    await playNotifySound(settings({ approvalSoundFile: file, soundPitch: 990 }), 'approval')
    const context = ContextFake.instances[0]
    expect(fetchSound).toHaveBeenLastCalledWith(`cogent-sound://local/${encodeURIComponent(file)}`)
    expect(context.sources[0].playbackRate.value).toBe(1)
    await playNotifySound(settings(), 'approval')
    expect(fetchSound).toHaveBeenLastCalledWith(expect.stringContaining('/sounds/approval.wav'))
  })

  it('首次加载期间连续点击合并最新请求，不提前播空或重新计算预热时刻', async () => {
    const loaded = deferred<Response>()
    fetchSound.mockReturnValueOnce(loaded.promise)
    const first = playNotifySound(settings(), 'question')
    const context = ContextFake.instances[0]
    context.currentTime = 0.1
    const second = playNotifySound(settings({ soundVolume: 0.25 }), 'question')
    expect(context.sources).toHaveLength(0)
    loaded.resolve(new Response(new ArrayBuffer(4)))
    await Promise.all([first, second])
    expect(context.sources).toHaveLength(1)
    expect(context.sources[0].start).toHaveBeenCalledExactlyOnceWith(0.6)
    expect(context.gains[0].gain.value).toBe(0.25)
  })

  it('输出挂起后同步发起resume，恢复完成前不播放，恢复后重新预热', async () => {
    await playNotifySound(settings(), 'turn-done')
    const context = ContextFake.instances[0]
    context.currentTime = 10
    context.state = 'suspended'
    const resumed = deferred<void>()
    context.resume.mockImplementationOnce(() => resumed.promise.then(() => { context.state = 'running' }))
    const playback = playNotifySound(settings(), 'turn-done')
    expect(context.resume).toHaveBeenCalledTimes(1)
    expect(context.sources).toHaveLength(1)
    resumed.resolve()
    await playback
    expect(context.sources[1].start).toHaveBeenCalledExactlyOnceWith(10.6)
  })

  it('加载失败向调用方报告，下一次用户点击重新加载', async () => {
    fetchSound.mockRejectedValueOnce(new Error('offline'))
    await expect(playNotifySound(settings(), 'question')).rejects.toThrow('offline')
    await playNotifySound(settings(), 'question')
    expect(fetchSound).toHaveBeenCalledTimes(2)
    expect(ContextFake.instances[0].sources).toHaveLength(1)
  })

  it('解码失败不缓存假成功，重试能重新解码', async () => {
    const first = playNotifySound(settings(), 'question')
    const context = ContextFake.instances[0]
    context.decodeAudioData.mockRejectedValueOnce(new Error('坏音频'))
    await expect(first).rejects.toThrow('坏音频')
    expect(context.sources).toHaveLength(0)
    await playNotifySound(settings(), 'question')
    expect(context.decodeAudioData).toHaveBeenCalledTimes(2)
    expect(context.sources).toHaveLength(1)
  })

  it('旧音源加载晚到时不会覆盖已经播放的新音源', async () => {
    const old = deferred<Response>()
    fetchSound.mockReturnValueOnce(old.promise)
    const first = playNotifySound(settings({ approvalSoundFile: 'old.wav' }), 'approval')
    await playNotifySound(settings({ approvalSoundFile: 'new.wav' }), 'approval')
    old.resolve(new Response(new ArrayBuffer(4)))
    await first
    const context = ContextFake.instances[0]
    expect(context.sources).toHaveLength(1)
    expect(context.sources[0].stop).not.toHaveBeenCalled()
  })
})
