import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { boot } from '../src/doom-vm.ts'
import { GameSession } from '../src/session.ts'
import { artifacts } from './fixtures/artifacts.mjs'
import { BrowserWorker } from './fixtures/node-worker.mjs'
import { reference } from './fixtures/reference.mjs'
import { ammoMask, encodePng } from './pixels.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

test('the worker exit observer is passive and its cleanup is explicit', {
  timeout: 5000,
}, async (t) => {
  const worker = new BrowserWorker({ mode: 'silent' })
  t.after(async () => {
    worker.terminate()
    await worker.exited()
  })
  await assert.rejects(worker.exited(50), /did not exit/)
  assert.equal(worker.termination, null)
  assert.ok(worker.worker.threadId > 0)
  worker.terminate()
  assert.equal(await worker.exited(), -1)
})

test('the receive boundary rejects a notification flood and terminates its real worker', {
  timeout: 15000,
}, async (t) => {
  const game = await artifacts()
  const worker = new BrowserWorker()
  let disposal = null
  const session = new GameSession(worker, 15000, {
    disposed: (error) => {
      disposal = error
    },
  })
  t.after(async () => {
    session.dispose()
    worker.terminate()
    await worker.exited()
  })
  await session.request({ kind: 'startup', ...game }, [
    game.engine.buffer,
    game.iwad.buffer,
  ])
  await session.request({ kind: 'activity', activity: 'running', epoch: 0 })
  const frame = {
    kind: 'frame',
    activity: 'running',
    epoch: 0,
    turn: 0,
    held: [],
    taps: [],
    after: 0,
  }
  const first = await session.request(frame)
  const pending = session.request({ ...frame, after: first.update.sequence })
  for (let count = 0; count < 257; count++)
    worker.dispatchEvent(
      new MessageEvent('message', {
        data: { kind: 'audio', audio: first.update.audio },
      }),
    )
  await assert.rejects(pending, /notification budget/)
  assert.match(disposal.message, /notification budget/)
  assert.equal(session.disposed, true)
  assert.equal(await worker.exited(), -1)
})

test('audio outside an outstanding operation disposes the actual session', {
  timeout: 15000,
}, async (t) => {
  const game = await artifacts()
  const worker = new BrowserWorker()
  let disposal = null
  const session = new GameSession(worker, 15000, {
    disposed: (error) => {
      disposal = error
    },
  })
  t.after(async () => {
    session.dispose()
    worker.terminate()
    await worker.exited()
  })
  await session.request({ kind: 'startup', ...game }, [
    game.engine.buffer,
    game.iwad.buffer,
  ])
  await session.request({ kind: 'activity', activity: 'running', epoch: 0 })
  const reply = await session.request({
    kind: 'frame',
    activity: 'running',
    epoch: 0,
    turn: 0,
    held: [],
    taps: [],
    after: 0,
  })
  worker.dispatchEvent(
    new MessageEvent('message', {
      data: { kind: 'audio', audio: reply.update.audio },
    }),
  )
  assert.equal(session.disposed, true)
  assert.match(disposal.message, /without an outstanding operation/)
  assert.equal(await worker.exited(), -1)
})

test('the compiled worker rejects corrupted startup artifacts before publishing readiness', {
  timeout: 10000,
}, async (t) => {
  for (const role of ['engine', 'iwad']) {
    const game = await artifacts()
    game[role][100] ^= 1
    const worker = new BrowserWorker()
    const session = new GameSession(worker)
    t.after(async () => {
      session.dispose()
      worker.terminate()
      await worker.exited()
    })
    await assert.rejects(
      session.request({ kind: 'startup', ...game }, [
        game.engine.buffer,
        game.iwad.buffer,
      ]),
      /artifacts do not match/,
    )
    assert.equal(session.disposed, true)
    assert.equal(await worker.exited(), -1)
  }
})

