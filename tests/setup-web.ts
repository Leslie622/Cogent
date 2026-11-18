// web project 统一 setup：
// - jest-dom 匹配器（toBeInTheDocument / toHaveTextContent 等）挂到 vitest expect；
// - RTL 自动清理：官方 auto-cleanup 依赖全局 afterEach（vitest globals 模式），
//   本工程测试一律显式 import（无 globals）→ 在此集中挂一次，组件测试间 DOM 不串场。
// 不 mock window.cogent：桥接 stub 各测试文件自带（不同用例要不同的可编程 fake，
// 全局单例反而碍事）。
// jsdom 不实现 Web Animations；默认没有运行中过渡，具体收尾回归另注入可控 Animation。
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

Object.defineProperty(Element.prototype, 'getAnimations', {
  configurable: true,
  writable: true,
  value: () => []
})

// jsdom 不实现 Web Audio（lib/notify 的合成提示音用）：空转 stub 只求调用链
// 不炸 —— 音效不在单测断言范围（notify.test.ts 只钉纯函数行为），生产环境
// Electron renderer 恒有真 AudioContext
class AudioParamStub {
  value = 1
}
class AudioNodeStub {
  gain = new AudioParamStub()
  frequency = new AudioParamStub()
  connect = (): void => {}
  start = (): void => {}
  stop = (): void => {}
}
class AudioContextStub {
  state = 'running' as const
  currentTime = 0
  destination = new AudioNodeStub()
  createGain(): AudioNodeStub {
    return new AudioNodeStub()
  }
  createOscillator(): AudioNodeStub {
    return new AudioNodeStub()
  }
  resume(): Promise<void> {
    return Promise.resolve()
  }
}
globalThis.AudioContext = AudioContextStub as unknown as typeof AudioContext

afterEach(cleanup)
