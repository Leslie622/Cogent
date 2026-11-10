// ESLint 平面配置 —— 防御性代码治理的机械手段（政策条文见 docs/conventions.md）。
//
// 两类规则是这套治理的核心，都是类型感知规则（需要 tsconfig 项目信息）：
// - no-unnecessary-condition ：揪出"类型已保证却还在写的 if / typeof / ??"——
//   即政策里"边界内不设防"的噪音，机器直接报错，不靠人眼 review；
// - no-floating-promises    ：揪出被丢弃的 Promise——错误静默丢失的主要来源，
//   本工程大量异步边界（stdio / IPC / 引擎进程），这条是 fail-fast 纪律的守门员。
//
// recommendedTypeChecked 打底；随着代码量增长，只增这两类的同类规则，不堆语法风格规则。
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**', 'eslint.config.mjs'] },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // 复用现有两个 ts 工程（tsconfig.node.json / tsconfig.web.json）的类型信息
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      // Streamdown/react-markdown 的 components 覆盖经 ExtraProps 收到 hast node，
      // 解构丢弃是从 rest spread 里剥掉它的标准手法（不剥会变 DOM 未知属性）——
      // 与基础 eslint 的默认一致，放开 rest 兄弟忽略
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }]
    }
  }
)
