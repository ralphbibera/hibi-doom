import { deflateSync } from 'node:zlib'

export function ammoMask(pixels) {
  let mask = ''
  for (let y = 340; y < 374; y++)
    for (let x = 30; x < 90; x++) {
      const at = (y * 640 + x) * 4
      mask +=
        pixels[at] >= 80 &&
        pixels[at] > pixels[at + 1] * 2 &&
        pixels[at] > pixels[at + 2] * 2
          ? '1'
          : '0'
    }
  return mask
}

export async function canvasEvidence(element) {
  const { width, height, dataset } = element
  const pixels = element.getContext('2d').getImageData(0, 0, width, height).data
  const colors = new Set()
  let nonBlackPixels = 0
  let ammunition = ''
  const view = new Uint8Array(width * Math.min(280, height) * 4)
  view.set(pixels.subarray(0, view.length))
  for (let at = 0; at < pixels.length; at += 4) {
    if (pixels[at] || pixels[at + 1] || pixels[at + 2]) nonBlackPixels++
    if (colors.size < 512)
      colors.add((pixels[at] << 16) | (pixels[at + 1] << 8) | pixels[at + 2])
  }
  for (let y = 340; y < Math.min(374, height); y++)
    for (let x = 30; x < Math.min(90, width); x++) {
      const at = (y * width + x) * 4
      ammunition +=
        pixels[at] >= 80 &&
        pixels[at] > pixels[at + 1] * 2 &&
        pixels[at] > pixels[at + 2] * 2
          ? '1'
          : '0'
    }
  const digest = async (bytes) =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  return {
    width,
    height,
    sequence: Number(dataset.sequence ?? 0),
    gameTime: Number(dataset.gameTime ?? 0),
    nonBlackPixels,
    colors: colors.size,
    rgbaSha256: await digest(pixels),
    viewSha256: await digest(view),
    ammoSha256: await digest(new TextEncoder().encode(ammunition)),
  }
}
function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, bytes) {
  const name = Buffer.from(type)
  const result = Buffer.alloc(12 + bytes.length)
  result.writeUInt32BE(bytes.length)
  name.copy(result, 4)
  bytes.copy(result, 8)
  result.writeUInt32BE(crc32(Buffer.concat([name, bytes])), 8 + bytes.length)
  return result
}
export function encodePng(pixels) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(640)
  header.writeUInt32BE(400, 4)
  header[8] = 8
  header[9] = 6
  const rows = Buffer.alloc((640 * 4 + 1) * 400)
  for (let row = 0; row < 400; row++)
    Buffer.from(pixels.buffer, pixels.byteOffset + row * 640 * 4, 640 * 4).copy(
      rows,
      row * (640 * 4 + 1) + 1,
    )
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
