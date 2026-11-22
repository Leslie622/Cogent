/** 总览的行列提示交给 LikeC4 计算；保存官方布局快照，不维护 SVG 坐标或手写接线。 */
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(new URL('../docs/架构地图/package.json', import.meta.url))
const { LikeC4 } = await import(pathToFileURL(require.resolve('likec4')).href)
const instance = await LikeC4.fromWorkspace(fileURLToPath(new URL('../docs/架构地图/模型/', import.meta.url)), { logger: false, throwIfInvalid: true })
try {
  const view = (await instance.viewsService.computedViews()).find(view => view.id === 'overview')
  // 同列的顺序只用于排版；这些不可见约束不会成为模型关系或显示连线。
  const columns = [
    ['desktop', 'nativeClients', 'customClients', 'mcp'],
    ['access.stdio', 'access.network'],
    ['host.authentication', 'host.services', 'host.security', 'host.bundled'],
    ['host.native', 'host.adapter', 'host.capabilities'],
    ['host.policy', 'host.runtime'],
    ['host.api', 'host.kernel', 'host.alternative'],
  ]
  const horizontal = new Set([
    'access.stdio>host.native', 'access.network>host.authentication',
    'host.native>host.policy', 'host.policy>host.api',
    'host.services>host.runtime', 'host.runtime>host.kernel',
    'host.kernel>host.provider', 'host.provider>models',
  ])
  const result = await instance.viewsService.layoutView({
    viewId: 'overview',
    layoutHints: {
      ranks: columns.map(nodes => ({ rank: 'same', nodes })),
      edgeWeight: Object.fromEntries(view.edges.filter(edge => horizontal.has(`${edge.source}>${edge.target}`)).map(edge => [edge.id, 10000])),
      edgeMinlen: {},
      // 折返业务线和消费关系保留真实方向，但不让它们把执行层推到接入链右侧。
      excludeFromRanking: view.edges.filter(edge => edge.source === 'host.api' && edge.target === 'host.services' || edge.line === 'dotted').map(edge => edge.id),
      invisibleEdges: columns.slice(1).flatMap(nodes => nodes.slice(1).map((source, index) => ({ source, target: nodes[index], weight: 100 }))),
      reasoning: '上方接入、下方执行；列对齐，核心调用水平展开，HostApi 折返到服务层。',
    },
  })
  const saved = await instance.languageServices.editor.applyChange({
    viewId: 'overview', change: { op: 'save-view-snapshot', layout: result.diagram },
  })
  if (!saved.success) throw new Error(saved.error)
  const host = result.diagram.nodes.find(node => node.id === 'host')
  console.log(`LikeC4 总览布局：${result.diagram.bounds.width} × ${result.diagram.bounds.height}，Host 宽 ${host.width}`)
} finally {
  await instance.dispose()
}
