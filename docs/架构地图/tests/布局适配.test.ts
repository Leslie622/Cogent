/** 目标架构的接线、状态与布局回归；不以图已绘制代替后端实现。 */
import { fileURLToPath } from 'node:url'
import { LikeC4 } from 'likec4'
import type { LayoutedView } from 'likec4/model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { projectLayout } from '../src/布局适配'
import { moduleDetails } from '../src/模块说明'
import { viewIds, type ViewId } from '../src/视图'

let instance: LikeC4
let views: Record<ViewId, LayoutedView>

beforeAll(async () => {
  instance = await LikeC4.fromWorkspace(fileURLToPath(new URL('../模型/', import.meta.url)), { logger: false, throwIfInvalid: true })
  const model = await instance.layoutedModel()
  views = Object.fromEntries(viewIds.map(id => [id, model.view(id).$layouted])) as Record<ViewId, LayoutedView>
})
afterAll(async () => { await instance.dispose() })

describe('目标架构的语义与完成度', () => {
  it('关系进度独立于端点，折叠网络入口后仍保留目标标记', () => {
    for (const viewId of ['overview', 'ingress'] as const) {
      const { edges } = projectLayout(views[viewId])
      const planned = (source: string, target: string) => edges.find(edge => edge.source === source && edge.target === target)!.data!.planned
      expect(moduleDetails['host.native'].status).toBe('implemented')
      expect(moduleDetails['host.policy'].status).toBe('partial')
      expect(planned('host.native', 'host.policy')).toBe(true)
      expect(planned('host.policy', 'host.api')).toBe(false)
      const destination = viewId === 'overview' ? 'access.network' : 'access.network.http'
      expect(planned('customClients', destination)).toBe(true)
      expect(planned('nativeClients', destination)).toBe(false)
    }
  })

  it('传输入口纵向展开，桌面、stdio 与原生入口直连，网络接线保持水平', () => {
    const { nodeBounds } = projectLayout(views.overview)
    const find = (id: string) => nodeBounds.get(id)!
    expect(find('desktop').y).toBe(find('access.stdio').y)
    expect(find('access.stdio').y).toBe(find('host.native').y)
    expect(find('customClients').y).toBe(find('access.network').y)
    expect(find('access.network').y).toBe(find('host.authentication').y)
    const { edges } = projectLayout(views.overview)
    for (const [source, target] of [['desktop', 'access.stdio'], ['access.stdio', 'host.native'], ['customClients', 'access.network'], ['access.network', 'host.authentication']]) {
      const route = edges.find(edge => edge.source === source && edge.target === target)!.data!.route
      expect(route.every(point => point.y === route[0].y), `${source} → ${target} 应直接水平连接`).toBe(true)
    }
    // 回归钉死：行对齐曾把三张场景卡挤到只剩 2~12px 间隙；原生调用放回两行正中，间隙相等且留得出来。
    const [desktop, native, custom] = ['desktop', 'nativeClients', 'customClients'].map(find)
    const gaps = [native.y - desktop.y - desktop.height, custom.y - native.y - native.height]
    expect(gaps[1]).toBe(gaps[0])
    expect(gaps[0]).toBeGreaterThanOrEqual(40)
  })

  it('点线从两个容器底边以下绕行，MCP 行贴着通道下方', () => {
    const { edges, nodeBounds } = projectLayout(views.overview)
    const bottom = (id: string) => { const box = nodeBounds.get(id)!; return box.y + box.height }
    const dotted = edges.find(edge => edge.data!.line === 'dotted')!
    const channel = dotted.data!.route[1].y
    // 回归钉死：通道曾落在两个容器底边之间，点线看着像插进区块；线与底边之间还要放得下标签。
    for (const id of ['access', 'host']) expect(channel - bottom(id), `${id} 底边到点线应留出净空`).toBeGreaterThanOrEqual(40)
    expect(bottom('host')).toBe(bottom('access'))
    expect(nodeBounds.get('mcp')!.y).toBeGreaterThan(channel)
    expect(nodeBounds.get('externalAgent')!.y).toBe(nodeBounds.get('mcp')!.y)
  })

  it('Host 用阶段标题标出各阶段的卡片范围', () => {
    const graph = projectLayout(views.overview)
    const host = graph.nodes.find(node => node.id === 'host')!
    expect(host.data.stages.map(stage => stage.label)).toEqual(['接入与协议', '业务分发', '内核执行', '模型出口'])
    const frame = graph.nodeBounds.get('host')!
    for (const [index, stage] of host.data.stages.entries()) {
      const members = moduleDetails.host.stages![index].nodes.map(id => graph.nodeBounds.get(id)!)
      expect(stage.x).toBe(Math.min(...members.map(member => member.x)) - frame.x)
      expect(stage.x + stage.width).toBe(Math.max(...members.map(member => member.x + member.width)) - frame.x)
    }
    expect(graph.nodes.filter(node => node.data.stages.length > 0).map(node => node.id)).toEqual(['host'])
  })

  it('总览聚合网络接线，外部 Agent 经过 MCP 转换，细图保留 HTTP 与 WS', () => {
    const overview = views.overview
    for (const source of ['nativeClients', 'customClients', 'mcp']) {
      expect(overview.edges.filter(edge => edge.source === source && edge.line !== 'dotted').map(edge => edge.target)).toEqual(['access.network'])
    }
    expect(overview.edges.filter(edge => edge.source === 'access.network').map(edge => edge.target)).toEqual(['host.authentication'])
    expect(overview.nodes.map(node => node.id)).not.toContain('access.network.http')
    expect(views.ingress.nodes.map(node => node.id)).toContain('access.network.http')
    expect(views.ingress.nodes.map(node => node.id)).toContain('access.network.ws')
    expect(moduleDetails['access.network'].navigateTo).toBe('ingress')
    expect(overview.nodes.map(node => node.id)).not.toContain('scripts')
    expect(overview.nodes.map(node => node.id)).not.toContain('host.custom')
    expect(overview.edges.filter(edge => edge.source === 'externalAgent').map(edge => edge.target)).toEqual(['mcp'])
    expect(viewIds).toEqual(['overview', 'ingress', 'execution', 'services', 'capabilities'])
    const projected = projectLayout(overview).edges
    expect(projected.find(edge => edge.source === 'desktop' && edge.target === 'access.stdio')!.data!.line).toBe('solid')
    expect(projected.find(edge => edge.source === 'host.authentication' && edge.target === 'host.adapter')!.data!.line).toBe('solid')
    const dependency = projected.find(edge => edge.source === 'customClients' && edge.target === 'host.adapter')!
    expect(dependency.data!.line).toBe('dotted')
    expect(dependency.data!.kind).toBe('dependency')
    expect(dependency.data!.head).toBe('open')
    expect(dependency.data!.bidirectional).toBe(false)
    expect(dependency.label).toBe('协议适配关系')
  })

  it('装配以能力清单呈现，不显示配置装配连接线，调用状态与线型独立', () => {
    const edges = projectLayout(views.overview).edges
    const call = edges.find(edge => edge.source === 'host.authentication' && edge.target === 'host.adapter')!
    expect(call.data).toMatchObject({ kind: 'call', line: 'solid', head: 'normal', tail: 'normal', planned: true })
    for (const view of Object.values(views)) expect(view.edges.some(edge => edge.kind === 'configuration' || edge.kind === 'assembly')).toBe(false)
    expect(views.capabilities.edges).toEqual([])
    expect(views.capabilities.nodes.every(node => node.id === 'host.runtime.capabilities' || node.id.startsWith('host.runtime.capabilities.'))).toBe(true)
    expect(views.overview.edges.every(edge => edge.kind !== undefined)).toBe(true)
  })

  it('原生与适配分支分开，均汇入权限检查后进入同一个 HostApi', () => {
    const edges = views.ingress.edges
    for (const id of ['host.native', 'host.adapter']) {
      expect(edges.filter(edge => edge.source === id).map(edge => edge.target)).toEqual(['host.policy'])
    }
    expect(edges.filter(edge => edge.source === 'host.policy').map(edge => edge.target)).toEqual(['host.api'])
    expect(edges.filter(edge => edge.source === 'host.authentication').map(edge => edge.target).sort()).toEqual(['host.adapter', 'host.native'])
    expect(edges.find(edge => edge.source === 'access.stdio')!.target).toBe('host.native')
    expect(edges.find(edge => edge.source === 'access.network.http')!.target).toBe('host.authentication')
    expect(edges.find(edge => edge.source === 'access.network.ws')!.target).toBe('host.authentication')
    for (const [source, targets] of [['desktop', ['access.stdio']], ['nativeClients', ['access.network.http', 'access.network.ws']], ['customClients', ['access.network.http', 'access.network.ws']], ['externalAgent', ['mcp']], ['mcp', ['access.network.http', 'access.network.ws']]] as const) {
      expect(edges.filter(edge => edge.source === source && edge.line !== 'dotted').map(edge => edge.target).sort()).toEqual([...targets].sort())
    }
  })

  it('双向适配、未实现目标与已有能力有明确完成度', () => {
    expect(moduleDetails['host.native'].status).toBe('implemented')
    expect(moduleDetails['host.adapter'].status).toBe('planned')
    expect(moduleDetails['host.authentication'].status).toBe('partial')
    expect(moduleDetails['host.policy'].status).toBe('partial')
    expect(moduleDetails.users.status).toBe('planned')
    expect(moduleDetails['host.provider'].status).toBe('partial')
    for (const detail of Object.values(moduleDetails).filter(item => item.status === 'partial' && item.showStatus !== false)) {
      expect(detail.features!.map(item => item.status)).toEqual(['implemented', 'planned'])
    }
    const { edges } = projectLayout(views.ingress)
    for (const edge of edges.filter(item => item.data!.line !== 'dotted' && (item.source === 'host.adapter' || item.target === 'host.adapter'))) {
      expect(edge.data!.planned).toBe(true)
      expect(edge.data!.bidirectional).toBe(true)
    }
  })

  it('各视图共用模型，所有节点都有说明与完成度，分组可进入细图', () => {
    const shown = [...new Set(viewIds.flatMap(id => views[id].nodes.map(node => node.id)))].sort()
    expect(shown).toEqual(Object.keys(moduleDetails).sort())
    expect(moduleDetails.access.navigateTo).toBe('ingress')
    expect(moduleDetails['host.services'].navigateTo).toBe('services')
    expect(moduleDetails['host.runtime.capabilities'].navigateTo).toBe('capabilities')
    const core = ['host.services', 'host.runtime.capabilities', 'host.runtime', 'host.runtime.kernel', 'host.runtime.alternative']
    for (const id of core) {
      expect(views.overview.nodes.map(node => node.id)).toContain(id)
      expect(views.execution.nodes.map(node => node.id)).toContain(id)
    }
  })

  it('KernelRunner 包含两个内核，运行与安全为说明，服务和能力在 Host 内按需展开', () => {
    const { nodes, edges } = views.overview
    const find = (id: string) => nodes.find(node => node.id === id)!
    expect(find('host.runtime').parent).toBe('host')
    expect(find('host.runtime').children).toEqual(['host.runtime.kernel', 'host.runtime.alternative', 'host.runtime.capabilities'])
    for (const id of ['host.runtime.kernel', 'host.runtime.alternative', 'host.runtime.capabilities']) expect(find(id).parent).toBe('host.runtime')
    for (const id of ['host.services', 'host.runtime.capabilities']) {
      expect(find(id).parent).toBe(id === 'host.services' ? 'host' : 'host.runtime')
      expect(find(id).children).toEqual([])
      expect(moduleDetails[id].navigateOnClick).toBe(true)
    }
    expect(nodes.map(node => node.id)).not.toContain('host.bundled')
    expect(nodes.map(node => node.id)).not.toContain('host.security')
    expect(find('host.runtime').technology).toContain('自带 Node 22')
    expect(moduleDetails['host.runtime'].boundaryNote).toContain('OS 沙箱预留')
    expect(views.services.nodes.filter(node => node.parent === 'host.services')).toHaveLength(5)
    expect(views.capabilities.nodes.filter(node => node.parent === 'host.runtime.capabilities')).toHaveLength(6)
    expect(edges.find(edge => edge.source === 'host.api' && edge.target === 'host.services')).toBeDefined()
    expect(edges.find(edge => edge.source === 'host.services' && edge.target === 'host.runtime')).toBeDefined()
    expect(edges.some(edge => edge.source === 'host.runtime.capabilities' || edge.target === 'host.runtime.capabilities')).toBe(false)
    expect(edges.find(edge => edge.source === 'host.runtime' && edge.target === 'host.provider')).toBeDefined()
    expect(edges.some(edge => edge.source.startsWith('host.runtime.') || edge.target.startsWith('host.runtime.'))).toBe(false)
    const graph = projectLayout(views.overview)
    const runner = graph.nodeBounds.get('host.runtime')!
    const services = graph.nodeBounds.get('host.services')!
    expect(runner.width).toBe(636)
    expect(runner.height).toBe(196)
    // 回归钉死：x 必须随服务层重定位，否则紧凑后的 Runner 滞留引擎给的左秩，主链折返横穿全图。
    expect(runner.x).toBe(services.x + services.width + 160)
    expect(graph.nodeBounds.get('host')!.width).toBeLessThanOrEqual(3000)
    expect(runner.y + runner.height / 2).toBe(services.y + services.height / 2)
    const cards = ['host.runtime.capabilities', 'host.runtime.kernel', 'host.runtime.alternative'].map(id => graph.nodeBounds.get(id)!)
    expect(new Set(cards.map(card => card.y)).size).toBe(1)
    expect(cards[1].x - cards[0].x - cards[0].width).toBe(24)
    expect(cards[2].x - cards[1].x - cards[1].width).toBe(24)
    const business = graph.edges.find(edge => edge.source === 'host.api' && edge.target === 'host.services')!
    expect(business.data!.route.every(point => point.y === business.data!.route[0].y), 'HostApi 到服务层应直接水平连接').toBe(true)
    const projected = graph.edges
    for (const [source, target] of [['host.services', 'host.runtime'], ['host.runtime', 'host.provider']]) {
      const route = projected.find(edge => edge.source === source && edge.target === target)!.data!.route
      expect(route.every(point => point.y === route[0].y), `${source} → ${target} 应直接水平连接`).toBe(true)
    }
    const api = graph.nodeBounds.get('host.api')!
    const provider = graph.nodeBounds.get('host.provider')!
    const models = graph.nodeBounds.get('models')!
    const host = graph.nodeBounds.get('host')!
    expect(services.x).toBeGreaterThan(api.x)
    expect(provider.x).toBe(runner.x + runner.width + 160)
    expect(models.x).toBe(provider.x + provider.width + 160)
    expect(models.x).toBeGreaterThanOrEqual(host.x + host.width)
    for (const segment of segments(business.data!.route)) expect(hitsBox(segment, runner, 16), 'API 与服务直接相邻，连线不应经过执行容器').toBe(false)
    expect(moduleDetails['host.runtime'].kind).toContain('CogentKernel')
    expect(moduleDetails['host.runtime.alternative'].status).toBe('planned')
    expect(moduleDetails['host.runtime.capabilities'].features!.find(feature => feature.label === '子会话')!.status).toBe('planned')
    expect(moduleDetails['host.runtime.capabilities.subagents'].status).toBe('planned')
  })
})

