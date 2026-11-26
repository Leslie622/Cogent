/** 用真实 Chrome 验证离线项目地图；检查 10 个视图、下钻返回、连线契约、状态筛选、无裁切与单文件体积。 */
import assert from 'node:assert/strict'
import { mkdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(new URL('../docs/架构地图/package.json', import.meta.url))
const { chromium } = require('playwright')
const output = new URL('../tmp/架构地图验收/', import.meta.url)
const distUrl = new URL('../docs/架构地图/dist/index.html', import.meta.url)

const views = [
  { name: '架构总览', id: 'overview', nodes: 21, edges: 17 },
  { name: '桌面壳内部', id: 'desktopShell', nodes: 15, edges: 8 },
  { name: 'Host 服务层', id: 'services', nodes: 9, edges: 3 },
  { name: '执行能力', id: 'capabilities', nodes: 11, edges: 2 },
  { name: '数据与存储', id: 'storage', nodes: 15, edges: 9 },
  { name: '身份验证与权限', id: 'flowAuth', nodes: 12, edges: 12 },
  { name: '消息与审批闭环', id: 'flowApproval', nodes: 11, edges: 12 },
  { name: 'MCP 双轨机制', id: 'flowMcp', nodes: 12, edges: 9 },
  { name: '技能加载机制', id: 'flowSkills', nodes: 9, edges: 6 },
  { name: '钩子与扩展机制', id: 'flowHooks', nodes: 12, edges: 8 },
  { name: '上下文工程与压缩转录', id: 'flowCompaction', nodes: 15, edges: 12 },
  { name: '文件边界与产物交付', id: 'flowOutputs', nodes: 11, edges: 7 },
  { name: '凭据与模型出站', id: 'flowModels', nodes: 11, edges: 11 },
  { name: '提示词工程与装配', id: 'flowPrompts', nodes: 13, edges: 9 },
]

await mkdir(output, { recursive: true })
const distStat = await stat(distUrl)
assert.ok(distStat.size < 2 * 1024 * 1024, `离线单文件应小于 2MB，实际 ${(distStat.size / 1024 / 1024).toFixed(2)} MB`)

const browser = await chromium.launch({ channel: process.env.COGENT_BROWSER_CHANNEL ?? 'chrome', headless: true })
let devServer
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce' })
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  const errors = []
  const requests = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await page.route(/^https?:/, route => { requests.push(route.request().url()); return route.abort() })
  await page.goto(distUrl.href)
  await page.locator('.react-flow__node[data-id="host.api"]').waitFor()
  await page.evaluate(() => document.fonts.ready)

  const scale = async () => Number.parseInt(await page.getByLabel('当前缩放').innerText(), 10)
  const screenshot = name => page.screenshot({ path: fileURLToPath(new URL(name, output)), fullPage: true })
  const panel = page.getByRole('complementary', { name: '架构说明' })
  const nav = page.getByRole('navigation', { name: '架构导航' })

  async function noOverflow() {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight), false, '页面不应整体滚动或溢出')
    const clips = await page.locator('.architecture-node [data-slot="card"]').evaluateAll(cards =>
      cards.filter(card => card.scrollHeight > card.clientHeight + 1 || card.scrollWidth > card.clientWidth + 1).length,
    )
    assert.equal(clips, 0, '卡片内容不应裁切')
  }

  async function fitDiagram() {
    await page.getByRole('button', { name: '适应画布', exact: true }).click()
    await page.waitForFunction(() => {
      const canvas = document.querySelector('.architecture-canvas').getBoundingClientRect()
      return Array.from(document.querySelectorAll('.react-flow__node')).every(node => {
        const box = node.getBoundingClientRect()
        return box.left >= canvas.left + 20 && box.right <= canvas.right - 20
          && box.top >= canvas.top + 56 && box.bottom <= canvas.bottom - 72
      })
    })
  }

  async function reset() {
    await page.getByRole('button', { name: '复位画布', exact: true }).click()
    await page.waitForFunction(() => Number.parseInt(document.querySelector('[aria-label="当前缩放"]').textContent, 10) >= 85)
  }

  async function fold(side, closed) {
    const label = side === 'left' ? '左侧栏' : '右侧栏'
    await page.getByRole('button', { name: `${closed ? '折叠' : '展开'}${label}`, exact: true }).click()
    await page.waitForFunction(({ side, closed }) => {
      const width = document.querySelector(`.architecture-${side}`).getBoundingClientRect().width
      return closed ? width === 0 : width > 0
    }, { side, closed })
  }

  async function neutral(selector) {
    const colors = await page.locator(selector).evaluateAll(elements => elements.map(element => {
      const drawing = document.createElement('canvas').getContext('2d')
      drawing.fillStyle = getComputedStyle(element).backgroundColor
      drawing.fillRect(0, 0, 1, 1)
      return Array.from(drawing.getImageData(0, 0, 1, 1).data).slice(0, 3)
    }))
    for (const color of colors) assert.ok(Math.max(...color) - Math.min(...color) <= 1, `${selector} 应使用中性色：${color}`)
  }

  async function switchView(name) {
    await nav.getByRole('button', { name, exact: true }).click()
    await panel.getByRole('heading', { name, exact: true }).waitFor()
    await reset()
  }

  // 1. 验证三栏基础布局与左侧双分组导航（5 架构视图 + 9 专题流程 = 14 项）
  assert.equal(await nav.getByRole('button').count(), 14)
  const left = await page.getByRole('complementary', { name: '架构目录' }).boundingBox()
  const center = await page.locator('.architecture-canvas').boundingBox()
  const right = await panel.boundingBox()
  assert.equal(left.x, 0)
  assert.equal(center.x, left.width)
  assert.equal(right.x, center.x + center.width)
  assert.equal(right.x + right.width, 1600)
  await neutral('.architecture-sidebar')

  // 2. 遍历全部 10 个视图验证节点数、边数、无溢出、适应画布与小地图收放
  for (const current of views) {
    await switchView(current.name)
    assert.equal(await page.locator('.react-flow__node').count(), current.nodes, `${current.name} 节点数`)
    assert.equal(await page.locator('.react-flow__edge').count(), current.edges, `${current.name} 连线数`)
    assert.ok(await scale() >= 85, `${current.name} 默认缩放应保持可读`)
    await noOverflow()
    await fitDiagram()
    const clippedLabels = await page.locator('.architecture-relationship > g[transform]').evaluateAll(groups => groups.flatMap(group => {
      const text = group.querySelector('text').getBBox()
      const mask = group.querySelector('rect').getBBox()
      return text.x < mask.x - 1 || text.x + text.width > mask.x + mask.width + 1 || text.height > mask.height ? [group.textContent] : []
    }))
    assert.deepEqual(clippedLabels, [], `${current.name} 标签遮罩应容纳实际字体`)
    assert.equal(await page.locator('.react-flow__minimap').count(), 0, `${current.name} 全图可见时应收起小地图`)
    await screenshot(`视图-${current.id}.png`)
  }

  // 3. 总览：阶段标题、KernelRunner、下钻桌面壳与返回、连线契约、状态筛选
  await switchView('架构总览')
  await fitDiagram()
  const hostStages = await page.locator('.react-flow__node[data-id="host"] .architecture-stage').evaluateAll(els => els.map(el => el.textContent))
  assert.deepEqual(hostStages, ['接入与协议', '业务分发', '内核执行', '模型出口'])

  // 筛选模式：仅已实现应隐藏规划节点与连线 / 高亮缺口
  const filterGroup = page.getByRole('group', { name: '完成度筛选', exact: true })
  await filterGroup.getByRole('button', { name: '仅已实现', exact: true }).click()
  assert.equal(await page.locator('.react-flow__node[data-id="host.adapter"]').count(), 0)
  assert.equal(await page.locator('.react-flow__node[data-id="host.native"] .architecture-node').getAttribute('data-dimmed'), 'false')
  await screenshot('视图-overview-implemented.png')
  await filterGroup.getByRole('button', { name: '高亮缺口', exact: true }).click()
  assert.equal(await page.locator('.react-flow__node[data-id="host.adapter"] .architecture-node').getAttribute('data-highlighted'), 'true')
  await filterGroup.getByRole('button', { name: '全部', exact: true }).click()

  // 点击主链连线（标签或路径）查看边界契约
  await page.locator('.react-flow__edge').filter({ hasText: 'IPC 转管道' }).locator('text').click()
  await panel.getByRole('heading', { name: '边界规则', exact: true }).waitFor()

  // 下钻「主 UI 桌面壳」→ 「桌面壳内部」，再一键返回并还原选中节点
  await page.getByRole('button', { name: '查看主 UI 桌面壳', exact: true }).click()
  await panel.getByRole('heading', { name: '桌面壳内部', exact: true }).waitFor()
  await page.getByRole('button', { name: '返回架构总览', exact: true }).click()
  await panel.getByRole('heading', { name: '主 UI 桌面壳', exact: true }).waitFor()

  // 点击节点 → 源码页签 → 验证复制路径按钮且无 GitHub 外链
  await fitDiagram()
  await page.getByRole('button', { name: '查看PiSdkKernel', exact: true }).click()
  await panel.getByRole('heading', { name: 'PiSdkKernel', exact: true }).waitFor()
  await panel.getByRole('tab', { name: '源码', exact: true }).click()
  assert.equal(await panel.locator('a[href*="github.com"]').count(), 0)
  const copySourceButton = panel.getByRole('button', { name: '复制路径 src/host/kernel/pi-session-factory.ts', exact: true })
  await copySourceButton.waitFor()

  // 4. 明暗持久化与侧栏独立折叠
  await fold('left', true)
  assert.equal((await page.locator('.architecture-canvas').boundingBox()).width, center.width + left.width)
  await fold('right', true)
  assert.equal((await page.locator('.architecture-canvas').boundingBox()).width, 1600)
  await fold('right', false)
  await fold('left', false)

  await page.getByRole('button', { name: '切换深色', exact: true }).click()
  await neutral('.architecture-sidebar')
  await page.reload()
  await page.getByRole('button', { name: '切换浅色', exact: true }).waitFor()
  await page.getByRole('button', { name: '切换浅色', exact: true }).click()

  // 5. 响应式多视口（1920, 1440, 1024, 390）与窄屏 Esc 返回
  for (const width of [1920, 1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    await reset()
    await noOverflow()
    await fitDiagram()
    await noOverflow()
  }
  const mobileNode = page.getByRole('button', { name: '查看PiSdkKernel', exact: true })
  await mobileNode.click()
  await panel.getByRole('heading', { name: 'PiSdkKernel', exact: true }).waitFor()
  assert.equal((await page.locator('.architecture-canvas').boundingBox()).width, 390)
  await page.keyboard.press('Escape')
  assert.equal(await panel.count(), 0)

  // 6. 开发服务入口自检
  const { createServer } = await import(pathToFileURL(require.resolve('vite')).href)
  devServer = await createServer({
    root: fileURLToPath(new URL('../docs/架构地图/', import.meta.url)),
    configFile: fileURLToPath(new URL('../docs/架构地图/vite.config.ts', import.meta.url)),
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'warn',
  })
  await devServer.listen()
  const development = await context.newPage()
  development.on('pageerror', error => errors.push(error.message))
  development.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  development.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
  await development.goto(devServer.resolvedUrls.local[0])
  await development.locator('.react-flow__node[data-id="host.api"]').waitFor()
  assert.equal(await development.getByRole('navigation', { name: '架构导航' }).getByRole('button').count(), views.length)
  assert.deepEqual(errors, [])
  assert.deepEqual(requests, [], '离线 HTML 不应请求外部资源')

  console.log(JSON.stringify({
    passed: true,
    distSizeMB: Number((distStat.size / 1024 / 1024).toFixed(2)),
    views: views.length,
    widths: [1920, 1440, 1024, 390],
    errors,
    externalRequests: requests,
  }, null, 2))
} finally {
  if (devServer) await devServer.close()
  await browser.close()
}
