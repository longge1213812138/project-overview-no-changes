#!/usr/bin/env node
/**
 * 生成托盘"会话异常"红图标：resources/icon-red.png（256x256 RGBA，与 icon.png 同尺寸）。
 * 读 resources/icon.png，非透明像素向红 tint（r 不变、g/b ×0.3），输出 icon-red.png。
 * 纯 Node 实现（zlib + 手工 PNG 编解码，与 make-icon.mjs 的编码器一致），零依赖。
 * 用法：node scripts/make-icon-red.mjs
 */
import { deflateSync, inflateSync } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const resDir = join(here, '..', 'resources')
const src = join(resDir, 'icon.png')
const out = join(resDir, 'icon-red.png')

/* ---------- 1. PNG 解码（8-bit RGBA；含 5 种 scanline filter） ---------- */
function decodePng(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是合法 PNG')
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  const bitDepth = buf[24]
  const colorType = buf[25]
  if (bitDepth !== 8 || colorType !== 6) throw new Error('仅支持 8-bit RGBA PNG')

  const idat = []
  let off = 8
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len))
    off += 12 + len
  }
  if (idat.length === 0) throw new Error('PNG 缺少 IDAT 块')
  const raw = inflateSync(Buffer.concat(idat))

  const stride = width * 4
  const rgba = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const rowIn = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const prevRow = y > 0 ? rgba.subarray((y - 1) * stride, y * stride) : null
    const curRow = rgba.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < stride; x++) {
      const rv = rowIn[x]
      const left = x >= 4 ? curRow[x - 4] : 0
      const up = prevRow ? prevRow[x] : 0
      const upLeft = x >= 4 && prevRow ? prevRow[x - 4] : 0
      let val
      switch (filter) {
        case 0:
          val = rv
          break
        case 1:
          val = rv + left
          break
        case 2:
          val = rv + up
          break
        case 3:
          val = rv + ((left + up) >> 1)
          break
        case 4: {
          const p = left + up - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - upLeft)
          val = rv + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)
          break
        }
        default:
          throw new Error(`未知 PNG filter: ${filter}`)
      }
      curRow[x] = val & 0xff
    }
  }
  return { width, height, rgba }
}

/* ---------- 2. 向红 tint：非透明像素 r 不变、g/b ×0.3 ---------- */
function tintRed(width, height, rgba) {
  const out = Buffer.from(rgba) // 拷贝，不动源
  for (let i = 0; i < out.length; i += 4) {
    const a = out[i + 3]
    if (a === 0) continue
    out[i + 1] = Math.round(out[i + 1] * 0.3)
    out[i + 2] = Math.round(out[i + 2] * 0.3)
  }
  return out
}

/* ---------- 3. PNG 编码（与 make-icon.mjs 相同） ---------- */
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

/* ---------- 4. 主流程 ---------- */
const { width, height, rgba } = decodePng(readFileSync(src))
if (width !== 256 || height !== 256) {
  console.error(`icon.png 尺寸不符：${width}x${height}（期望 256x256），请先跑 make-icon.mjs`)
  process.exit(1)
}
const png = encodePng(width, tintRed(width, height, rgba))
writeFileSync(out, png)
console.log(`icon-red.png (${png.length}B, ${width}x${height}) written to ${resDir}`)
