/** 失焦保存与测试点击的交接：定义和 Key 都落定才可探测，保存失败不能改测旧值。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useEngineStore } from '@/stores/engine'

const previous = window.cogent
const request = vi.fn<(method: string, params: unknown) => Promise<unknown>>()
const setProviders = vi.fn()
const setKey = vi.fn()
const providerId = 'custom/probe'
function deferred() {
  let resolve!: (value: { ok: true }) => void
  const promise = new Promise<{ ok: true }>((finish) => { resolve = finish })
  return { promise, resolve }
}
beforeEach(async () => {
  request.mockReset().mockImplementation((method: string) => Promise.resolve(method === 'models.list' ? { models: [] } : { elapsedMs: 1 }))
  setProviders.mockReset().mockResolvedValue({ ok: true })
  setKey.mockReset().mockResolvedValue({ ok: true })
  window.cogent = { ...previous, engineRequest: request, setCustomProviders: setProviders, setApiKey: setKey,
    listApiKeys: vi.fn().mockResolvedValue([]) } as typeof window.cogent
  await useEngineStore.getState().saveProviders([], [])
  await useEngineStore.getState().saveApiKey(providerId, 'old-key')
  request.mockClear()
})
afterEach(() => { window.cogent = previous })

it('等待定义与本供应商 Key 同步完成后才发送测试', async () => {
  const definition = deferred()
  const credential = deferred()
  setProviders.mockReturnValueOnce(definition.promise)
  setKey.mockReturnValueOnce(credential.promise)
  const state = useEngineStore.getState()
  const savedProviders = state.saveProviders([], [])
  const savedKey = state.saveApiKey(providerId, 'new-key')
  const tested = state.testModel(providerId, 'probe')
  await Promise.resolve()
  expect(request).not.toHaveBeenCalled()
  definition.resolve({ ok: true })
  await savedProviders
  expect(request.mock.calls.map(([method]) => method)).toEqual(['models.list'])
  credential.resolve({ ok: true })
  await savedKey
  await tested
  expect(request).toHaveBeenLastCalledWith('models.test', { providerId, modelId: 'probe' })
})

it('保存失败阻止旧配置探测，重新保存后恢复', async () => {
  setProviders.mockRejectedValueOnce(new Error('写入失败'))
  const state = useEngineStore.getState()
  await expect(state.saveProviders([], [])).rejects.toThrow('写入失败')
  await expect(state.testModel(providerId, 'probe')).rejects.toThrow('写入失败')
  expect(request).not.toHaveBeenCalled()
  await state.saveProviders([], [])
  await expect(state.testModel(providerId, 'probe')).resolves.toEqual({ elapsedMs: 1 })
})
