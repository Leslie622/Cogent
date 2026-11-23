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
  it('传输入口纵向展开，桌面、stdio 与原生入口直连，网络接线保持水平', () => {
    const find = (id: string) => views.overview.nodes.find(node => node.id === id)!
    expect(find('desktop').y).toBe(find('access.stdio').y)
    expect(find('access.stdio').y).toBe(find('host.native').y)
    expect(find('customClients').y).toBe(find('access.network').y)
    expect(find('access.network').y).toBe(find('host.authentication').y)
    const { edges } = projectLayout(views.overview)
    for (const [source, target] of [['desktop', 'access.stdio'], ['access.stdio', 'host.native'], ['customClients', 'access.network'], ['access.network', 'host.authentication']]) {
      const route = edges.find(edge => edge.source === source && edge.target === target)!.data!.route
      expect(route.every(point => point.y === route[0].y), `${source} → ${target} 应直接水平连接`).toBe(true)
    }
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
    expect(projected.find(edge => edge.source === 'host.authentication' && edge.target === 'host.adapter')!.data!.line).toBe('dashed')
    const dependency = projected.find(edge => edge.source === 'customClients' && edge.target === 'host.adapter')!
    expect(dependency.data!.line).toBe('dotted')
    expect(dependency.data!.bidirectional).toBe(false)
    expect(dependency.label).toBe('协议适配关系')
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
    expect(moduleDetails['host.capabilities'].navigateTo).toBe('capabilities')
    const core = ['host.services', 'host.capabilities', 'host.runtime', 'host.runtime.kernel', 'host.runtime.alternative']
    for (const id of core) {
      expect(views.overview.nodes.map(node => node.id)).toContain(id)
      expect(views.execution.nodes.map(node => node.id)).toContain(id)
    }
  })

  it('KernelRunner 包含两个内核，运行与安全为说明，服务和能力在 Host 内按需展开', () => {
    const { nodes, edges } = views.overview
    const find = (id: string) => nodes.find(node => node.id === id)!
    expect(find('host.runtime').parent).toBe('host')
    expect(find('host.runtime').children).toEqual(['host.runtime.kernel', 'host.runtime.alternative'])
    for (const id of ['host.runtime.kernel', 'host.runtime.alternative']) expect(find(id).parent).toBe('host.runtime')
    expect(find('host').width).toBeLessThanOrEqual(1800)
    for (const id of ['host.services', 'host.capabilities']) {
      expect(find(id).parent).toBe('host')
      expect(find(id).children).toEqual([])
      expect(moduleDetails[id].navigateOnClick).toBe(true)
    }
    expect(nodes.map(node => node.id)).not.toContain('host.bundled')
    expect(nodes.map(node => node.id)).not.toContain('host.security')
    expect(find('host.runtime').technology).toContain('自带 Node 22')
    expect(moduleDetails['host.runtime'].boundaryNote).toContain('OS 沙箱预留')
    expect(views.services.nodes.filter(node => node.parent === 'host.services')).toHaveLength(5)
    expect(views.capabilities.nodes.filter(node => node.parent === 'host.capabilities')).toHaveLength(6)
    expect(edges.find(edge => edge.source === 'host.api' && edge.target === 'host.services')).toBeDefined()
    expect(edges.find(edge => edge.source === 'host.services' && edge.target === 'host.runtime')).toBeDefined()
    expect(edges.find(edge => edge.source === 'host.services' && edge.target === 'host.capabilities')).toBeDefined()
    expect(edges.find(edge => edge.source === 'host.capabilities' && edge.target === 'host.runtime')).toBeDefined()
    expect(edges.find(edge => edge.source === 'host.runtime' && edge.target === 'host.provider')).toBeDefined()
    expect(edges.some(edge => edge.source.startsWith('host.runtime.') || edge.target.startsWith('host.runtime.'))).toBe(false)
    expect(find('host.runtime').y).toBeGreaterThan(find('host.api').y + find('host.api').height)
    expect(find('host.services').x).toBe(find('host.capabilities').x)
    expect(Math.abs(find('host.capabilities').y - find('host.services').y)).toBeGreaterThan(find('host.services').height)
    const business = projectLayout(views.overview).edges.find(edge => edge.source === 'host.api' && edge.target === 'host.services')!
    for (const segment of segments(business.data!.route)) expect(hitsBox(segment, find('host.runtime'), 16), '业务回接线应绕过整个 KernelRunner，不能穿过标题、内部空隙或安全说明').toBe(false)
    expect(moduleDetails['host.runtime'].kind).toContain('CogentKernel')
    expect(moduleDetails['host.runtime.alternative'].status).toBe('planned')
    expect(moduleDetails['host.capabilities'].features!.find(feature => feature.label === '子会话')!.status).toBe('planned')
    expect(moduleDetails['host.capabilities.subagents'].status).toBe('planned')
  })
})

