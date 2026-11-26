#!/usr/bin/env node
/**
 * 纯 Node PNG + ICO 图标生成器（零第三方原生依赖）。
 *
 * 为默认项目组或新项目组生成合规多分辨率图标资产：
 * - linux/{16x16,24x24,32x32,48x48,64x64,96x96,128x128,256x256,512x512}.png
 * - icon.png (512x512), tray.png (64x64)
 * - icon.ico / tray.ico（16/24/32/48/64 采用 32bpp BMP DIB 以兼容 NSIS makensis/rcedit，256 采用 PNG）
 *
 * 用法：node packaging/generate-icons.mjs [输出目录]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'

const LINUX_SIZES = [16, 24, 32, 48, 64, 96, 128, 256, 512]
const ICO_SIZES = [16, 24, 32, 48, 64, 256]

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(data.length, 0)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const stride = width * 4 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4)
  }
  const idat = deflateSync(raw, { level: 9 })
  return Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))])
}

/** 32bpp DIB 帧（兼容 NSIS makensis 与 Windows Explorer） */
function encodeBmpDibFrame(size, rgba) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8) // XOR + AND mask
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(0, 16) // BI_RGB

  const xorData = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    const srcRow = size - 1 - y
    for (let x = 0; x < size; x++) {
      const s = (srcRow * size + x) * 4
      const d = (y * size + x) * 4
      xorData[d] = rgba[s + 2] // B
      xorData[d + 1] = rgba[s + 1] // G
      xorData[d + 2] = rgba[s] // R
      xorData[d + 3] = rgba[s + 3] // A
    }
  }
  const andRowBytes = Math.ceil(size / 32) * 4
  const andMask = Buffer.alloc(andRowBytes * size)
  return Buffer.concat([header, xorData, andMask])
}

function encodeIco(frames) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // ICO
  header.writeUInt16LE(frames.length, 4)

  const dirEntries = []
  let offset = 6 + frames.length * 16
  for (const { size, data } of frames) {
    const entry = Buffer.alloc(16)
    entry[0] = size >= 256 ? 0 : size
    entry[1] = size >= 256 ? 0 : size
    entry[2] = 0
    entry[3] = 0
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    dirEntries.push(entry)
    offset += data.length
  }
  return Buffer.concat([header, ...dirEntries, ...frames.map((f) => f.data)])
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

function sdRoundedRect(px, py, half, radius) {
  const qx = Math.abs(px) - half + radius
  const qy = Math.abs(py) - half + radius
  const out = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  const inside = Math.min(Math.max(qx, qy), 0)
  return out + inside - radius
}

/** 渲染抗锯齿矢量风图标（4x 超采样） */
function renderBrandRgba(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const samples = size <= 32 ? 4 : 2
  const invSamples2 = 1 / (samples * samples)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let accR = 0
      let accG = 0
      let accB = 0
      let accA = 0

      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const u = ((x + (sx + 0.5) / samples) / size) * 2 - 1
          const v = ((y + (sy + 0.5) / samples) / size) * 2 - 1

          const bgDist = sdRoundedRect(u, v, 0.88, 0.24)
          const bgAlpha = 1 - smoothstep(-0.02, 0.02, bgDist)
          if (bgAlpha <= 0) continue

          // 薄荷-深墨科技渐变底板
          const grad = clamp01((u * 0.45 + v * 0.55 + 1) * 0.5)
          let r = 18 + grad * 14
          let g = 34 + grad * 38
          let b = 46 + grad * 42

          // 顶部微高光环
          const rim = smoothstep(-0.06, -0.015, bgDist) * (1 - smoothstep(-0.015, 0.01, bgDist))
          r += rim * 48
          g += rim * 96
          b += rim * 88

          // 中心几何 "C" 环与核心节点（象征 Agent 内核）
          const distCenter = Math.hypot(u, v)
          const ring = Math.abs(distCenter - 0.42) - 0.105
          const angle = Math.atan2(v, u) // [-pi, pi]
          const gap = Math.abs(angle) < 0.62 ? (0.62 - Math.abs(angle)) * 0.35 : -1
          const cDist = Math.max(ring, gap)
          const cAlpha = 1 - smoothstep(-0.025, 0.025, cDist)

          const dotDist = Math.hypot(u - 0.26, v) - 0.115
          const dotAlpha = 1 - smoothstep(-0.025, 0.025, dotDist)

          const fgAlpha = Math.max(cAlpha, dotAlpha)
          if (fgAlpha > 0) {
            const fgR = 232
            const fgG = 250
            const fgB = 244
            const accentR = 94
            const accentG = 234
            const accentB = 212
            const isDot = dotAlpha > cAlpha
            const tr = isDot ? accentR : fgR
            const tg = isDot ? accentG : fgG
            const tb = isDot ? accentB : fgB
            r = r * (1 - fgAlpha) + tr * fgAlpha
            g = g * (1 - fgAlpha) + tg * fgAlpha
            b = b * (1 - fgAlpha) + tb * fgAlpha
          }

          accR += r * bgAlpha
          accG += g * bgAlpha
          accB += b * bgAlpha
          accA += 255 * bgAlpha
        }
      }

      const idx = (y * size + x) * 4
      const totalA = accA * invSamples2
      if (totalA > 0) {
        rgba[idx] = Math.round(accR / (accA / 255))
        rgba[idx + 1] = Math.round(accG / (accA / 255))
        rgba[idx + 2] = Math.round(accB / (accA / 255))
        rgba[idx + 3] = Math.round(totalA)
      }
    }
  }
  return rgba
}

export function generateIconSet(targetDir) {
  const outDir = resolve(targetDir)
  const linuxDir = join(outDir, 'linux')
  mkdirSync(linuxDir, { recursive: true })

  const pngBySize = new Map()
  for (const size of LINUX_SIZES) {
    const rgba = renderBrandRgba(size)
    const png = encodePng(size, size, rgba)
    pngBySize.set(size, { rgba, png })
    writeFileSync(join(linuxDir, `${size}x${size}.png`), png)
  }

  writeFileSync(join(outDir, 'icon.png'), pngBySize.get(512).png)
  writeFileSync(join(outDir, 'tray.png'), pngBySize.get(64).png)

  const icoFrames = ICO_SIZES.map((size) => {
    const { rgba, png } = pngBySize.get(size)
    return {
      size,
      data: size >= 256 ? png : encodeBmpDibFrame(size, rgba)
    }
  })
  const icoBuffer = encodeIco(icoFrames)
  writeFileSync(join(outDir, 'icon.ico'), icoBuffer)
  writeFileSync(join(outDir, 'tray.ico'), icoBuffer)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const target = process.argv[2] ?? 'packaging/icons/cogent'
  generateIconSet(target)
  console.log(`[icons] 已生成图标集: ${resolve(target)}`)
}
