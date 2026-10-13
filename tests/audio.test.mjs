import assert from 'node:assert/strict'
import test from 'node:test'
import { fixtureIwad } from '../scripts/download-iwad.mjs'
import { stereoWeights } from '../src/audio.ts'
import { parseAudioBank, parseMus, parsePcm } from '../src/audio-bank.ts'
import {
  GameSound,
  musicPosition,
  parseAudioScene,
} from '../src/audio-scene.ts'
import { ScoreState } from '../src/music.ts'

function scoreBytes() {
  const events = [
    0x40, 0, 29, 0x40, 3, 100, 0x10, 0xbc, 80, 0xa0, 192, 0x81, 12, 0x00, 60,
    0x90, 62, 0x81, 12, 0x80, 62, 0, 0x60,
  ]
  const bytes = new Uint8Array(16 + events.length)
  bytes.set([77, 85, 83, 26])
  const view = new DataView(bytes.buffer)
  view.setUint16(4, events.length, true)
  view.setUint16(6, 16, true)
  view.setUint16(8, 1, true)
  bytes.set(events, 16)
  return bytes
}

test('DMX PCM keeps the original rate and trims sixteen samples at each end', () => {
  const bytes = new Uint8Array(72)
  const view = new DataView(bytes.buffer)
  view.setUint16(0, 3, true)
  view.setUint16(2, 11025, true)
  view.setUint32(4, 64, true)
  for (let index = 0; index < 64; index++) bytes[index + 8] = index
  const pcm = parsePcm(bytes)
  assert.equal(pcm.rate, 11025)
  assert.equal(pcm.bytes.length, 32)
  assert.deepEqual(Array.from(pcm.bytes.subarray(0, 4)), [16, 17, 18, 19])
  assert.deepEqual(Array.from(pcm.bytes.subarray(-4)), [44, 45, 46, 47])
  bytes.fill(0)
  assert.equal(pcm.bytes[0], 16)
  for (const mutate of [
    (view) => view.setUint16(0, 0, true),
    (view) => view.setUint16(2, 48000, true),
    (view) => view.setUint32(4, 1000, true),
    (view) => view.setUint32(4, 48, true),
  ]) {
    const damaged = new Uint8Array(72)
    const data = new DataView(damaged.buffer)
    data.setUint16(0, 3, true)
    data.setUint16(2, 11025, true)
    data.setUint32(4, 64, true)
    mutate(data)
    assert.throws(() => parsePcm(damaged))
  }
})

test('MUS retains cached velocity, 140Hz rhythm, controllers, pitch and score end', () => {
  const score = parseMus(scoreBytes())
  assert.deepEqual(score.events, [
    { kind: 'control', tick: 0, channel: 0, control: 0, value: 29 },
    { kind: 'control', tick: 0, channel: 0, control: 3, value: 100 },
    { kind: 'on', tick: 0, channel: 0, key: 60, velocity: 80 },
    { kind: 'pitch', tick: 0, channel: 0, bend: 1 },
    { kind: 'off', tick: 140, channel: 0, key: 60 },
    { kind: 'on', tick: 140, channel: 0, key: 62, velocity: 80 },
    { kind: 'off', tick: 280, channel: 0, key: 62 },
  ])
  assert.equal(score.durationTicks, 280)
  assert.equal(score.durationMs, 2000)
  assert.throws(
    () => parseMus(scoreBytes().subarray(0, -1)),
    /extent|score-end|Truncated/,
  )
  const malformed = scoreBytes()
  malformed[16] = 0x50
  assert.throws(() => parseMus(malformed), /Unknown/)
})

test('restored score state retains program, pitch, pan and sustained notes', () => {
  const state = new ScoreState()
  const control = (control, value) =>
    state.apply({ kind: 'control', channel: 0, tick: 0, control, value })
  control(0, 29)
  control(3, 100)
  control(4, 20)
  control(5, 64)
  state.apply({ kind: 'pitch', channel: 0, tick: 0, bend: 1 })
  control(8, 127)
  state.apply({ kind: 'on', tick: 0, channel: 0, key: 60, velocity: 80 })
  state.apply({ kind: 'off', tick: 140, channel: 0, key: 60 })
  assert.deepEqual(state.notes.get(60), {
    id: 60,
    channel: 0,
    key: 60,
    velocity: 80,
    program: 29,
    tick: 0,
    released: true,
  })
  assert.deepEqual(state.channels[0], {
    program: 29,
    bank: 0,
    volume: 100,
    expression: 64,
    pan: 20,
    bend: 1,
    modulation: 0,
    sustain: true,
    soft: false,
  })
  assert.deepEqual(control(8, 0), { kind: 'release', ids: [60] })
  assert.equal(state.notes.size, 0)
  state.apply({ kind: 'on', tick: 200, channel: 0, key: 62, velocity: 70 })
  assert.deepEqual(control(10, 0), { kind: 'kill', ids: [62] })
  assert.equal(state.notes.size, 0)
})

