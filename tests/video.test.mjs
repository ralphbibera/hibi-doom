import assert from 'node:assert/strict'
import test from 'node:test'
import { fixtureIwad } from '../scripts/download-iwad.mjs'
import { createWasiHost } from '../src/wasi.ts'

test('completed indexed draws own their palette and duplicate exact RGBA pixels', async () => {
  const memory = new ArrayBuffer(66000)
  const bytes = new Uint8Array(memory)
  const host = createWasiHost(
    await fixtureIwad(),
    () => memory,
    () => 0,
  )
  const paletteAt = 64000
  bytes[0] = 1
  bytes[319] = 2
  bytes[320] = 3
  bytes[63999] = 4
  bytes.set(
    [2, 4, 8, 11, 12, 13, 21, 22, 23, 31, 32, 33, 41, 42, 43],
    paletteAt,
  )
  host.imports.hibi.draw_indexed(0, paletteAt)
  bytes.fill(0)
  const frame = host.frame()
  assert.deepEqual([frame.width, frame.height, frame.sequence], [640, 400, 1])
  const pixel = (x, y) =>
    Array.from(frame.pixels.subarray((y * 640 + x) * 4, (y * 640 + x + 1) * 4))
  assert.deepEqual(pixel(0, 0), [11, 12, 13, 255])
  assert.deepEqual(pixel(1, 1), [11, 12, 13, 255])
  assert.deepEqual(pixel(2, 0), [2, 4, 8, 255])
  assert.deepEqual(pixel(639, 1), [21, 22, 23, 255])
  assert.deepEqual(pixel(0, 2), [31, 32, 33, 255])
  assert.deepEqual(pixel(639, 399), [41, 42, 43, 255])
  assert.equal(host.frame(1), null)
  bytes.set([9, 10, 11], paletteAt)
  host.imports.hibi.draw_indexed(0, paletteAt)
  assert.deepEqual(
    Array.from(host.frame(1).pixels.subarray(0, 4)),
    [9, 10, 11, 255],
  )
  assert.deepEqual(pixel(0, 0), [11, 12, 13, 255])
  assert.throws(() => host.imports.hibi.draw_indexed(3000, paletteAt), /extent/)
  assert.equal(host.sequence, 2)
})
