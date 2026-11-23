/** 用真实 Chrome 验证离线架构地图；结束时关闭浏览器与临时 Vite 服务。 */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(new URL('../docs/架构地图/package.json', import.meta.url))
const { chromium } = require('playwright')
const output = new URL('../tmp/架构地图验收/', import.meta.url)
const views = [
  { name: '总览', id: 'overview', heading: '架构总览', nodes: 21, edges: 17 },
  { name: '接入', id: 'ingress', heading: '接入链路', nodes: 14, edges: 18 },
  { name: '执行', id: 'execution', heading: '执行链路', nodes: 8, edges: 4 },
]
await mkdir(output, { recursive: true })
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
  await page.goto(new URL('../docs/架构地图/dist/index.html', import.meta.url).href)
  await page.locator('.react-flow__node[data-id="host.api"]').waitFor()
  await page.evaluate(() => document.fonts.ready)
  const scale = async () => Number.parseInt(await page.getByLabel('当前缩放').innerText())
  const screenshot = name => page.screenshot({ path: fileURLToPath(new URL(name, output)), fullPage: true })
  const panel = page.getByRole('complementary', { name: '架构说明' })

  async function noOverflow() {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight), false, '页面不应整体滚动或溢出')
    const clips = await page.locator('.architecture-node [data-slot="card"]').evaluateAll(cards => cards.filter(card => card.scrollHeight > card.clientHeight + 1 || card.scrollWidth > card.clientWidth + 1).length)
    assert.equal(clips, 0, '卡片内容不应裁切')
  }
  async function fitDiagram() {
    await page.getByRole('button', { name: '适应画布', exact: true }).click()
    await page.waitForFunction(() => {
      const canvas = document.querySelector('.architecture-canvas').getBoundingClientRect()
      return Array.from(document.querySelectorAll('.react-flow__node')).every(node => {
        const box = node.getBoundingClientRect()
        return box.left >= canvas.left + 24 && box.right <= canvas.right - 24
          && box.top >= canvas.top + 56 && box.bottom <= canvas.bottom - 72
      })
    })
  }
  async function reset() {
    await page.getByRole('button', { name: '复位画布', exact: true }).click()
    await page.waitForFunction(() => Number.parseInt(document.querySelector('[aria-label="当前缩放"]').textContent) >= 85)
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
  async function view(name) {
    await page.getByRole('group', { name: '架构视图', exact: true }).getByRole('button', { name, exact: true }).click()
    await page.getByRole('button', { name: '适应画布', exact: true }).waitFor()
    await reset()
  }

  assert.equal(await page.getByRole('navigation', { name: '架构导航' }).getByRole('button').count(), 1)
  const left = await page.getByRole('complementary', { name: '架构目录' }).boundingBox()
  const center = await page.locator('.architecture-canvas').boundingBox()
  const right = await panel.boundingBox()
  assert.equal(left.x, 0)
  assert.equal(center.x, left.width)
  assert.equal(right.x, center.x + center.width)
  assert.equal(right.x + right.width, 1600)
  assert.equal(center.y, 0)
  assert.equal(center.height, 1000)
  await neutral('.architecture-sidebar')
  await neutral('.architecture-boundary')
  assert.doesNotMatch(await page.locator('body').innerText(), /与项目源码一同维护|项目架构文档|阅读指南|快速定位|拖动平移|长虚线|能力总线/)
  const wrappedTechnologies = () => page.locator('.architecture-boundary-heading span').evaluateAll(elements => elements.filter(element => element.getBoundingClientRect().height > 24).map(element => element.textContent))

  for (const current of views) {
    await view(current.name)
    assert.equal(await page.locator('.react-flow__node').count(), current.nodes)
    assert.equal(await page.locator('.react-flow__edge').count(), current.edges)
    await panel.getByRole('heading', { name: current.heading, exact: true }).waitFor()
    assert.ok(await scale() >= 85, '默认视口应保持文字可读')
    await noOverflow()
    // 横向长图在可读缩放下看不全，用小地图定位；全图适应后它应当让位。
    assert.equal(await page.locator('.react-flow__minimap').count(), 1, `${current.name}在可读缩放下看不全，应显示小地图`)
    await neutral('.react-flow__minimap')
    assert.equal(await page.locator('.react-flow__minimap-node').count(), current.nodes, '小地图应画出全部节点')
    assert.deepEqual(await wrappedTechnologies(), [], '容器标题的技术标识不应折行')
    const partialRows = await page.locator('.architecture-node[data-status="partial"]').evaluateAll(cards => cards.map(card => [...card.querySelectorAll('.architecture-features li')].map(row => ({
      status: row.dataset.status, top: row.getBoundingClientRect().top,
      dotRight: row.querySelector('svg').getBoundingClientRect().right,
      textRight: row.querySelector('span').getBoundingClientRect().right,
    }))))
    for (const rows of partialRows) {
      assert.deepEqual(rows.map(row => row.status), ['implemented', 'planned'], '混合状态应显示已完成与待完成能力')
      assert.ok(rows[1].top > rows[0].top, '具体能力应分行')
      for (const row of rows) assert.ok(row.dotRight > row.textRight, '状态点应位于行尾')
    }
    await screenshot(`横向-${current.id}-阅读.png`)
    await fitDiagram()
    const clippedLabels = await page.locator('.architecture-relationship > g[transform]').evaluateAll(groups => groups.flatMap(group => {
      const text = group.querySelector('text').getBBox()
      const mask = group.querySelector('rect').getBBox()
      return text.x < mask.x - 1 || text.x + text.width > mask.x + mask.width + 1 || text.height > mask.height ? [group.textContent] : []
    }))
    assert.deepEqual(clippedLabels, [], '标签遮罩应容纳实际字体')
    assert.equal(await page.locator('.react-flow__minimap').count(), 0, '全图可见时应收起小地图')
    await screenshot(`横向-${current.id}-全图.png`)
  }

  await view('总览')
  const minimapBox = await page.locator('.react-flow__minimap').boundingBox()
  const controlsBox = await page.locator('.canvas-controls').boundingBox()
  assert.ok(minimapBox.y + minimapBox.height <= controlsBox.y || minimapBox.x >= controlsBox.x + controlsBox.width, '小地图不应遮住缩放操作条')
  const stages = await page.locator('.react-flow__node[data-id="host"] .architecture-stage').evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect()
    return { label: element.textContent, x: box.x, y: box.y, right: box.right, bottom: box.bottom }
  }))
  assert.deepEqual(stages.map(stage => stage.label), ['接入与协议', '业务分发', '内核执行', '模型出口'], 'Host 应在标题下标出各阶段')
  for (const id of ['host.authentication', 'host.native', 'host.adapter', 'host.policy', 'host.api', 'host.services', 'host.runtime', 'host.provider']) {
    const card = await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox()
    for (const stage of stages) assert.ok(stage.bottom <= card.y || stage.right <= card.x || stage.x >= card.x + card.width, `阶段标题「${stage.label}」不应压住 ${id}`)
  }
  for (const id of ['host.services', 'host.runtime.capabilities', 'host.runtime', 'host.runtime.kernel', 'host.runtime.alternative']) {
    assert.equal(await page.locator(`.react-flow__node[data-id="${id}"]`).count(), 1, `${id} 应直接出现在总览中`)
  }
  const hostBox = await page.locator('.react-flow__node[data-id="host"]').boundingBox()
  const runnerBox = await page.locator('.react-flow__node[data-id="host.runtime"]').boundingBox()
  assert.ok(runnerBox.x > hostBox.x && runnerBox.x + runnerBox.width < hostBox.x + hostBox.width, 'KernelRunner 应位于 Host 大框内')
  for (const id of ['host.runtime.kernel', 'host.runtime.alternative', 'host.runtime.capabilities']) {
    const box = await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox()
    assert.ok(box.x > runnerBox.x && box.x + box.width < runnerBox.x + runnerBox.width && box.y > runnerBox.y && box.y + box.height < runnerBox.y + runnerBox.height, `${id} 应位于 KernelRunner 内`)
  }
  assert.equal(await page.locator('.react-flow__node[data-id="host.bundled"], .react-flow__node[data-id="host.security"]').count(), 0)
  assert.match(await page.locator('.react-flow__node[data-id="host.runtime"]').innerText(), /自带 Node 22/)
  assert.match(await page.locator('.architecture-boundary-note').innerText(), /权限模式.*OS 沙箱预留/)
  for (const id of ['host.services', 'host.runtime.capabilities']) {
    const box = await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox()
    assert.ok(box.x > hostBox.x && box.x + box.width < hostBox.x + hostBox.width && box.y > hostBox.y && box.y + box.height < hostBox.y + hostBox.height, `${id} 应留在 Host 大框内`)
  }
  const serviceBox = await page.locator('.react-flow__node[data-id="host.services"]').boundingBox()
  const capabilityBox = await page.locator('.react-flow__node[data-id="host.runtime.capabilities"]').boundingBox()
  assert.ok(Math.abs(serviceBox.y + serviceBox.height / 2 - runnerBox.y - runnerBox.height / 2) < 1, '服务层应与 KernelRunner 垂直中心对齐')
  const kernelBox = await page.locator('.react-flow__node[data-id="host.runtime.kernel"]').boundingBox()
  const alternativeBox = await page.locator('.react-flow__node[data-id="host.runtime.alternative"]').boundingBox()
  assert.ok(Math.abs(capabilityBox.y - kernelBox.y) < 1 && Math.abs(kernelBox.y - alternativeBox.y) < 1, '执行能力与两个内核应紧凑同排')
  const providerBox = await page.locator('.react-flow__node[data-id="host.provider"]').boundingBox()
  const modelsBox = await page.locator('.react-flow__node[data-id="models"]').boundingBox()
  assert.ok(Math.abs(serviceBox.y + serviceBox.height / 2 - providerBox.y - providerBox.height / 2) < 1
    && Math.abs(providerBox.y + providerBox.height / 2 - modelsBox.y - modelsBox.height / 2) < 1, '服务层、KernelRunner、模型适配与远端模型应同一条水平主线')
  assert.ok(runnerBox.x > serviceBox.x + serviceBox.width, 'KernelRunner 应紧随服务层之后')
  assert.ok(capabilityBox.x < kernelBox.x && kernelBox.x < alternativeBox.x, '执行能力、PiSdkKernel、其他内核应依次排列')
  assert.ok(modelsBox.x > hostBox.x + hostBox.width, '远端模型应留在 Host 大框外')
  assert.equal(await page.getByRole('group', { name: '架构视图', exact: true }).getByRole('button').count(), 3)
  await page.getByRole('list', { name: '连线图例', exact: true }).waitFor()
  for (const kind of ['configuration', 'assembly']) {
    const relationship = page.locator(`.architecture-relationship[data-kind="${kind}"]`)
    assert.equal(await relationship.count(), 0, '配置与装配通过能力说明块展示，不画连接线')
  }
  const dependency = page.locator('.architecture-relationship[data-line="dotted"]')
  assert.equal(await dependency.count(), 1, '消费方应直接以点线连接适配层')
  assert.equal(await dependency.locator('text').textContent(), '协议适配关系')
  assert.equal(await dependency.locator('path').getAttribute('stroke-dasharray'), '1 5')
  assert.equal(await dependency.locator('path').getAttribute('stroke-linecap'), 'round')
  assert.equal(await dependency.locator('path').getAttribute('marker-end'), 'url(#architecture-arrow-open)')
  await page.getByRole('button', { name: '查看网络入口', exact: true }).click()
  await panel.getByRole('button', { name: '展开接入链路', exact: true }).click()
  await panel.getByRole('heading', { name: '接入链路', exact: true }).waitFor()
  assert.equal(await page.locator('.react-flow__node[data-id="users"]').count(), 1)
  assert.equal(await page.locator('.architecture-node[data-status="planned"]').count(), 2)
  assert.equal(await page.locator('.architecture-relationship[data-planned="true"]').count(), 7)
  assert.equal(await page.locator('.architecture-relationship [aria-label="未实现关系"]').count(), 7, '未实现状态应独立显示为标签橙点')
  for (const path of await page.locator('.architecture-relationship[data-kind="call"][data-planned="true"] > path').all()) {
    assert.equal(await path.getAttribute('stroke-dasharray'), null, '未实现不能把调用流程变成装配虚线')
    assert.equal(await path.getAttribute('marker-end'), 'url(#architecture-arrow-normal)')
  }
  assert.equal(await page.locator('.architecture-relationship[data-bidirectional="true"]').count(), 16)
  assert.ok(await page.locator('[data-crossing="true"]').count() > 0, '多对多接线的交叉处应显示跨线留白')
  await fitDiagram()
  await page.getByRole('button', { name: '查看自定义协议适配', exact: true }).click()
  await panel.getByRole('heading', { name: '自定义协议适配', exact: true }).waitFor()
  await panel.getByText('未实现', { exact: true }).waitFor()
  await panel.getByRole('tab', { name: '来源', exact: true }).click()
  await panel.getByRole('link', { name: 'docs/计划/全局架构.md', exact: true }).waitFor()

  await view('总览')
  await fitDiagram()
  await page.getByRole('button', { name: '查看Host 服务层', exact: true }).click()
  await panel.getByRole('heading', { name: 'Host 服务层详情', exact: true }).waitFor()
  assert.equal(await page.locator('.react-flow__node').count(), 8)
  await fitDiagram()
  await noOverflow()
  await screenshot('服务层-详情.png')
  await page.getByRole('button', { name: '查看会话与任务', exact: true }).click()
  await panel.getByRole('heading', { name: '会话与任务', exact: true }).waitFor()
  assert.equal(await panel.getByRole('tab', { name: '来源', exact: true }).getAttribute('aria-selected'), 'true')
  for (const group of ['实现', '模块与架构', '验收']) await panel.getByRole('heading', { name: group, exact: true }).waitFor()
  const reviewLink = panel.getByRole('link', { name: 'docs/测试用例/会话与对话.md', exact: true })
  assert.match(await reviewLink.getAttribute('href'), /github\.com\/Leslie622\/Cogent\/blob\/main\/docs\//)
  await page.getByRole('button', { name: '返回总览', exact: true }).click()
  await fitDiagram()
  await page.getByRole('button', { name: '查看执行能力', exact: true }).click()
  await panel.getByRole('heading', { name: '执行能力详情', exact: true }).waitFor()
  assert.equal(await page.locator('.react-flow__node').count(), 7)
  assert.equal(await page.locator('.react-flow__edge').count(), 0, '能力详情应展示清单，不展示流程连线')
  await fitDiagram()
  await noOverflow()
  await screenshot('能力总线-详情.png')
  await page.getByRole('button', { name: '查看子会话', exact: true }).click()
  await panel.getByRole('heading', { name: '子会话', exact: true }).waitFor()
  await panel.getByText('未实现', { exact: true }).waitFor()
  await page.getByRole('button', { name: '返回总览', exact: true }).click()
  await view('执行')
  await fitDiagram()
  await page.getByRole('button', { name: '查看PiSdkKernel', exact: true }).click()
  await panel.getByRole('heading', { name: 'PiSdkKernel', exact: true }).waitFor()
  await panel.getByRole('tab', { name: '来源', exact: true }).click()
  await panel.getByText('src/host/kernel/pi-session-factory.ts', { exact: true }).waitFor()
  assert.equal(await page.locator('.architecture-node[data-selected="true"]').count(), 1)
  await screenshot('横向-模块源码.png')

  await fold('left', true)
  assert.equal((await page.locator('.architecture-canvas').boundingBox()).width, center.width + left.width)
  assert.equal(await page.getByRole('navigation', { name: '架构导航' }).count(), 0)
  await fold('right', true)
  assert.equal((await page.locator('.architecture-canvas').boundingBox()).width, 1600)
  assert.equal(await panel.count(), 0, '折叠面板应退出可访问树')
  await fold('right', false)
  await panel.getByRole('heading', { name: 'PiSdkKernel', exact: true }).waitFor()
  await fold('left', false)
  await reset()
  const beforeZoom = await scale()
  await page.getByRole('button', { name: '放大', exact: true }).click()
  assert.ok(await scale() > beforeZoom)
  await page.getByRole('button', { name: '缩小', exact: true }).click()
  await reset()
  const viewport = page.locator('.react-flow__viewport')
  const beforePan = await viewport.getAttribute('style')
  const pane = await page.locator('.architecture-canvas').boundingBox()
  await page.mouse.move(pane.x + 70, pane.y + 80)
  await page.mouse.down()
  await page.mouse.move(pane.x + 170, pane.y + 100, { steps: 10 })
  await page.mouse.up()
  assert.notEqual(await viewport.getAttribute('style'), beforePan)
  await reset()

  await page.getByRole('button', { name: '切换深色', exact: true }).click()
  await neutral('.architecture-sidebar')
  await neutral('.architecture-boundary')
  await fitDiagram()
  await screenshot('横向-深色.png')
  await page.reload()
  await page.getByRole('button', { name: '切换浅色', exact: true }).waitFor()
  assert.equal(await page.locator('html').evaluate(element => element.classList.contains('dark')), true)
  await page.getByRole('button', { name: '切换浅色', exact: true }).click()

  await page.setViewportSize({ width: 1600, height: 380 })
  const scrollable = page.locator('.module-panel-content')
  assert.equal(await scrollable.evaluate(element => element.scrollHeight > element.clientHeight), true)
  await scrollable.evaluate(element => { element.scrollTop = 100 })
  assert.ok(await scrollable.evaluate(element => element.scrollTop) > 0)
  assert.equal((await page.locator('.architecture-canvas').boundingBox()).y, 0)
  await noOverflow()

  for (const width of [1920, 1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    await reset()
    await noOverflow()
    const minimap = await page.locator('.react-flow__minimap').boundingBox()
    if (minimap !== null) {
      const canvas = await page.locator('.architecture-canvas').boundingBox()
      assert.ok(minimap.x >= canvas.x && minimap.x + minimap.width <= canvas.x + canvas.width, `${width}px 下小地图应留在画布内`)
    }
    await screenshot(`横向-宽度-${width}.png`)
    await fitDiagram()
    await noOverflow()
  }
  const mobileNode = page.getByRole('button', { name: '查看PiSdkKernel', exact: true })
  await mobileNode.click()
  const mobileHeading = panel.getByRole('heading', { name: 'PiSdkKernel', exact: true })
  await mobileHeading.waitFor()
  assert.equal(await mobileHeading.evaluate(node => document.activeElement === node), true)
  assert.equal((await page.locator('.architecture-canvas').boundingBox()).width, 390, '窄屏说明浮层不压缩画布')
  await page.keyboard.press('Escape')
  assert.equal(await panel.count(), 0)
  assert.equal(await mobileNode.evaluate(node => document.activeElement === node), true)
  await page.setViewportSize({ width: 1600, height: 1000 })
  await fold('left', false)
  await fold('right', false)
  await view('执行')
  await fitDiagram()
  await page.getByRole('button', { name: '查看Host 服务层', exact: true }).focus()
  await page.keyboard.press('Enter')
  await panel.getByRole('heading', { name: 'Host 服务层详情', exact: true }).waitFor()
  const detailHeading = page.getByRole('heading', { name: '服务层详情 · 目标架构', exact: true })
  assert.equal(await detailHeading.evaluate(node => document.activeElement === node), true)
  await page.getByRole('button', { name: '返回执行', exact: true }).click()
  const serviceOpener = page.getByRole('button', { name: '查看Host 服务层', exact: true })
  await serviceOpener.waitFor()
  await page.waitForFunction(() => document.activeElement?.closest('[data-id="host.services"]') !== null)
  assert.equal(await serviceOpener.evaluate(node => document.activeElement === node), true)

  await page.setViewportSize({ width: 2800, height: 1440 })
  await fold('left', true)
  await fold('right', true)
  await view('总览')
  await fitDiagram()
  await noOverflow()
  await screenshot('总览-完整架构.png')

  // 开发入口单独验证共享源码与字体的 Vite 路径权限，退出时关闭服务。
  const { createServer } = await import(pathToFileURL(require.resolve('vite')).href)
  devServer = await createServer({
    root: fileURLToPath(new URL('../docs/架构地图/', import.meta.url)),
    configFile: fileURLToPath(new URL('../docs/架构地图/vite.config.ts', import.meta.url)),
    server: { host: '127.0.0.1', port: 0 }, logLevel: 'warn',
  })
  await devServer.listen()
  const development = await context.newPage()
  development.on('pageerror', error => errors.push(error.message))
  development.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  development.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
  await development.goto(devServer.resolvedUrls.local[0])
  await development.locator('.react-flow__node[data-id="host.api"]').waitFor()
  await development.evaluate(() => document.fonts.ready)
  assert.equal(await development.getByRole('navigation', { name: '架构导航' }).getByRole('button').count(), 1)
  assert.deepEqual(errors, [])
  assert.deepEqual(requests, [], '离线 HTML 不应请求外部资源')
  console.log(JSON.stringify({ passed: true, views, widths: [1920, 1440, 1024, 390], checked: ['横向布局', '可读默认缩放', '全图适应', '原生与适配分支', '完成度与虚线', '小地图定位', '阶段标题行', '分组展开', '三栏与独立折叠', '右栏滚动', '节点与标签裁切', '源码说明', '缩放平移复位', '明暗持久化', '键盘', '离线资源', 'Vite 入口'], screenshots: fileURLToPath(output), errors, externalRequests: requests }, null, 2))
} finally {
  if (devServer) await devServer.close()
  await browser.close()
}