describe.each(viewIds)('%s 视图的布局适配', id => {
  it('父节点先出现，相对坐标还原后与布局引擎一致', () => {
    const view = views[id]
    const { nodes, nodeBounds } = projectLayout(view)
    for (const node of nodes) {
      const original = nodeBounds.get(node.id)!
      const parent = node.parentId === undefined ? null : nodeBounds.get(node.parentId)!
      expect(node.position.x + (parent === null ? 0 : parent.x)).toBe(original.x)
      expect(node.position.y + (parent === null ? 0 : parent.y)).toBe(original.y)
      expect(node.data.status).toBe(moduleDetails[node.id].status)
      if (node.parentId !== undefined) expect(nodes.findIndex(item => item.id === node.parentId)).toBeLessThan(nodes.indexOf(node))
    }
  })

  it('保留端点与返回方向，标签避开节点、其他标签和所有连线', () => {
    const view = views[id]
    const { edges, nodeBounds } = projectLayout(view)
    for (const original of view.edges) {
      const projected = edges.find(edge => edge.id === original.id)!
      expect(projected.source).toBe(original.source)
      expect(projected.target).toBe(original.target)
      expect(projected.data!.bidirectional).toBe(original.tail === 'normal')
      expect(projected.data!.kind).toBe(original.kind)
      expect(projected.data!.line).toBe(original.line)
      expect(projected.data!.head).toBe(original.head)
      expect(projected.data!.tail).toBe(original.tail)
      expect(projected.data!.path).toMatch(/^M[-\d.]+ [-\d.]+/)
      expect(projected.data!.path).not.toContain('C')
      const box = projected.data!.labelBox
      if (box === null) continue
      for (const node of view.nodes.filter(item => item.children.length === 0).map(node => ({ ...node, ...nodeBounds.get(node.id)! }))) {
        expect(overlap(box, node), `${id}: ${original.label} 不应盖住 ${node.title}`).toBe(false)
      }
      for (const other of edges.filter(item => item.id !== projected.id)) {
        if (other.data!.labelBox !== null) expect(overlap(box, other.data!.labelBox, 6), `${id}: ${original.label} 不应与 ${other.id} 叠字`).toBe(false)
      }
      for (const edge of edges) {
        for (const segment of segments(edge.data!.route)) {
          expect(hitsBox(segment, box, 6), `${id}: ${original.label} 应与 ${edge.id} 的连线保持间距`).toBe(false)
        }
      }
      // 标签有底色，骑在容器边框上会遮掉一段虚线；边框只在自身长度范围内才算被压到。
      const crosses = (at: number, from: number, to: number) => at > from && at < to
      for (const boundary of view.nodes.filter(item => item.children.length > 0)) {
        const frame = nodeBounds.get(boundary.id)!
        const spansHeight = frame.y < box.y + box.height && frame.y + frame.height > box.y
        const spansWidth = frame.x < box.x + box.width && frame.x + frame.width > box.x
        for (const x of [frame.x, frame.x + frame.width]) {
          expect(spansHeight && crosses(x, box.x, box.x + box.width), `${id}: ${original.label} 不应压住 ${boundary.title} 的纵向边框`).toBe(false)
        }
        for (const y of [frame.y, frame.y + frame.height]) {
          expect(spansWidth && crosses(y, box.y, box.y + box.height), `${id}: ${original.label} 不应压住 ${boundary.title} 的横向边框`).toBe(false)
        }
      }
    }
  })

  it('横向正交布线，端口分开且路径不穿过节点，交叉明确跨越且没有共享线段', () => {
    const view = views[id]
    const { edges, nodeBounds } = projectLayout(view)
    const ports = new Map<string, Point[]>()
    if (id !== 'capabilities') expect(view.bounds.width).toBeGreaterThan(view.bounds.height)
    for (const edge of edges) {
      const source = { ...nodeBounds.get(edge.source)!, id: edge.source, title: moduleDetails[edge.source].name }
      const target = { ...nodeBounds.get(edge.target)!, id: edge.target, title: moduleDetails[edge.target].name }
      if (edge.data!.kind === 'call') expect(target.x, `${id}: ${edge.id} 调用流程应朝右或向同列模块流动`).toBeGreaterThanOrEqual(source.x)
      const route = edge.data!.route
      for (const [node, point, next] of [[source, route[0], route[1]], [target, route[route.length - 1], route[route.length - 2]]] as const) {
        const horizontalPort = point.x === node.x || point.x === node.x + node.width
        const verticalPort = point.y === node.y || point.y === node.y + node.height
        expect(horizontalPort || verticalPort, `${node.title} 的箭头应贴边`).toBe(true)
        if (horizontalPort) expect(Math.min(point.y - node.y, node.y + node.height - point.y)).toBeGreaterThanOrEqual(12)
        else expect(Math.min(point.x - node.x, node.x + node.width - point.x)).toBeGreaterThanOrEqual(12)
        // 回归钉死：端点对齐后曾被钳到卡片的另一侧，线从卡片内部穿出；箭头只能从所贴那条边的外侧进入。
        const fromOutside = point.x === node.x ? next.x <= point.x
          : point.x === node.x + node.width ? next.x >= point.x
          : point.y === node.y ? next.y <= point.y
          : next.y >= point.y
        expect(fromOutside, `${id}: ${edge.id} 的箭头应从 ${node.title} 外侧进入，不能穿卡`).toBe(true)
        const previous = ports.get(node.id) ?? []
        for (const other of previous) expect(Math.hypot(point.x - other.x, point.y - other.y), `${node.title} 的端口不应叠在一起`).toBeGreaterThanOrEqual(12)
        ports.set(node.id, [...previous, point])
      }
      for (const segment of segments(route)) {
        expect(segment[0].x === segment[1].x || segment[0].y === segment[1].y).toBe(true)
        for (const node of view.nodes.filter(node => node.children.length === 0 && node.id !== edge.source && node.id !== edge.target).map(node => ({ ...node, ...nodeBounds.get(node.id)! }))) {
          expect(hitsBox(segment, node), `${id}: ${edge.id} 不应穿过 ${node.title}`).toBe(false)
        }
        for (const other of edges.filter(item => item.id !== edge.id)) {
          for (const second of segments(other.data!.route)) {
            if (intersects(segment, second)) {
              const horizontal = segment[0].y === segment[1].y
              expect(horizontal !== (second[0].y === second[1].y), `${id}: 连线不能共享线段`).toBe(true)
              const point = horizontal ? { x: second[0].x, y: segment[0].y } : { x: segment[0].x, y: second[0].y }
              const crossings = [...edge.data!.crossings, ...other.data!.crossings]
              expect(crossings.some(item => item.x === point.x && item.y === point.y), `${id}: 交叉必须显示跨线留白`).toBe(true)
            }
          }
        }
      }
    }
  })
})

