/** 文档布局适配在 Node 中验证，不启动 Vite 页面或 Electron。 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['tests/**/*.test.ts'] },
})
