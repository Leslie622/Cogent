import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'
const mock = vi.hoisted(() => ({ profile: '' }))
vi.mock('electron', () => ({ app: { getPath: () => mock.profile }, protocol: { registerSchemesAsPrivileged: vi.fn() } }))
import { BrowserLocalPreview } from '../../../../src/electron/main/browser/local-preview'
import { createPreviewPolicy, checkPreviewResource } from '../../../../src/electron/main/file-views/preview-policy'

let root = '', oldRoot: string | undefined
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cogent-preview-test-')); oldRoot = process.env.COGENT_HOME
  process.env.COGENT_HOME = join(root, 'home'); mock.profile = join(root, 'profile')
  mkdirSync(process.env.COGENT_HOME); mkdirSync(mock.profile)
})
afterEach(() => { if (oldRoot === undefined) delete process.env.COGENT_HOME; else process.env.COGENT_HOME = oldRoot; rmSync(root, { recursive: true, force: true }) })
describe('网页预览的文件授权', () => {
  it('delivery原件删除后仍只读frozen provider，拒绝隐藏凭据请求', async () => {
    const handlers = new Map<string, (request: Request) => Promise<Response>>()
    const preview = new BrowserLocalPreview()
    preview.install({ protocol: { handle: (scheme: string, handler: (request: Request) => Promise<Response>) => handlers.set(scheme, handler) } } as unknown as Session)
    const read = vi.fn().mockResolvedValue({ bytes: new TextEncoder().encode('<p>frozen</p>'), mime: 'text/html' })
    const release = vi.fn().mockResolvedValue(undefined)
    const url = await preview.authorizeSource('owner', { kind: 'delivery', path: join(root, 'deleted-original', 'report.html'), readResource: read, release })
    const response = await handlers.get('cogent-preview')!(new Request(url))
    expect(await response.text()).toBe('<p>frozen</p>')
    expect(read).toHaveBeenCalledWith('')
    expect((await handlers.get('cogent-preview')!(new Request(new URL('.env', url)))).status).toBe(403)
    preview.revoke('owner'); await Promise.resolve()
    expect(release).toHaveBeenCalledOnce()
  })
  it('current HTML不能把应用设置/凭据目录授权成网页静态目录', async () => {
    const path = join(process.env.COGENT_HOME!, 'report.html'); writeFileSync(path, '<p>html</p>')
    const preview = new BrowserLocalPreview()
    await expect(preview.authorizeSource('owner', { kind: 'current', path, readResource: vi.fn(), release: vi.fn() })).rejects.toThrow('应用数据')
  })
  it('HTML在保护目录之外，其后代userData/COGENT_HOME及指向保护目录的junction仍不可读取', async () => {
    const path = join(root, 'report.html'); writeFileSync(path, '<p>outside</p>')
    writeFileSync(join(mock.profile, 'Preferences'), 'private-profile'); writeFileSync(join(process.env.COGENT_HOME!, 'normal.txt'), 'private-home')
    symlinkSync(mock.profile, join(root, 'assets'), 'junction')
    const handlers = new Map<string, (request: Request) => Promise<Response>>(), preview = new BrowserLocalPreview()
    preview.install({ protocol: { handle: (scheme: string, handler: (request: Request) => Promise<Response>) => handlers.set(scheme, handler) } } as unknown as Session)
    const read = vi.fn().mockResolvedValue({ bytes: new Uint8Array(), mime: 'text/plain' })
    const url = await preview.authorizeSource('owner', { kind: 'current', path, readResource: read, release: vi.fn() })
    for (const resource of ['profile/Preferences', 'home/normal.txt', 'assets/Preferences', 'id_rsa', 'id_ed25519']) expect((await handlers.get('cogent-preview')!(new Request(new URL(resource, url)))).status).toBeGreaterThanOrEqual(400)
    expect(read).not.toHaveBeenCalled()
  })
  it('显式较大根保留HTML相对入口，../assets正确落到已选根而不是HTML目录', async () => {
    const site = join(root, 'site'); mkdirSync(join(site, 'pages'), { recursive: true }); mkdirSync(join(site, 'assets'))
    const path = join(site, 'pages', 'index.html'); writeFileSync(path, '<script src="../assets/app.js"></script>'); writeFileSync(join(site, 'assets', 'app.js'), 'public-script')
    const current = await createPreviewPolicy(path, site)
    const read = vi.fn().mockResolvedValue({ bytes: new TextEncoder().encode('public-script'), mime: 'text/javascript' })
    const handlers = new Map<string, (request: Request) => Promise<Response>>(), preview = new BrowserLocalPreview()
    preview.install({ protocol: { handle: (scheme: string, handler: (request: Request) => Promise<Response>) => handlers.set(scheme, handler) } } as unknown as Session)
    const url = await preview.authorizeSource('owner', { kind: 'current', ...current, readResource: read, release: vi.fn() })
    expect(new URL(url).pathname).toBe('/pages/index.html')
    expect(await (await handlers.get('cogent-preview')!(new Request(new URL('../assets/app.js', url)))).text()).toBe('public-script')
    expect(read).toHaveBeenCalledWith('assets/app.js')
  })
  it('所选根junction换目标、无关目录和文件系统根均不获得授权', async () => {
    const first = join(root, 'first'), second = join(root, 'second'), link = join(root, 'link')
    mkdirSync(first); mkdirSync(second); const path = join(first, 'index.html'); writeFileSync(path, 'html')
    symlinkSync(first, link, 'junction'); const current = await createPreviewPolicy(path, link)
    unlinkSync(link); symlinkSync(second, link, 'junction')
    await expect(checkPreviewResource(current.policy, 'index.html')).rejects.toThrow('根已变化')
    await expect(createPreviewPolicy(path, second)).rejects.toThrow('包含')
    await expect(createPreviewPolicy(path, parse(path).root)).rejects.toThrow('根目录')
  })
  it('默认根和显式根都不能借相对路径剥掉.ssh等敏感祖先目录', async () => {
    const hidden = join(root, '.ssh'), nested = join(hidden, 'nested'); mkdirSync(nested, { recursive: true })
    const path = join(nested, 'index.html'); writeFileSync(path, 'private-html')
    await expect(createPreviewPolicy(path)).rejects.toThrow('敏感目录')
    await expect(createPreviewPolicy(path, hidden)).rejects.toThrow('敏感目录')
    await expect(checkPreviewResource({ root: { path: nested, realPath: nested }, blockedRoots: [] }, 'index.html')).rejects.toThrow('敏感')
  })
})
