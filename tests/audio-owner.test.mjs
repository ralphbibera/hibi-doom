import assert from 'node:assert/strict'
import test from 'node:test'
import { GameAudio } from '../src/audio.ts'

// Node has no browser audio graph. Native output and lifecycle are also checked in stock Hibi.
function browserAudio({ deferred = false } = {}) {
  const contexts = []
  class Param {
    value = 1
    setValueAtTime(value) {
      this.value = value
    }
  }
  class Node {
    disconnected = false
    gain = new Param()
    connect() {}
    disconnect() {
      this.disconnected = true
    }
  }
  class Context {
    state = deferred ? 'suspended' : 'running'
    currentTime = 0
    destination = new Node()
    sources = []
    buffers = []
    resumes = []
    closes = 0
    constructor() {
      contexts.push(this)
    }
    createGain() {
      return new Node()
    }
    createChannelMerger() {
      return new Node()
    }
    createBuffer(_channels, length, rate) {
      const mono = new Float32Array(length)
      const buffer = { rate, getChannelData: () => mono }
      this.buffers.push(buffer)
      return buffer
    }
    createBufferSource() {
      const node = new Node()
      node.onended = null
      node.stopped = false
      node.start = (when, offset) => {
        node.startTime = when
        node.offset = offset
      }
      node.stop = () => {
        node.stopped = true
      }
      this.sources.push(node)
      return node
    }
    resume() {
      if (!deferred) {
        this.state = 'running'
        return Promise.resolve()
      }
      return new Promise((resolve) =>
        this.resumes.push(() => {
          if (this.state !== 'closed') this.state = 'running'
          resolve()
        }),
      )
    }
    suspend() {
      this.state = 'suspended'
      return Promise.resolve()
    }
    close() {
      this.closes++
      this.state = 'closed'
      return Promise.resolve()
    }
  }
  const originalContext = Object.getOwnPropertyDescriptor(
    globalThis,
    'AudioContext',
  )
  const originalNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    'navigator',
  )
  Object.defineProperty(globalThis, 'AudioContext', {
    configurable: true,
    value: Context,
  })
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userActivation: { isActive: true } },
  })
  return {
    contexts,
    restore() {
      if (originalContext)
        Object.defineProperty(globalThis, 'AudioContext', originalContext)
      else delete globalThis.AudioContext
      if (originalNavigator)
        Object.defineProperty(globalThis, 'navigator', originalNavigator)
      else delete globalThis.navigator
    },
  }
}
function bank() {
  const bytes = new Uint8Array(11025).fill(128)
  bytes.set([0, 128, 255])
  return {
    samples: new Map([
      [7, { name: 'test', rate: 11025, bytes, durationMs: 1000 }],
    ]),
    scores: new Map(),
    instruments: [],
  }
}
function scene(epoch, generation, at, startedAt = 0) {
  const voices = Array.from({ length: 8 }, () => null)
  voices[0] = {
    channel: 0,
    generation,
    sample: 7,
    startedAt,
    endsAt: startedAt + 1000,
    volume: 127,
    separation: 128,
  }
  return { epoch, revision: generation, at, voices, music: { kind: 'stopped' } }
}

test('audio owner keeps the bank, starts at the current offset and ignores stale source completion', async () => {
  const browser = browserAudio()
  const audio = new GameAudio(bank())
  try {
    assert.deepEqual(audio.availability, { kind: 'waiting' })
    audio.setActivity('running', 0)
    assert.equal(browser.contexts.length, 0)
    audio.activate()
    audio.apply(scene(0, 1, 100))
    const context = browser.contexts[0]
    const original = context.sources[0]
    const ended = original.onended
    assert.equal(original.offset, 0.1)
    assert.deepEqual(
      Array.from(context.buffers[0].getChannelData(0).subarray(0, 3)),
      [-1, 0, 127 / 128],
    )
    audio.apply(scene(0, 2, 200, 200))
    assert.equal(original.stopped, true)
    assert.equal(original.disconnected, true)
    ended()
    audio.apply(scene(0, 2, 210, 200))
    assert.equal(context.sources.length, 2)
    audio.apply(scene(1, 9, 300, 300))
    assert.equal(context.sources.length, 2)
    audio.setActivity('paused', 1)
    assert.equal(context.sources[1].stopped, true)
    assert.equal(context.state, 'suspended')
    audio.apply(scene(0, 3, 310, 300))
    assert.equal(context.sources.length, 2)
    audio.setActivity('running', 1)
    audio.apply(scene(1, 3, 400, 300))
    assert.equal(context.sources.length, 3)
    assert.equal(context.buffers.length, 1)
    assert.equal(context.sources[2].offset, 0.1)
    audio.setPreference(true, 0.4)
    assert.deepEqual(audio.availability, { kind: 'muted' })
    assert.equal(context.sources[2].stopped, true)
    audio.dispose()
    await Promise.resolve()
    assert.deepEqual(audio.availability, { kind: 'closed' })
    assert.equal(context.state, 'closed')
    assert.ok(context.sources.every((source) => source.disconnected))
  } finally {
    audio.dispose()
    browser.restore()
  }
})

test('a resume completing after pause and disposal cannot recreate output', async () => {
  const browser = browserAudio({ deferred: true })
  const audio = new GameAudio(bank())
  try {
    audio.setActivity('running', 0)
    audio.activate()
    audio.apply(scene(0, 1, 100))
    const context = browser.contexts[0]
    audio.setActivity('paused', 1)
    audio.dispose()
    for (const resolve of context.resumes) resolve()
    await Promise.resolve()
    await Promise.resolve()
    assert.deepEqual(audio.availability, { kind: 'closed' })
    assert.equal(context.state, 'closed')
    assert.equal(context.sources.length, 0)
    assert.ok(context.closes >= 1)
    audio.activate()
    audio.apply(scene(1, 2, 200))
    assert.equal(browser.contexts.length, 1)
    assert.equal(context.sources.length, 0)
  } finally {
    audio.dispose()
    browser.restore()
  }
})
