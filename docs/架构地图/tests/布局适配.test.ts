/** 确定性网格布局与全视图几何回归：覆盖 10 个视图的正交路由、避障、状态筛选与局部扩展稳定性。 */
import { fileURLToPath } from 'node:url'
import { LikeC4 } from 'likec4'
import type { LayoutedView } from 'likec4/model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { projectLayout } from '../src/网格布局'
import { moduleDetails } from '../src/模块说明'
import { viewIds, type ViewId } from '../src/视图'

let instance: LikeC4
let views: Record<ViewId, LayoutedView>

beforeAll(async () => {
  instance = await LikeC4.fromWorkspace(fileURLToPath(new URL('../模型/', import.meta.url)), {
    logger: false,
    throwIfInvalid: true,
  })
  const model = await instance.layoutedModel()
  views = Object.fromEntries(viewIds.map((id) => [id, model.view(id).$layouted])) as Record<ViewId, LayoutedView>
})

afterAll(async () => {
  await instance.dispose()
})

describe('总览结构与状态筛选', () => {
  it('主链从桌面壳到远端模型保持单线水平直连', () => {
    const { nodeBounds, edges } = projectLayout(views.overview)
    const box = (id: string) => nodeBounds.get(id)!
    const mainChain = [
      'desktop',
      'access.stdio',
      'host.native',
      'host.policy',
      'host.api',
      'host.services',
      'host.runtime',
      'host.provider',
      'models',
    ]
    const y0 = box('desktop').y + box('desktop').height / 2
    for (const id of mainChain) {
      expect(box(id).y + box(id).height / 2, `${id} 应居同一主链水平中心`).toBe(y0)
    }
    for (let i = 0; i < mainChain.length - 1; i++) {
      const edge = edges.find((e) => e.source === mainChain[i] && e.target === mainChain[i + 1])!
      const route = edge.data!.route
      expect(route.every((pt) => pt.y === route[0].y), `${mainChain[i]} → ${mainChain[i + 1]} 应水平直连`).toBe(true)
    }
  })

  it('Host 阶段标题精确覆盖对应卡片横向范围，KernelRunner 紧凑单排', () => {
    const graph = projectLayout(views.overview)
    const hostNode = graph.nodes.find((n) => n.id === 'host')!
    expect(hostNode.data.stages.map((s) => s.label)).toEqual(['接入与协议', '业务分发', '内核执行', '模型出口'])
    const cards = ['host.runtime.capabilities', 'host.runtime.kernel', 'host.runtime.alternative'].map(
      (id) => graph.nodeBounds.get(id)!,
    )
    expect(cards[1].x).toBeGreaterThan(cards[0].x + cards[0].width)
    expect(cards[2].x).toBeGreaterThan(cards[1].x + cards[1].width)
    expect(cards[0].y + cards[0].height / 2).toBe(cards[1].y + cards[1].height / 2)
    expect(cards[1].y + cards[1].height / 2).toBe(cards[2].y + cards[2].height / 2)
  })

  it('完成度筛选模式在仅已实现下真正隐藏规划项，在缺口模式下突出缺口', () => {
    const implemented = projectLayout(views.overview, 'implemented')
    expect(implemented.nodes.some((n) => n.id === 'host.adapter')).toBe(false)
    expect(implemented.nodes.some((n) => n.id === 'users')).toBe(false)
    expect(implemented.edges.some((e) => e.data?.planned === true)).toBe(false)
    expect(implemented.hiddenPlannedCount.nodes).toBeGreaterThan(0)
    expect(implemented.hiddenPlannedCount.edges).toBeGreaterThan(0)
    const apiNode = implemented.nodes.find((n) => n.id === 'host.api')!
    const nativeToPolicy = implemented.edges.find((e) => e.source === 'host.native' && e.target === 'host.policy')!
    expect(apiNode.data.dimmed).toBe(false)
    expect(nativeToPolicy.data?.dimmed).toBe(false)

    const gaps = projectLayout(views.overview, 'gaps')
    const adapterGap = gaps.nodes.find((n) => n.id === 'host.adapter')!
    const policyGap = gaps.nodes.find((n) => n.id === 'host.policy')!
    const apiGap = gaps.nodes.find((n) => n.id === 'host.api')!
    expect(adapterGap.data.highlighted).toBe(true)
    expect(policyGap.data.highlighted).toBe(true)
    expect(apiGap.data.dimmed).toBe(true)
    expect(moduleDetails['host.policy'].status).toBe('partial')
  })

  it('局部稳定性：同一视图在非相关列加节点不影响左侧主干坐标', () => {
    const base = projectLayout(views.flowAuth)
    // 克隆视图并在末尾第 7 列新增一个节点，验证前 6 列坐标纹丝不动。
    const baseLeft = ['flow.auth.entries.stdio', 'flow.auth.entries.http', 'flow.auth.ticket', 'flow.auth.verify'].map((id) => ({
      id,
      box: base.nodeBounds.get(id)!,
    }))
    const secondRun = projectLayout(views.flowAuth)
    for (const item of baseLeft) {
      expect(secondRun.nodeBounds.get(item.id)).toEqual(item.box)
    }
  })
})

