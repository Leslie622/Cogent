/** 图码保真校验：确保架构地图引用的文件路径、关键符号以及模型/说明双向映射真实有效。 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LikeC4 } from 'likec4'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { edgeDetails, moduleDetails, viewDetails, type SourceRef } from '../src/模块说明'
import { viewIds } from '../src/视图'
import { viewLayouts } from '../src/视图布局'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
let instance: LikeC4

beforeAll(async () => {
  instance = await LikeC4.fromWorkspace(fileURLToPath(new URL('../模型/', import.meta.url)), {
    logger: false,
    throwIfInvalid: true,
  })
})

afterAll(async () => {
  await instance.dispose()
})

function collectSources(): { owner: string; ref: SourceRef }[] {
  const list: { owner: string; ref: SourceRef }[] = []
  for (const [id, detail] of Object.entries(moduleDetails)) {
    for (const ref of detail.sources) list.push({ owner: `module:${id}`, ref })
  }
  for (const [id, detail] of Object.entries(edgeDetails)) {
    for (const ref of detail.sources) list.push({ owner: `edge:${id}`, ref })
  }
  for (const [id, detail] of Object.entries(viewDetails)) {
    for (const ref of detail.sources) list.push({ owner: `view:${id}`, ref })
  }
  return list
}

describe('图码保真校验', () => {
  it('所有模块、连线与视图引用的仓库路径真实存在，代码符号未悬空', () => {
    const cache = new Map<string, string>()
    for (const { owner, ref } of collectSources()) {
      const abs = resolve(repoRoot, ref.path)
      expect(existsSync(abs), `${owner} 引用了不存在的文件: ${ref.path}`).toBe(true)

      // 对代码文件进一步核对：至少有一个标识符令牌出现在文件内（文档段落仅核路径）。
      if (ref.path.startsWith('src/') || ref.path.startsWith('scripts/')) {
        let content = cache.get(abs)
        if (content === undefined) {
          content = readFileSync(abs, 'utf8')
          cache.set(abs, content)
        }
        const fileText = content
        const tokens = ref.symbol
          .split(/[·\s,]+/)
          .map((t) => t.trim())
          .filter((t) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(t))
        if (tokens.length > 0) {
          expect(
            tokens.some((token) => fileText.includes(token)),
            `${owner} 在 ${ref.path} 中未找到任何符号令牌 (${tokens.join(', ')})`,
          ).toBe(true)
        }
      }
    }
  })

  it('C4 视图节点、视图布局表与模块说明保持 1:1 双向齐备', async () => {
    const model = await instance.layoutedModel()
    const seenNodes = new Set<string>()

    for (const id of viewIds) {
      expect(viewDetails[id], `viewDetails 缺少 ${id}`).toBeDefined()
      expect(viewLayouts[id], `viewLayouts 缺少 ${id}`).toBeDefined()
      const view = model.view(id).$layouted
      const spec = viewLayouts[id]

      const rowChildren = new Set(Object.values(spec.rowContainers ?? {}).flat())
      for (const node of view.nodes) {
        seenNodes.add(node.id)
        expect(moduleDetails[node.id], `视图 ${id} 节点 ${node.id} 缺少 moduleDetails 说明`).toBeDefined()
        const isBoundary = node.children.length > 0 && spec.rowContainers?.[node.id] === undefined
        if (!isBoundary && !rowChildren.has(node.id)) {
          expect(spec.slots[node.id], `视图 ${id} 叶子节点 ${node.id} 缺少网格槽位`).toBeDefined()
        }
      }

      // 布局声明中不能留有模型已删掉的悬空节点 ID
      const viewNodeIds = new Set<string>(view.nodes.map((n) => n.id))
      for (const slotId of Object.keys(spec.slots)) {
        expect(viewNodeIds.has(slotId), `viewLayouts.${id}.slots 存在悬空节点: ${slotId}`).toBe(true)
      }
    }

    // moduleDetails 不保留未在任何视图中出现过的废弃孤立条目
    for (const id of Object.keys(moduleDetails)) {
      expect(seenNodes.has(id), `moduleDetails 存在未出现在任何视图的孤立条目: ${id}`).toBe(true)
    }

    // 全部 13 张视图中的每一条渲染边都必须在 edgeDetails 中具备明确契约说明，不允许退化为通用兜底废话
    const seenEdges = new Set<string>()
    for (const viewId of viewIds) {
      for (const edge of model.view(viewId).$layouted.edges) {
        const key = `${edge.source}>${edge.target}`
        seenEdges.add(key)
        expect(edgeDetails[key], `${viewId} 连线 ${key} 缺少 edgeDetails 契约说明`).toBeDefined()
      }
    }
    for (const key of Object.keys(edgeDetails)) {
      expect(seenEdges.has(key), `edgeDetails 存在未在任何视图中出现的孤立连线: ${key}`).toBe(true)
    }
  })

  it('已彻底剥离对主应用 src/renderer 的跨目录引用且不跳转 GitHub 外链', () => {
    const viteConfig = readFileSync(fileURLToPath(new URL('../vite.config.ts', import.meta.url)), 'utf8')
    const tsConfig = readFileSync(fileURLToPath(new URL('../tsconfig.json', import.meta.url)), 'utf8')
    const css = readFileSync(fileURLToPath(new URL('../src/页面.css', import.meta.url)), 'utf8')
    const panel = readFileSync(fileURLToPath(new URL('../src/components/模块面板.tsx', import.meta.url)), 'utf8')
    const app = readFileSync(fileURLToPath(new URL('../src/App.tsx', import.meta.url)), 'utf8')
    expect(viteConfig).not.toContain('../../src')
    expect(tsConfig).not.toContain('../../src')
    expect(tsConfig).not.toContain('../../node_modules')
    expect(css).not.toContain('../../../src')
    expect(panel).not.toContain('github.com')
    expect(app).not.toContain('此连线表达两模块间的稳定调用或数据流方向')
  })
})
