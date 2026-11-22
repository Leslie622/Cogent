/** 标签工作区仅驻留内存；启动时只删除旧版本遗留的专用数据库，不读取或续写标签。 */
export function clearLegacyWorkspaceCache(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('cogent-workspace')
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error('清理旧工作区缓存失败'))
    request.onblocked = () => reject(new Error('旧工作区缓存被另一个窗口占用，请关闭该窗口后重启'))
  })
}
