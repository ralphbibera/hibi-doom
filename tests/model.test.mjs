import assert from 'node:assert/strict'
import test from 'node:test'
import { ActiveClock } from '../src/clock.ts'
import { GameInput } from '../src/input.ts'
import {
  parseFrameUpdate,
  parseWorkerCommand,
  parseWorkerReply,
} from '../src/model.ts'

test('worker boundaries accept semantic input and reject malformed messages', () => {
  const request = {
    id: 4,
    kind: 'frame',
    activity: 'running',
    held: ['forward', 'fire'],
    taps: ['enter'],
    after: 4,
  }
  assert.deepEqual(parseWorkerCommand(request), request)
  assert.deepEqual(
    parseWorkerReply({ id: 2, kind: 'activity', activity: 'paused' }),
    {
      id: 2,
      kind: 'activity',
      activity: 'paused',
    },
  )
  for (const change of [
    { id: 0 },
    { activity: 'background' },
    { held: ['fire', 'fire'] },
    { taps: ['shell'] },
    { held: 'forward' },
    { after: -1 },
    { after: 0.5 },
    { after: Infinity },
    { wasmPath: '/tmp/other.wasm' },
  ])
    assert.throws(() => parseWorkerCommand({ ...request, ...change }))
  for (const payload of [null, [], { id: 1, kind: 'exec' }])
    assert.throws(() => parseWorkerCommand(payload))
  for (const payload of [
    { id: 1, kind: 'ready', engine: 'arbitrary' },
    { id: 1, kind: 'activity', activity: 'background' },
    { id: 1, kind: 'update', update: { kind: 'busy' } },
    { id: 1, kind: 'error', message: '' },
  ])
    assert.throws(() => parseWorkerReply(payload))
})

test('RGBA replies require the exact frame extent and integer cursors', () => {
  const frame = {
    kind: 'frame',
    width: 640,
    height: 400,
    pixels: new Uint8Array(640 * 400 * 4),
    sequence: 1,
    elapsedMs: 20,
  }
  assert.equal(parseFrameUpdate(frame).pixels, frame.pixels)
  assert.deepEqual(
    parseFrameUpdate({ kind: 'paused', sequence: 3, elapsedMs: 40 }),
    {
      kind: 'paused',
      sequence: 3,
      elapsedMs: 40,
    },
  )
  for (const change of [
    { pixels: new Uint8Array(640 * 400 * 4 - 1) },
    { pixels: new Uint16Array(640 * 400 * 2) },
    { width: 320 },
    { sequence: NaN },
    { elapsedMs: -1 },
    { extra: true },
  ])
    assert.throws(() => parseFrameUpdate({ ...frame, ...change }))
})

test('aliases hold one action and short released taps survive until the next frame', () => {
  const input = new GameInput()
  input.press('KeyW', false)
  input.press('ArrowUp', false)
  input.press('KeyW', true)
  assert.deepEqual(input.take(), { held: ['forward'], taps: ['forward'] })
  input.release('KeyW')
  assert.deepEqual(input.take(), { held: ['forward'], taps: [] })
  input.release('ArrowUp')
  input.press('Enter', false)
  input.release('Enter')
  assert.deepEqual(input.take(), { held: [], taps: ['enter'] })
  input.press('ShiftLeft', false)
  input.press('ShiftRight', false)
  input.release('ShiftLeft')
  assert.deepEqual(input.take(), { held: ['run'], taps: ['run'] })
  input.press('KeyF', false)
  input.release('KeyF')
  input.clear()
  assert.deepEqual(input.take(), { held: [], taps: [] })
  input.press('KeyF', false)
  assert.deepEqual(input.take(), { held: ['fire'], taps: ['fire'] })
})

test('the active clock advances during work and excludes paused wall time', () => {
  let now = 100
  const clock = new ActiveClock(() => now)
  clock.set('running')
  now = 150
  assert.equal(clock.read(), 50)
  assert.equal(clock.read(), 50)
  clock.set('running')
  now = 200
  clock.set('paused')
  assert.equal(clock.read(), 100)
  now = 10000
  clock.set('paused')
  assert.equal(clock.read(), 100)
  clock.set('running')
  now = 10015.75
  assert.equal(clock.read(), 115.75)
  clock.set('paused')
  assert.equal(clock.read(), 115.75)
})
