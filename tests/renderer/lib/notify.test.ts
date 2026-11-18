/**
 * notify 纯函数单元测试 —— 提醒判定与合成音型的行为契约（钉行为不是追数字）：
 * - shouldNotify：三行触发条件 × 焦点；呈现开关（toast/声音）不在此层（正交）
 * - synthNotes：三类音型是基频的相对模式（音调滑杆一处调全变）
 */
import { describe, expect, it } from 'vitest'
import { shouldNotify, synthNotes } from '@/lib/notify'
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

describe('synthNotes · 三类音型是基频的相对模式', () => {
  it('turn-done 双音上行（第二音 = 基频 × 1.25，晚于第一音）', () => {
    const notes = synthNotes('turn-done', 660)
    expect(notes).toHaveLength(2)
    expect(notes[0].freq).toBe(660)
    expect(notes[1].freq).toBeCloseTo(660 * 1.25)
    expect(notes[1].at).toBeGreaterThan(notes[0].at)
  })
  it('approval 同音两响（频率相同、时间分离）', () => {
    const notes = synthNotes('approval', 660)
    expect(notes).toHaveLength(2)
    expect(notes[0].freq).toBe(notes[1].freq)
    expect(notes[1].at).toBeGreaterThan(notes[0].at)
  })
  it('question 双音（首音 = 基频 × 0.8，回到基频）', () => {
    const notes = synthNotes('question', 660)
    expect(notes).toHaveLength(2)
    expect(notes[0].freq).toBeCloseTo(660 * 0.8)
    expect(notes[1].freq).toBe(660)
  })
  it('音调调整全音型随动（相对模式，不是固定频率表）', () => {
    const low = synthNotes('turn-done', 440)
    const high = synthNotes('turn-done', 880)
    expect(high[0].freq / low[0].freq).toBeCloseTo(2)
    expect(high[1].freq / low[1].freq).toBeCloseTo(2)
  })
})
