// Vitest 单配置三 project（docs/计划-测试体系.md D4）：
// - node  ：引擎侧单元（agent-service / shared），node 环境，秒级；
// - web   ：渲染层单元 + 组件，jsdom（组件渲染需要 DOM；纯逻辑测试顺带同环境，
//           免再拆一份配置）；setup-web 挂 jest-dom 匹配器；
// - integration：tmp 冒烟正名迁移（mock SSE + 真构建产物 out/main/service.js），
//           各文件自带子进程与固定端口（18940–18942）→ 串行跑；全流程分钟级，
//           timeout 放宽；global-setup 守卫构建产物新鲜度（D5：`npm test`
//           一条命令即全绿，无需记得先 build）。
// alias 与 tsconfig paths 对齐（@ → renderer，@shared → shared）—— 运行时
// Vitest 不读 tsconfig paths，需在此声明同款。
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src/renderer/src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url))
    }
  },
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/agent-service/**/*.test.ts', 'src/shared/**/*.test.ts', 'src/electron/**/*.test.ts']
        }
      },
      {
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['src/renderer/**/*.test.{ts,tsx}'],
          setupFiles: ['tests/setup-web.ts']
        }
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          fileParallelism: false,
          testTimeout: 300_000,
          hookTimeout: 120_000,
          globalSetup: ['tests/integration/global-setup.ts']
        }
      }
    ]
  }
})
