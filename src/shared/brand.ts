/**
 * 构建期注入的应用品牌与存储目录名。
 *
 * 打包工具（packaging/build.mjs）通过 electron-vite define 注入当前项目组的
 * __COGENT_APP_NAME__ 与 __COGENT_STORAGE_DIR__；源码运行或单测未注入时回退默认
 * 值（'Cogent' / '.cogent'），保持开发态零配置可用。
 */

declare const __COGENT_APP_NAME__: string | undefined
declare const __COGENT_STORAGE_DIR__: string | undefined

const DEFAULT_APP_NAME = 'Cogent'
const DEFAULT_STORAGE_DIR_NAME = '.cogent'

/** 校验用户数据目录名：必须为单个安全目录名，禁止路径分隔符或 .. 穿越。 */
export function normalizeStorageDirName(raw: string | undefined): string {
  const trimmed = raw?.trim() ?? ''
  if (trimmed === '' || trimmed === '.' || trimmed === '..' || /[/\\]/.test(trimmed)) {
    return DEFAULT_STORAGE_DIR_NAME
  }
  return trimmed
}

/** 当前应用显示名（窗口标题、托盘、默认侧栏标题消费）。 */
export function getAppDisplayName(): string {
  const injected = typeof __COGENT_APP_NAME__ === 'string' ? __COGENT_APP_NAME__.trim() : ''
  return injected !== '' ? injected : DEFAULT_APP_NAME
}

/** 用户主目录下的默认存储文件夹名（未设置 COGENT_HOME 时生效）。 */
export function getStorageDirName(): string {
  const injected = typeof __COGENT_STORAGE_DIR__ === 'string' ? __COGENT_STORAGE_DIR__ : undefined
  return normalizeStorageDirName(injected)
}
