import type { CogentApi } from '../../../preload/index'

/** renderer 访问主进程的唯一入口（preload 暴露的窄接口） */
export const cogent: CogentApi = window.cogent