describe.each(viewIds)('%s 视图的布局适配', id => {
  it('父节点先出现，相对坐标还原后与布局引擎一致', () => {
    const view = views[id]
    const { nodes } = projectLayout(view)
    for (const node of nodes) {
      const original = view.nodes.find(item => item.id === node.id)!
      const parent = node.parentId === undefined ? null : view.nodes.find(item => item.id === node.parentId)!
      expect(node.position.x + (parent === null ? 0 : parent.x)).toBe(original.x)
      expect(node.position.y + (parent === null ? 0 : parent.y)).toBe(original.y)
      expect(node.data.status).toBe(moduleDetails[node.id].status)
      if (node.parentId !== undefined) expect(nodes.findIndex(item => item.id === node.parentId)).toBeLessThan(nodes.indexOf(node))
    }
  })

  it('保留端点与返回方向，标签避开节点、其他标签和所有连线', () => {
    const view = views[id]
    const { edges } = projectLayout(view)
    for (const original of view.edges) {
      const projected = edges.find(edge => edge.id === original.id)!
      expect(projected.source).toBe(original.source)
      expect(projected.target).toBe(original.target)
      expect(projected.data!.bidirectional).toBe(original.tail === 'normal')
      expect(projected.data!.path).toMatch(/^M[-\d.]+ [-\d.]+/)
      expect(projected.data!.path).not.toContain('C')
      const box = projected.data!.labelBox
      if (box === null) continue
      for (const node of view.nodes.filter(item => item.children.length === 0)) {
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
    }
  })

  it('横向正交布线，端口分开且路径不穿过节点，交叉明确跨越且没有共享线段', () => {
    const view = views[id]
    const { edges } = projectLayout(view)
    const ports = new Map<string, Point[]>()
    expect(view.bounds.width).toBeGreaterThan(view.bounds.height)
    for (const edge of edges) {
      const source = view.nodes.find(node => node.id === edge.source)!
      const target = view.nodes.find(node => node.id === edge.target)!
      if (id === 'overview' && edge.source === 'host.api' && edge.target === 'host.services') {
        expect(target.x, `${id}: ${edge.id} 应折返到 Host 服务层`).toBeLessThan(source.x)
      } else expect(target.x, `${id}: ${edge.id} 应朝右或向同列辅助层流动`).toBeGreaterThanOrEqual(source.x)
      const route = edge.data!.route
      for (const [node, point] of [[source, route[0]], [target, route[route.length - 1]]] as const) {
        const horizontalPort = point.x === node.x || point.x === node.x + node.width
        const verticalPort = point.y === node.y || point.y === node.y + node.height
        expect(horizontalPort || verticalPort, `${node.title} 的箭头应贴边`).toBe(true)
        if (horizontalPort) expect(Math.min(point.y - node.y, node.y + node.height - point.y)).toBeGreaterThanOrEqual(12)
        else expect(Math.min(point.x - node.x, node.x + node.width - point.x)).toBeGreaterThanOrEqual(12)
        const previous = ports.get(node.id) ?? []
        for (const other of previous) expect(Math.hypot(point.x - other.x, point.y - other.y), `${node.title} 的端口不应叠在一起`).toBeGreaterThanOrEqual(12)
        ports.set(node.id, [...previous, point])
      }
      for (const segment of segments(route)) {
        expect(segment[0].x === segment[1].x || segment[0].y === segment[1].y).toBe(true)
        for (const node of view.nodes.filter(node => node.children.length === 0 && node.id !== edge.source && node.id !== edge.target)) {
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