test('the verified IWAD supplies original episode scores and trimmed effects', async () => {
  const bank = parseAudioBank(await fixtureIwad())
  const pistol = [...bank.samples.values()].find(
    (sample) => sample.name === 'DSPISTOL',
  )
  const e1m1 = [...bank.scores.values()].find(
    (score) => score.name === 'D_E1M1',
  )
  const e1m3 = [...bank.scores.values()].find(
    (score) => score.name === 'D_E1M3',
  )
  assert.equal(pistol.rate, 11025)
  assert.equal(pistol.bytes.length, 5629)
  assert.equal(e1m1.durationMs, 96000)
  assert.equal(e1m3.durationMs, 272000)
  assert.equal(e1m1.events.filter((event) => event.kind === 'on').length, 2332)
  assert.equal(e1m1.events.filter((event) => event.kind === 'off').length, 2332)
  assert.equal(bank.instruments.length, 175)
})

function bank() {
  return {
    samples: new Map([
      [
        0,
        {
          name: 'test',
          rate: 11025,
          bytes: new Uint8Array(11025),
          durationMs: 1000,
        },
      ],
    ]),
    scores: new Map([[1, parseMus(scoreBytes())]]),
    instruments: [],
  }
}

test('sound scenes publish transitions synchronously, replace generations and coalesce parameters', () => {
  let at = 0
  const notices = []
  const sound = new GameSound(
    bank(),
    () => at,
    (scene) => notices.push(scene),
  )
  sound.beginStep()
  sound.setEpoch(7)
  assert.equal(sound.start(0, 0, 96, 128), 0)
  assert.deepEqual(notices[0].voices[0], {
    channel: 0,
    generation: 1,
    sample: 0,
    startedAt: 0,
    endsAt: 1000,
    volume: 96,
    separation: 128,
  })
  assert.equal(notices[0].epoch, 7)
  for (let volume = 0; volume <= 127; volume++) sound.update(0, volume, 20)
  assert.equal(notices.length, 1)
  assert.equal(sound.scene().voices[0].volume, 127)
  assert.equal(notices[0].voices[0].volume, 96)
  at = 100
  sound.start(0, 0, 80, 40)
  assert.equal(notices[1].voices[0].generation, 2)
  assert.equal(notices[1].voices[0].endsAt, 1100)
  at = 1099
  assert.equal(sound.playing(0), 1)
  at = 1100
  assert.equal(sound.playing(0), 0)
  assert.equal(sound.scene().voices[0], null)
  assert.throws(() => sound.start(8, 0, 127, 0), /channel/)
  assert.throws(() => sound.start(0, 3, 127, 0), /unknown PCM/)
  const valid = parseAudioScene(sound.scene())
  assert.equal(valid.voices.length, 8)
  assert.throws(() => parseAudioScene({ ...valid, voices: [null] }), /channels/)
})

test('music pause position, resume, loop identity and unregister are explicit', () => {
  let at = 100
  const notices = []
  const sound = new GameSound(
    bank(),
    () => at,
    (scene) => notices.push(scene),
  )
  sound.beginStep()
  const handle = sound.register(scoreBytes())
  sound.volume(80)
  sound.playMusic(handle, 1)
  assert.deepEqual(sound.scene().music, {
    kind: 'playing',
    generation: 1,
    score: 1,
    anchorAt: 100,
    offsetMs: 0,
    looping: true,
    volume: 80,
  })
  at = 800
  sound.pauseMusic()
  assert.equal(musicPosition(sound.scene().music, 100000), 700)
  at = 1000
  sound.resumeMusic()
  assert.equal(musicPosition(sound.scene().music, 1200), 900)
  sound.playMusic(handle, 1)
  assert.equal(sound.scene().music.generation, 2)
  sound.unregister(handle)
  assert.deepEqual(sound.scene().music, { kind: 'stopped' })
  assert.equal(notices.length, 5)
  assert.throws(() => sound.playMusic(handle, 1), /playback/)
})

test('the finite transition budget fails explicitly instead of dropping notices', () => {
  let count = 0
  const sound = new GameSound(
    bank(),
    () => 0,
    () => {
      count++
    },
  )
  sound.beginStep()
  for (let index = 0; index < 256; index++) sound.start(0, 0, 127, 128)
  assert.equal(count, 256)
  assert.throws(() => sound.start(0, 0, 127, 128), /notification budget/)
  assert.equal(count, 256)
  sound.beginStep()
  sound.stop(0)
  assert.equal(count, 257)
})

test('effects use the original two SDL gain weights', () => {
  assert.deepEqual(stereoWeights(127, 0), { left: 254 / 255, right: 0 })
  assert.deepEqual(stereoWeights(127, 128), {
    left: 126 / 255,
    right: 128 / 255,
  })
  assert.deepEqual(stereoWeights(96, 20), { left: 176 / 255, right: 15 / 255 })
  assert.deepEqual(stereoWeights(127, 254), { left: 0, right: 254 / 255 })
})
