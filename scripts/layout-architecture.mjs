/** 总览的行列提示交给 LikeC4 计算；保存官方布局快照，不维护 SVG 坐标或手写接线。 */
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(new URL('../docs/架构地图/package.json', import.meta.url))
const { LikeC4 } = await import(pathToFileURL(require.resolve('likec4')).href)
const instance = await LikeC4.fromWorkspace(fileURLToPath(new URL('../docs/架构地图/模型/', import.meta.url)), { logger: false, throwIfInvalid: true })
try {
  const views = await instance.viewsService.computedViews()
  const view = views.find(view => view.id === 'overview')
  // 同列的顺序只用于排版；这些不可见约束不会成为模型关系或显示连线。
  const columns = [
    ['desktop', 'nativeClients', 'customClients', 'mcp'],
    ['access.stdio', 'access.network'],
    ['host.authentication', 'host.capabilities', 'host.services'],
    ['host.native', 'host.adapter'],
    ['host.policy', 'host.runtime.kernel'],
    ['host.api', 'host.runtime.alternative'],
  ]
  const horizontal = new Set([
    'desktop>access.stdio',
    'customClients>access.network', 'access.stdio>host.native', 'access.network>host.authentication',
    'host.native>host.policy', 'host.policy>host.api',
    'host.services>host.runtime',
    'host.capabilities>host.runtime', 'host.runtime>host.provider', 'host.provider>models',
  ])
  const result = await instance.viewsService.layoutView({
    viewId: 'overview',
    layoutHints: {
      ranks: columns.map(nodes => ({ rank: 'same', nodes })),
      edgeWeight: Object.fromEntries(view.edges.filter(edge => horizontal.has(`${edge.source}>${edge.target}`)).map(edge => [edge.id, 10000])),
      edgeMinlen: {},
      // 服务与能力供给不参与主链排序；包含关系代替执行入口到具体内核的额外接线。
      excludeFromRanking: view.edges.filter(edge => edge.target === 'host.services' || edge.line === 'dotted').map(edge => edge.id),
      invisibleEdges: [
        ...columns.flatMap((nodes, column) => nodes.slice(1).map((source, index) => column < 2
          ? { source: nodes[index], target: source, weight: 100 }
          : { source, target: nodes[index], weight: 100 })),
        { source: 'host.runtime.kernel', target: 'host.runtime.alternative', weight: 10000 },
      ],
      reasoning: '传输入口拉开纵向空间，桌面、stdio 与原生入口直连，网络入口与认证直连；执行链在下，外部箭头只连接 KernelRunner 容器。',
    },
  })
  const saved = await instance.languageServices.editor.applyChange({
    viewId: 'overview', change: { op: 'save-view-snapshot', layout: result.diagram },
  })
  if (!saved.success) throw new Error(saved.error)
  const host = result.diagram.nodes.find(node => node.id === 'host')
  console.log(`LikeC4 总览布局：${result.diagram.bounds.width} × ${result.diagram.bounds.height}，Host 宽 ${host.width}`)
  // 详情与总览共用模型，只展开当前模块；无形连接让职责卡片排成两列。
  for (const [viewId, columns] of [
    ['services', [['host.services.sessions', 'host.services.projects', 'host.services.credentials'], ['host.services.observability', 'host.services.configuration']]],
    ['capabilities', [['host.capabilities.tools', 'host.capabilities.mcp', 'host.capabilities.skills'], ['host.capabilities.hooks', 'host.capabilities.interaction', 'host.capabilities.subagents']]],
  ]) {
    const layout = await instance.viewsService.layoutView({ viewId, layoutHints: {
      ranks: columns.map(nodes => ({ rank: 'same', nodes })), edgeWeight: {}, edgeMinlen: {},
      invisibleEdges: [
        ...columns.flatMap(nodes => nodes.slice(1).map((source, index) => ({ source, target: nodes[index], weight: 100 }))),
        { source: columns[0][0], target: columns[1][0], weight: 10000 },
      ],
      reasoning: '在同一模块边界内用两列卡片展开职责，保留与相邻模块的实际连接。',
    } })
    const saved = await instance.languageServices.editor.applyChange({ viewId, change: { op: 'save-view-snapshot', layout: layout.diagram } })
    if (!saved.success) throw new Error(saved.error)
    console.log(`LikeC4 ${viewId} 详情：${layout.diagram.nodes.length} 个节点，${layout.diagram.edges.length} 条关系`)
  }
} finally {
  await instance.dispose()
}
