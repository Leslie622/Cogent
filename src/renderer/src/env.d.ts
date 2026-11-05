/// <reference types="vite/client" />
import type { CogentApi } from '../../preload/index'

declare global {
  interface Window {
    cogent: CogentApi
  }
}

export {}