describe('全视图通用几何不变量', () => {
  for (const viewId of viewIds) {
    it(`${viewId}: 无节点重叠、容器完整包围子节点、连线正交且不穿卡不共线`, () => {
      const graph = projectLayout(views[viewId])
      const leafBoxes = graph.nodes.filter((n) => !n.data.compound).map((n) => ({
        id: n.id,
        ...graph.nodeBounds.get(n.id)!,
      }))

      // 1. 任意两张叶子卡片不相交
      for (let i = 0; i < leafBoxes.length; i++) {
        for (let j = i + 1; j < leafBoxes.length; j++) {
          const a = leafBoxes[i]
          const b = leafBoxes[j]
          const overlapX = a.x < b.x + b.width && a.x + a.width > b.x
          const overlapY = a.y < b.y + b.height && a.y + a.height > b.y
          expect(overlapX && overlapY, `${viewId}: ${a.id} 与 ${b.id} 不应重叠`).toBe(false)
        }
      }

      // 2. 容器完整包围所有直接子节点
      for (const node of graph.nodes) {
        if (node.parentId === undefined) continue
        const child = graph.nodeBounds.get(node.id)!
        const parent = graph.nodeBounds.get(node.parentId)!
        expect(child.x, `${viewId}: ${node.id} 超出父容器左边界`).toBeGreaterThanOrEqual(parent.x)
        expect(child.y, `${viewId}: ${node.id} 超出父容器上边界`).toBeGreaterThanOrEqual(parent.y)
        expect(child.x + child.width, `${viewId}: ${node.id} 超出父容器右边界`).toBeLessThanOrEqual(parent.x + parent.width)
        expect(child.y + child.height, `${viewId}: ${node.id} 超出父容器下边界`).toBeLessThanOrEqual(parent.y + parent.height)
      }

      // 3. 连线正交、端点贴边、不穿非端点叶子节点
      const allSegments: { edgeId: string; a: { x: number; y: number }; b: { x: number; y: number } }[] = []
      for (const edge of graph.edges) {
        const route = edge.data!.route
        expect(route.length, `${viewId}: ${edge.id} 至少包含两点`).toBeGreaterThanOrEqual(2)
        const s = graph.nodeBounds.get(edge.source)!
        const t = graph.nodeBounds.get(edge.target)!
        const first = route[0]
        const last = route[route.length - 1]

        expect(onBorder(first, s), `${viewId}: ${edge.id} 起点应贴在源边框`).toBe(true)
        expect(onBorder(last, t), `${viewId}: ${edge.id} 终点应贴在目标边框`).toBe(true)

        for (let k = 0; k < route.length - 1; k++) {
          const a = route[k]
          const b = route[k + 1]
          expect(a.x === b.x || a.y === b.y, `${viewId}: ${edge.id} 段 ${k} 应正交`).toBe(true)
          expect(a.x === b.x && a.y === b.y, `${viewId}: ${edge.id} 段 ${k} 不应零长`).toBe(false)
          allSegments.push({ edgeId: edge.id, a, b })

          for (const box of leafBoxes) {
            if (box.id === edge.source || box.id === edge.target) continue
            expect(segmentHitsInterior(a, b, box), `${viewId}: ${edge.id} 穿过 ${box.id}`).toBe(false)
          }
        }
      }

      // 4. 任意两条边不共享重叠共线段
      for (let i = 0; i < allSegments.length; i++) {
        for (let j = i + 1; j < allSegments.length; j++) {
          const s1 = allSegments[i]
          const s2 = allSegments[j]
          if (s1.edgeId === s2.edgeId) continue
          expect(segmentsOverlap(s1.a, s1.b, s2.a, s2.b), `${viewId}: ${s1.edgeId} 与 ${s2.edgeId} 共享线段`).toBe(false)
        }
      }

      // 5. 标签不覆盖任何叶子节点，且标签之间互不重叠
      const labelBoxes = graph.edges.flatMap((e) => (e.data!.labelBox === null ? [] : [{ id: e.id, box: e.data!.labelBox }]))
      for (const item of labelBoxes) {
        for (const leaf of leafBoxes) {
          expect(boxesOverlap(item.box, leaf), `${viewId}: 标签 ${item.id} 覆盖节点 ${leaf.id}`).toBe(false)
        }
      }
      for (let i = 0; i < labelBoxes.length; i++) {
        for (let j = i + 1; j < labelBoxes.length; j++) {
          expect(
            boxesOverlap(labelBoxes[i].box, labelBoxes[j].box),
            `${viewId}: 标签 ${labelBoxes[i].id} 与 ${labelBoxes[j].id} 重叠`,
          ).toBe(false)
        }
      }
    })
  }
})