test('timeouts and malformed replies terminate their actual workers', {
  timeout: 5000,
}, async (t) => {
  for (const mode of ['silent', 'malformed']) {
    const worker = new BrowserWorker({ mode })
    const session = new GameSession(worker, mode === 'silent' ? 80 : 2000)
    t.after(async () => {
      session.dispose()
      worker.terminate()
      await worker.exited()
    })
    const request = session.request({
      kind: 'activity',
      activity: 'running',
      epoch: 0,
    })
    await assert.rejects(
      session.request({ kind: 'activity', activity: 'paused', epoch: 0 }),
      /pending request/,
    )
    await assert.rejects(
      request,
      mode === 'silent' ? /stopped responding/ : /Invalid Doom payload/,
    )
    assert.equal(session.disposed, true)
    assert.equal(await worker.exited(), -1)
    await assert.rejects(
      session.request({ kind: 'activity', activity: 'paused', epoch: 0 }),
    )
  }
})

test('the exact bundled guest matches native pixels and literal Doom state', {
  timeout: 120000,
}, async () => {
  const { engine, iwad } = await artifacts()
  let vmTime = 100
  let nativeTime = 100
  const native = await reference(engine, iwad, () => nativeTime++)
  const nativeWebAssembly = globalThis.WebAssembly
  globalThis.WebAssembly = undefined
  try {
    const vm = boot(engine, iwad, () => vmTime++)
    const milestones = []
    function capture(label) {
      const state = vm.snapshot()
      assert.deepEqual(state, native.snapshot(), `${label} state`)
      const frame = vm.frame()
      const expected = native.frame()
      assert.deepEqual(frame, expected, `${label} RGBA`)
      const record = {
        label,
        state,
        rgbaSha256: frame ? digest(frame.pixels) : null,
        ammoSha256: frame ? digest(ammoMask(frame.pixels)) : null,
      }
      milestones.push(record)
      return frame
    }
    function step(count = 1) {
      for (let index = 0; index < count; index++) {
        vmTime += 30
        nativeTime += 30
        vm.step()
        native.step()
        assert.equal(vmTime, nativeTime, 'Host clock reads must match exactly.')
      }
    }
    function key(action, pressed) {
      vm.key(action, pressed)
      native.key(action, pressed)
    }
    function tap(action) {
      key(action, true)
      step()
      key(action, false)
      step()
    }
    step(2)
    const title = capture('title')
    assert.equal(title.width, 640)
    assert.equal(title.pixels.length, 1024000)
    for (const label of ['menu', 'episode', 'difficulty']) {
      tap('enter')
      capture(label)
    }
    tap('enter')
    step(8)
    const initial = capture('e1m1')
    const initialState = vm.snapshot()
    assert.deepEqual(
      [
        initialState[0],
        initialState[1],
        initialState[2],
        initialState[7],
        initialState[8],
      ],
      [0, 1, 1, 50, 100],
    )
    key('forward', true)
    step(10)
    key('forward', false)
    step()
    capture('moved')
    assert.notEqual(vm.snapshot()[5], initialState[5])
    tap('fire')
    step(8)
    const fired = capture('fired')
    assert.equal(vm.snapshot()[7], 49)
    assert.notEqual(
      digest(ammoMask(initial.pixels)),
      digest(ammoMask(fired.pixels)),
    )
    if (process.env.HIBI_DOOM_VM_PROOF_DIR) {
      const directory = process.env.HIBI_DOOM_VM_PROOF_DIR
      await mkdir(directory, { recursive: true })
      await writeFile(
        join(directory, 'guest-parity.json'),
        `${JSON.stringify(
          {
            engineSha256: digest(engine),
            iwadSha256: digest(iwad),
            milestones,
          },
          null,
          2,
        )}\n`,
      )
      await writeFile(join(directory, 'title.png'), encodePng(title.pixels))
      await writeFile(join(directory, 'e1m1.png'), encodePng(initial.pixels))
      await writeFile(join(directory, 'fired.png'), encodePng(fired.pixels))
    }
    assert.throws(() => vm.frame(vm.statistics.sequence + 1), /frame cursor/)
  } finally {
    globalThis.WebAssembly = nativeWebAssembly
  }
})

