import assert from 'node:assert/strict'
import test from 'node:test'
import { ActiveClock } from '../src/clock.ts'
import { GameInput } from '../src/input.ts'
import {
  parseAudioNotice,
  parseFrameUpdate,
  parseWorkerCommand,
  parseWorkerReply,
} from '../src/model.ts'

const audio = {
  epoch: 0,
  revision: 0,
  at: 20,
  voices: Array.from({ length: 8 }, () => null),
  music: { kind: 'stopped' },
}

test('worker boundaries accept semantic input and reject malformed messages', () => {
  const request = {
    id: 4,
    kind: 'frame',
    activity: 'running',
    epoch: 0,
    turn: -200,
    held: ['forward', 'fire'],
    taps: ['enter'],
    after: 4,
  }
  assert.deepEqual(parseWorkerCommand(request), request)
  assert.deepEqual(
    parseWorkerReply({ id: 2, kind: 'activity', activity: 'paused', epoch: 0 }),
    {
      id: 2,
      kind: 'activity',
      activity: 'paused',
      epoch: 0,
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
    { turn: 2049 },
    { turn: -2049 },
    { turn: 0.5 },
    { turn: NaN },
    { epoch: -1 },
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
    gameTics: 0,
    audio,
  }
  assert.equal(parseFrameUpdate(frame).pixels, frame.pixels)
  assert.deepEqual(
    parseFrameUpdate({
      kind: 'paused',
      sequence: 3,
      elapsedMs: 40,
      gameTics: 0,
      audio,
    }),
    {
      kind: 'paused',
      sequence: 3,
      elapsedMs: 40,
      gameTics: 0,
      audio,
    },
  )
  for (const change of [
    { pixels: new Uint8Array(640 * 400 * 4 - 1) },
    { pixels: new Uint16Array(640 * 400 * 2) },
    { width: 320 },
    { sequence: NaN },
    { elapsedMs: -1 },
    { gameTics: -1 },
    { audio: { ...audio, voices: [] } },
    { extra: true },
  ])
    assert.throws(() => parseFrameUpdate({ ...frame, ...change }))
})

test('aliases hold one action and short released taps survive until the next frame', () => {
  const input = new GameInput()
  input.press('KeyW', false)
  input.press('ArrowUp', false)
  input.press('KeyW', true)
  assert.deepEqual(input.take(), {
    held: ['forward'],
    taps: ['forward'],
    turn: 0,
  })
  input.release('KeyW')
  assert.deepEqual(input.take(), { held: ['forward'], taps: [], turn: 0 })
  input.release('ArrowUp')
  input.press('Enter', false)
  input.release('Enter')
  assert.deepEqual(input.take(), { held: [], taps: ['enter'], turn: 0 })
  input.press('ShiftLeft', false)
  input.press('ShiftRight', false)
  input.release('ShiftLeft')
  assert.deepEqual(input.take(), { held: ['run'], taps: ['run'], turn: 0 })
  input.press('KeyF', false)
  input.release('KeyF')
  input.clear()
  assert.deepEqual(input.take(), { held: [], taps: [], turn: 0 })
  input.press('KeyF', false)
  assert.deepEqual(input.take(), { held: ['fire'], taps: ['fire'], turn: 0 })
})

test('audio notifications have no request identity and validate the complete bounded scene', () => {
  assert.deepEqual(parseAudioNotice({ kind: 'audio', audio }), {
    kind: 'audio',
    audio,
  })
  assert.equal(parseAudioNotice({ id: 1, kind: 'ready', engine: 'doom' }), null)
  assert.throws(
    () => parseAudioNotice({ id: 1, kind: 'audio', audio }),
    /fields/,
  )
  assert.throws(() =>
    parseAudioNotice({ kind: 'audio', audio: { ...audio, epoch: -1 } }),
  )
  assert.throws(() =>
    parseAudioNotice({
      kind: 'audio',
      audio: {
        ...audio,
        music: { kind: 'stream', url: 'https://example.com' },
      },
    }),
  )
  const voices = [...audio.voices]
  voices[0] = {
    channel: 0,
    generation: 1,
    sample: 20,
    startedAt: 0,
    endsAt: 1000,
    volume: 96,
    separation: 128,
  }
  assert.equal(
    parseAudioNotice({ kind: 'audio', audio: { ...audio, voices } }).audio
      .voices[0].sample,
    20,
  )
  for (const change of [
    { channel: 1 },
    { generation: 0 },
    { endsAt: 0 },
    { volume: 128 },
    { separation: 255 },
  ]) {
    const damaged = [...voices]
    damaged[0] = { ...voices[0], ...change }
    assert.throws(() =>
      parseAudioNotice({ kind: 'audio', audio: { ...audio, voices: damaged } }),
    )
  }
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