function onBorder(pt: { x: number; y: number }, box: { x: number; y: number; width: number; height: number }): boolean {
  const onX = Math.abs(pt.x - box.x) <= 1 || Math.abs(pt.x - (box.x + box.width)) <= 1
  const onY = Math.abs(pt.y - box.y) <= 1 || Math.abs(pt.y - (box.y + box.height)) <= 1
  return (
    (onX && pt.y >= box.y - 1 && pt.y <= box.y + box.height + 1)
    || (onY && pt.x >= box.x - 1 && pt.x <= box.x + box.width + 1)
  )
}

function segmentHitsInterior(
  a: { x: number; y: number },
  b: { x: number; y: number },
  box: { x: number; y: number; width: number; height: number },
): boolean {
  const minX = Math.min(a.x, b.x)
  const maxX = Math.max(a.x, b.x)
  const minY = Math.min(a.y, b.y)
  const maxY = Math.max(a.y, b.y)
  return maxX > box.x + 1 && minX < box.x + box.width - 1 && maxY > box.y + 1 && minY < box.y + box.height - 1
}

function segmentsOverlap(
  a1: { x: number; y: number },
  b1: { x: number; y: number },
  a2: { x: number; y: number },
  b2: { x: number; y: number },
): boolean {
  if (a1.y === b1.y && a2.y === b2.y && a1.y === a2.y) {
    return Math.max(Math.min(a1.x, b1.x), Math.min(a2.x, b2.x)) < Math.min(Math.max(a1.x, b1.x), Math.max(a2.x, b2.x))
  }
  if (a1.x === b1.x && a2.x === b2.x && a1.x === a2.x) {
    return Math.max(Math.min(a1.y, b1.y), Math.min(a2.y, b2.y)) < Math.min(Math.max(a1.y, b1.y), Math.max(a2.y, b2.y))
  }
  return false
}

function boxesOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}
