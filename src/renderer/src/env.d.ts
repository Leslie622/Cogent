/// <reference types="vite/client" />
import type { CogentApi } from '../../../electron/preload/index'

declare global {
  interface Window {
    cogent: CogentApi
  }
}

export {}
