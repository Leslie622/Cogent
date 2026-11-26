/**
 * 打包配置 Schema、项目组切换与依赖闭包审计回归测试。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadPackConfig,
  parsePackConfig,
  resolveSelectedProjects,
  validateProjectIcons
} from '../../../packaging/config-schema.mjs'
import {
  REQUIRED_MAIN_ENTRIES,
  collectRuntimeClosure,
  packageNameFromSpecifier,
  scanMainExternalImports,
  verifyUnpackedBundle
} from '../../../packaging/runtime-closure.mjs'

const repoRoot = resolve(import.meta.dirname, '../../..')
const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('pack.config.json 与项目组配置解析', () => {
  it('仓库默认 packaging/pack.config.json 通过校验并可解析默认项目组', () => {
    const config = loadPackConfig(join(repoRoot, 'packaging', 'pack.config.json'))
    const selected = resolveSelectedProjects(config)
    expect(selected.map(([key]) => key)).toEqual(['cogent'])
    expect(selected[0][1].id).toBe('com.cogent.desktop')
    expect(selected[0][1].name).toBe('Cogent')
  })

  it('支持多项目组切换与 all 批量选择，并拦截未知项目组和非法配置', () => {
    const base = loadPackConfig(join(repoRoot, 'packaging', 'pack.config.json'))
    const multi = parsePackConfig({
      ...base,
      active: 'all',
      projects: {
        ...base.projects,
        teamA: {
          ...base.projects.cogent,
          id: 'com.example.teama',
          name: '项目A助手',
          executableName: 'team-a',
          debPackageName: 'team-a',
          storageDirName: '.teama'
        }
      }
    })
    expect(resolveSelectedProjects(multi).map(([k]) => k)).toEqual(['cogent', 'teamA'])
    expect(resolveSelectedProjects(multi, ['teamA']).map(([, v]) => v.name)).toEqual(['项目A助手'])
    expect(() => resolveSelectedProjects(multi, ['nonexistent'])).toThrow('未知项目组')

    expect(() =>
      parsePackConfig({
        ...base,
        projects: {
          bad: {
            ...base.projects.cogent,
            debPackageName: 'INVALID_UPPERCASE'
          }
        }
      })
    ).toThrow()

    expect(() =>
      parsePackConfig({
        ...base,
        projects: {
          bad: {
            ...base.projects.cogent,
            storageDirName: '../escape'
          }
        }
      })
    ).toThrow()
  })

  it('图标目录校验：默认图标集完整通过，缺件立即报错', () => {
    expect(() =>
      validateProjectIcons(join(repoRoot, 'packaging', 'icons', 'cogent'), { windows: true, linux: true })
    ).not.toThrow()

    const emptyIcons = makeTempDir('cogent-empty-icons-')
    expect(() => validateProjectIcons(emptyIcons, { windows: true, linux: true })).toThrow('缺少必需图标文件')
  })
})

describe('AST 外部导入扫描与白名单闭包审计', () => {
  it('正确识别包名并过滤 node 内建模块、相对路径与 electron', () => {
    expect(packageNameFromSpecifier('./chunks/a.js')).toBeNull()
    expect(packageNameFromSpecifier('node:sqlite')).toBeNull()
    expect(packageNameFromSpecifier('fs')).toBeNull()
    expect(packageNameFromSpecifier('electron')).toBeNull()
    expect(packageNameFromSpecifier('@earendil-works/pi-ai/dist/index.js')).toBe('@earendil-works/pi-ai')
    expect(packageNameFromSpecifier('pdfjs-dist/legacy/build/pdf.mjs')).toBe('pdfjs-dist')
  })

  it('AST 扫描不被字符串字面量里的 import 字样误导', () => {
    const dir = makeTempDir('cogent-scan-')
    writeFileSync(
      join(dir, 'sample.js'),
      `
      import x from '@earendil-works/pi-ai'
      import { join } from 'node:path'
      const fake = "from 'not-a-real-package' import('also-fake')"
      const ignored = Promise.resolve('aborted')
      const p = createRequire(import.meta.url).resolve('pdfjs-dist/package.json')
      const u = import.meta.resolve('@earendil-works/pi-coding-agent')
      export { x, fake, ignored, p, u, join }
      `
    )
    expect(scanMainExternalImports(dir)).toEqual([
      '@earendil-works/pi-ai',
      '@earendil-works/pi-coding-agent',
      'pdfjs-dist'
    ])
  })

  it('真实项目闭包收口排除纯前端包和 @napi-rs/canvas', () => {
    const closure = collectRuntimeClosure({
      rootPackages: ['@earendil-works/pi-ai', 'pdfjs-dist', 'exceljs'],
      projectRoot: repoRoot,
      excludeOptional: ['@napi-rs/canvas', '@napi-rs/canvas-*']
    })
    const names = new Set(closure.map((item) => item.name))
    expect(names.has('@earendil-works/pi-ai')).toBe(true)
    expect(names.has('pdfjs-dist')).toBe(true)
    expect(names.has('exceljs')).toBe(true)
    expect(names.has('@napi-rs/canvas')).toBe(false)
    expect(names.has('react')).toBe(false)
    expect(names.has('mermaid')).toBe(false)
  })

  it('verifyUnpackedBundle 对缺失入口、泄漏禁用包或非目标平台原生目录 fail-closed', () => {
    const resourcesDir = makeTempDir('cogent-audit-')
    const unpackedMain = join(resourcesDir, 'app.asar.unpacked', 'out', 'main')
    const unpackedMods = join(resourcesDir, 'app.asar.unpacked', 'node_modules')
    mkdirSync(unpackedMain, { recursive: true })
    for (const entry of REQUIRED_MAIN_ENTRIES) writeFileSync(join(unpackedMain, entry), '')

    for (const pkg of ['@earendil-works/pi-ai', 'pdfjs-dist', 'quickjs-wasi', '@silvia-odwyer/photon-node']) {
      mkdirSync(join(unpackedMods, pkg), { recursive: true })
      writeFileSync(join(unpackedMods, pkg, 'package.json'), '{}')
    }
    mkdirSync(join(unpackedMods, 'pdfjs-dist', 'cmaps'), { recursive: true })
    mkdirSync(join(unpackedMods, 'pdfjs-dist', 'standard_fonts'), { recursive: true })
    mkdirSync(join(unpackedMods, 'pdfjs-dist', 'wasm'), { recursive: true })
    writeFileSync(join(unpackedMods, 'quickjs-wasi', 'quickjs.wasm'), 'wasm')
    writeFileSync(join(unpackedMods, '@silvia-odwyer/photon-node', 'photon_rs_bg.wasm'), 'wasm')
    mkdirSync(join(resourcesDir, 'runtime', 'win-x64', 'bin'), { recursive: true })
    writeFileSync(join(resourcesDir, 'runtime', 'win-x64', 'bin', 'node.exe'), 'exe')
    writeFileSync(join(resourcesDir, 'runtime', 'win-x64', 'runtime.json'), '{}')

    expect(() =>
      verifyUnpackedBundle({
        resourcesDir,
        requiredExternalPackages: ['@earendil-works/pi-ai', 'pdfjs-dist'],
        targetPlatformKey: 'win32-x64',
        runtimePlatformDir: 'win-x64'
      })
    ).not.toThrow()

    // 注入禁用包 react → 必须报错拦截
    mkdirSync(join(unpackedMods, 'react'), { recursive: true })
    expect(() =>
      verifyUnpackedBundle({
        resourcesDir,
        requiredExternalPackages: ['@earendil-works/pi-ai'],
        targetPlatformKey: 'win32-x64',
        runtimePlatformDir: 'win-x64'
      })
    ).toThrow('禁用包: react')
  })
})
