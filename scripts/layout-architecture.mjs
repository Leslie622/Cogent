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
    ['host.authentication'],
    ['host.native', 'host.adapter'],
    ['host.policy'],
    ['host.api'],
    ['host.services'],
  ]
  const horizontal = new Set([
    'desktop>access.stdio',
    'customClients>access.network', 'access.stdio>host.native', 'access.network>host.authentication',
    'host.native>host.policy', 'host.policy>host.api',
    'host.api>host.services', 'host.services>host.runtime',
    'host.runtime>host.provider', 'host.provider>models',
  ])
  const result = await instance.viewsService.layoutView({
    viewId: 'overview',
    layoutHints: {
      ranks: columns.map(nodes => ({ rank: 'same', nodes })),
      edgeWeight: Object.fromEntries(view.edges.filter(edge => horizontal.has(`${edge.source}>${edge.target}`)).map(edge => [edge.id, 10000])),
      edgeMinlen: {},
      // 执行容器内部由显示投影紧凑排列；全局层距不再撑开三张卡。
      excludeFromRanking: view.edges.filter(edge => edge.source === 'host.runtime.capabilities' || edge.line === 'dotted').map(edge => edge.id),
      invisibleEdges: [
        ...columns.flatMap((nodes, column) => nodes.slice(1).map((source, index) => column < 2
          ? { source: nodes[index], target: source, weight: 100 }
          : { source, target: nodes[index], weight: 100 })),
      ],
      reasoning: '三个阶段沿主线依次展开；API 紧接服务，Runner 内部由局部投影紧凑排卡并与服务层居中连接。',
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
    ['capabilities', [['host.runtime.capabilities.tools', 'host.runtime.capabilities.mcp', 'host.runtime.capabilities.skills'], ['host.runtime.capabilities.hooks', 'host.runtime.capabilities.interaction', 'host.runtime.capabilities.subagents']]],
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
