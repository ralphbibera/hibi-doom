import { gunzipSync } from 'node:zlib'
import { gzipSync } from '../vendor/fflate/index.ts'

function safePath(path) {
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(`Unsafe source archive path: ${path}`)
  return path
}

export function readTarGz(compressed) {
  const input = gunzipSync(compressed, { maxOutputLength: 64 * 1024 * 1024 })
  const files = new Map()
  for (let offset = 0; offset <= input.length - 512; ) {
    const header = input.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const string = (start, length) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/s, '')
    const prefix = string(345, 155)
    const path = safePath((prefix ? `${prefix}/` : '') + string(0, 100))
    const size = Number.parseInt(string(124, 12).trim(), 8)
    const expected = Number.parseInt(string(148, 8).trim(), 8)
    let checksum = 0
    for (let index = 0; index < 512; index++)
      checksum += index >= 148 && index < 156 ? 32 : header[index]
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > 5 * 1024 * 1024 ||
      checksum !== expected ||
      ![0, 48].includes(header[156]) ||
      offset + 512 + size > input.length ||
      files.has(path)
    )
      throw new Error('Invalid preferred-source archive entry.')
    files.set(
      path,
      Buffer.from(input.subarray(offset + 512, offset + 512 + size)),
    )
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return files
}

export function tarGz(files, modes = {}) {
  const parts = []
  for (const [path, contents] of [...files].sort(([a], [b]) =>
    a.localeCompare(b, 'en'),
  )) {
    safePath(path)
    const header = Buffer.alloc(512)
    const split =
      path.length <= 100 ? -1 : path.lastIndexOf('/', path.length - 100)
    const name = split === -1 ? path : path.slice(split + 1)
    const prefix = split === -1 ? '' : path.slice(0, split)
    if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155)
      throw new Error('Source archive path exceeds USTAR limits.')
    header.write(name, 0, 100)
    header.write(prefix, 345, 155)
    const octal = (value, at, length) =>
      header.write(
        `${value.toString(8).padStart(length - 1, '0')}\0`,
        at,
        length,
      )
    octal(modes[path] ?? (path.endsWith('.sh') ? 0o755 : 0o644), 100, 8)
    octal(0, 108, 8)
    octal(0, 116, 8)
    octal(contents.length, 124, 12)
    octal(0, 136, 12)
    header.fill(32, 148, 156)
    header[156] = 48
    header.write('ustar\0', 257, 6)
    header.write('00', 263, 2)
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8)
    parts.push(
      header,
      contents,
      Buffer.alloc((512 - (contents.length % 512)) % 512),
    )
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.from(gzipSync(Buffer.concat(parts), { level: 9, mtime: 0 }))
}
