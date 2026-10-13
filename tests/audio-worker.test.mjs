import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAudioBank } from '../src/audio-bank.ts'
import { GameSession } from '../src/session.ts'
import { artifacts } from './fixtures/artifacts.mjs'
import { BrowserWorker } from './fixtures/node-worker.mjs'

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

test('original music and effect transitions arrive before the compiled guest finishes its wipe', {
  timeout: 30000,
}, async (t) => {
  const game = await artifacts()
  const bank = parseAudioBank(game.iwad)
  const e1m1 = [...bank.scores].find(([, score]) => score.name === 'D_E1M1')[0]
  const pistol = [...bank.samples].find(
    ([, sample]) => sample.name === 'DSPISTOL',
  )[0]
  const notices = []
  let operation = 'startup'
  const worker = new BrowserWorker()
  const session = new GameSession(worker, 15000, {
    audio: (audio) => notices.push({ operation, audio, at: performance.now() }),
  })
  t.after(async () => {
    session.dispose()
    worker.terminate()
    await worker.exited()
  })
  assert.equal(
    (
      await session.request({ kind: 'startup', ...game }, [
        game.engine.buffer,
        game.iwad.buffer,
      ])
    ).kind,
    'ready',
  )
  await session.request({ kind: 'activity', activity: 'running', epoch: 0 })
  let after = 0
  let wipe = null
  let shot = null
  const frame = async (taps = []) => {
    const before = performance.now()
    const priorNotices = notices.length
    const reply = await session.request({
      kind: 'frame',
      activity: 'running',
      epoch: 0,
      turn: 0,
      held: [],
      taps,
      after,
    })
    const repliedAt = performance.now()
    assert.equal(reply.kind, 'update')
    const music = notices
      .slice(priorNotices)
      .find(
        (notice) =>
          notice.audio.music.kind === 'playing' &&
          notice.audio.music.score === e1m1,
      )
    if (music && !wipe) wipe = { before, repliedAt, music, level: reply.update }
    const effect = notices
      .slice(priorNotices)
      .find((notice) =>
        notice.audio.voices.some((voice) => voice?.sample === pistol),
      )
    if (effect && !shot) shot = { effect, repliedAt }
    if (reply.update.kind === 'frame') after = reply.update.sequence
    return reply.update
  }
  const advance = async () => {
    const until = performance.now() + 220
    while (performance.now() < until) {
      await delay(16)
      await frame()
    }
  }
  do {
    await frame()
    await delay(16)
  } while (after === 0)
  await advance()
  for (let selection = 0; selection < 3; selection++) {
    await frame(['enter'])
    await advance()
  }
  operation = 'new-game'
  await frame(['enter'])
  await advance()
  assert.ok(
    wipe,
    JSON.stringify(
      notices.map((notice) => ({
        operation: notice.operation,
        music: notice.audio.music,
      })),
    ),
  )
  const { before, repliedAt, music, level } = wipe
  assert.ok(music.at >= before)
  assert.ok(
    repliedAt - music.at > 50,
    'The music transition must reach the receiver during the C wipe.',
  )
  assert.equal(level.audio.music.score, e1m1)
  assert.equal(level.audio.music.looping, true)
  assert.ok(level.gameTics > 0)
  await advance()
  operation = 'fire'
  await frame(['fire'])
  await advance()
  assert.ok(shot)
  const { effect } = shot
  assert.ok(effect.at < shot.repliedAt)
  const voice = effect.audio.voices.find((voice) => voice?.sample === pistol)
  assert.ok(
    Math.abs(voice.endsAt - voice.startedAt - 510.56689342403627) < 0.000001,
  )
  await session.request({ kind: 'activity', activity: 'paused', epoch: 1 })
  const paused = await session.request({
    kind: 'frame',
    activity: 'paused',
    epoch: 1,
    turn: 0,
    held: [],
    taps: [],
    after,
  })
  assert.equal(paused.update.kind, 'paused')
  assert.equal(paused.update.audio.epoch, 1)
  assert.equal(paused.update.audio.music.score, e1m1)
  session.dispose()
  assert.equal(await worker.exited(), -1)
})