test('five fresh compiled workers latch taps, freeze active time, resume, and terminate', {
  timeout: 180000,
}, async (t) => {
  for (let trial = 0; trial < 5; trial++) {
    const { engine, iwad } = await artifacts()
    const worker = new BrowserWorker()
    const session = new GameSession(worker)
    t.after(async () => {
      session.dispose()
      worker.terminate()
      await worker.exited()
    })
    assert.deepEqual(
      await session.request({ kind: 'startup', engine, iwad }, [
        engine.buffer,
        iwad.buffer,
      ]),
      { id: 1, kind: 'ready', engine: 'doom' },
    )
    assert.equal(engine.byteLength, 0)
    assert.equal(iwad.byteLength, 0)
    await session.request({ kind: 'activity', activity: 'running', epoch: 0 })
    let after = 0
    let frame
    async function request(taps = [], held = []) {
      const reply = await session.request({
        kind: 'frame',
        activity: 'running',
        epoch: 0,
        turn: 0,
        held,
        taps,
        after,
      })
      assert.equal(reply.kind, 'update')
      if (reply.update.kind === 'frame') {
        frame = reply.update
        after = frame.sequence
      }
      return reply.update
    }
    async function advance(milliseconds) {
      const until = performance.now() + milliseconds
      do {
        await request()
        await delay(16)
      } while (performance.now() < until)
    }
    const titleBy = performance.now() + 10000
    while (!frame && performance.now() < titleBy) {
      await request()
      await delay(16)
    }
    assert.equal(frame.pixels.length, 1024000)
    await session.request({ kind: 'activity', activity: 'paused', epoch: 0 })
    const pausedRequest = {
      kind: 'frame',
      activity: 'paused',
      epoch: 0,
      turn: 0,
      held: [],
      taps: [],
      after,
    }
    const frozen = await session.request(pausedRequest)
    await delay(250)
    assert.deepEqual(await session.request(pausedRequest), {
      ...frozen,
      id: frozen.id + 1,
    })
    const resumeStartedAt = performance.now()
    await session.request({ kind: 'activity', activity: 'running', epoch: 0 })
    const resumed = await request()
    const activeWallMs = performance.now() - resumeStartedAt
    const resumedElapsedMs = resumed.elapsedMs - frozen.update.elapsedMs
    assert.ok(resumedElapsedMs >= 0)
    assert.ok(
      resumedElapsedMs <= Math.ceil(activeWallMs),
      `Trial ${trial + 1} must exclude paused wall time.`,
    )
    for (let index = 0; index < 4; index++) {
      await request(['enter'])
      await advance(220)
    }
    await advance(400)
    const initialAmmo = digest(ammoMask(frame.pixels))
    assert.equal(
      initialAmmo,
      '97379d2f3f1342b74993fad1b6b051091f8b6ecd333d1060ada9d754fdad38e9',
    )
    const beforeMove = digest(frame.pixels.subarray(0, 640 * 280 * 4))
    await request([], ['forward'])
    await delay(150)
    await request([], ['forward'])
    await request()
    assert.notEqual(digest(frame.pixels.subarray(0, 640 * 280 * 4)), beforeMove)
    await request(['fire'])
    await advance(220)
    assert.equal(
      digest(ammoMask(frame.pixels)),
      '238a985457932a1a9c15238b56f7db76ea83cdec362fb73a49b697dfa3b74a83',
      `Trial ${trial + 1} must fire exactly one round.`,
    )
    session.dispose()
    assert.equal(await worker.exited(), -1)
    await assert.rejects(
      session.request({ kind: 'activity', activity: 'paused', epoch: 0 }),
      /session ended/,
    )
  }
})
