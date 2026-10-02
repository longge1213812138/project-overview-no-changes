#!/usr/bin/env node
/**
 * 生成 Fairy 应用图标：resources/icon.png（64x64，托盘/窗口用）与 resources/icon.ico（安装包用）。
 * 纯 Node 实现（zlib + 手工 PNG/ICO 编码），零依赖。
 * 用法：node scripts/make-icon.mjs
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'resources')

/* ---------- 1. 画像素画 ---------- */
const SIZE = 256
// 背景：圆角方形（靛蓝）
const BG = [79, 70, 229] // #4F46E5
const F_COLOR = [255, 255, 255]
const RADIUS = 48

// "F" 像素字模（8x8），每格 5px → 40x40，居中于 64
const GLYPH = [
  'XXXXXXX ',
  'XXXXXXX ',
  ' XX    ',
  ' XX    ',
  ' XXXX  ',
  ' XX    ',
  ' XX    ',
  ' XX    ',
]

function inRoundRect(x, y, s, r) {
  const rx = Math.min(x, s - 1 - x)
  const ry = Math.min(y, s - 1 - y)
  if (rx >= r || ry >= r) return true
  return (r - rx) ** 2 + (r - ry) ** 2 <= r ** 2
}

const pixels = new Uint8Array(SIZE * SIZE * 4)
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4
    if (!inRoundRect(x, y, SIZE, RADIUS)) {
      pixels[i + 3] = 0
      continue
    }
    pixels[i] = BG[0]
    pixels[i + 1] = BG[1]
    pixels[i + 2] = BG[2]
    pixels[i + 3] = 255

    // F 字模叠加（每格 5px，左上偏移 (12,12)）
    const cell = 24
    const ox = 44
    const oy = 32
    const gx = Math.floor((x - ox) / cell)
    const gy = Math.floor((y - oy) / cell)
    if (gx >= 0 && gy >= 0 && gx < 8 && gy < 8 && GLYPH[gy].trim().padEnd(8)[gx] === 'X') {
      pixels[i] = F_COLOR[0]
      pixels[i + 1] = F_COLOR[1]
      pixels[i + 2] = F_COLOR[2]
    }
  }
}

/* ---------- 2. PNG 编码 ---------- */
function crc32(buf) {
  let table = crc32.table
  if (!table) {
    table = crc32.table = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c >>> 0
    }
  }
  let c = 0xffffffff
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(
      raw,
      y * (size * 4 + 1) + 1
    )
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/* ---------- 3. ICO 封装（PNG 压缩条目）---------- */
function encodeIco(png) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(1, 4) // count
  const entry = Buffer.alloc(16)
  entry[0] = SIZE >= 256 ? 0 : SIZE // width
  entry[1] = SIZE >= 256 ? 0 : SIZE // height
  entry.writeUInt16LE(1, 4) // planes
  entry.writeUInt16LE(32, 6) // bpp
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(22, 12) // offset = 6 + 16
  return Buffer.concat([header, entry, png])
}

/* ---------- 4. 输出 ---------- */
mkdirSync(outDir, { recursive: true })
const png = encodePng(SIZE, pixels)
writeFileSync(join(outDir, 'icon.png'), png)
writeFileSync(join(outDir, 'icon.ico'), encodeIco(png))
console.log(`icon.png (${png.length}B) & icon.ico written to ${outDir}`)