function overlap(label: { x: number; y: number; width: number; height: number }, target: { x: number; y: number; width: number; height: number }, targetPadding = 0): boolean {
  return label.x < target.x + target.width + targetPadding && label.x + label.width > target.x - targetPadding
    && label.y < target.y + target.height + targetPadding && label.y + label.height > target.y - targetPadding
}

type Point = { x: number; y: number }
type Segment = [Point, Point]
type Box = Point & { width: number; height: number }
const segments = (points: Point[]): Segment[] => points.slice(1).map((point, index) => [points[index], point])
function hitsBox([a, b]: Segment, box: Box, padding = 0): boolean {
  if (a.y === b.y) return a.y > box.y - padding && a.y < box.y + box.height + padding
    && Math.max(a.x, b.x) > box.x - padding && Math.min(a.x, b.x) < box.x + box.width + padding
  return a.x > box.x - padding && a.x < box.x + box.width + padding
    && Math.max(a.y, b.y) > box.y - padding && Math.min(a.y, b.y) < box.y + box.height + padding
}
function intersects([a, b]: Segment, [c, d]: Segment): boolean {
  const between = (value: number, first: number, last: number) => value >= Math.min(first, last) && value <= Math.max(first, last)
  if (a.y === b.y && c.y === d.y) return a.y === c.y && Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) < Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x))
  if (a.x === b.x && c.x === d.x) return a.x === c.x && Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) < Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y))
  if (a.y === b.y) return between(c.x, a.x, b.x) && between(a.y, c.y, d.y)
  return between(a.x, c.x, d.x) && between(c.y, a.y, b.y)
}
