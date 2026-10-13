import assert from 'node:assert/strict'
import pins from '../../engine/pins.json' with { type: 'json' }
import { fixtureFeed } from '../../scripts/download-iwad.mjs'

export async function cacheWriteRace(IwadCache) {
  const feed = await fixtureFeed()
  const calls = []
  let revision = 0
  let observedRevision = 0
  let value = null
  let releaseFirst
  let completedWholes = 0
  let verifiedSecond
  const secondVerified = new Promise((resolve) => {
    verifiedSecond = resolve
  })
  const originalDigest = crypto.subtle.digest
  crypto.subtle.digest = async function (algorithm, bytes) {
    const result = await originalDigest.call(this, algorithm, bytes)
    if (bytes.byteLength === pins.iwad.bytes && ++completedWholes === 2)
      verifiedSecond()
    return result
  }
  const handle = {
    snapshot: () =>
      revision === 0
        ? { status: 'missing', revision: 0 }
        : { status: 'ready', revision, value },
    async set(next) {
      const baseRevision = observedRevision
      calls.push(next)
      if (calls.length === 1)
        await new Promise((resolve) => {
          releaseFirst = resolve
        })
      if (baseRevision !== revision) {
        observedRevision = revision
        return { status: 'conflict', current: this.snapshot() }
      }
      value = next
      observedRevision = ++revision
      return { status: 'saved', revision, value }
    },
  }
  const context = {
    storage: {
      async global() {
        return handle
      },
    },
    host: {
      network: {
        async getText({ url }) {
          return {
            ok: true,
            value: {
              url,
              status: 200,
              text: feed.files.get(new URL(url).pathname.split('/').at(-1)),
            },
          }
        },
      },
    },
  }
  const owner = new IwadCache(context)
  const closed = new AbortController()
  const first = owner.load(closed.signal, () => {})
  first.catch(() => {})
  let second
  let clearing
  try {
    while (!releaseFirst) await new Promise((resolve) => setImmediate(resolve))
    closed.abort()
    second = owner.load(new AbortController().signal, () => {})
    second.catch(() => {})
    await secondVerified
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(
      calls.length,
      1,
      'A reopened game must wait for the earlier cache write.',
    )
    clearing = owner.clear()
    clearing.catch(() => {})
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(
      calls.length,
      1,
      'Clear must wait for the earlier cache write.',
    )
    releaseFirst()
    await assert.rejects(first, { name: 'AbortError' })
    await assert.rejects(second, /was cleared/)
    await clearing
    assert.equal(calls.length, 2)
    assert.equal(calls[1], null)
    assert.equal(handle.snapshot().value, null)
    return {
      writes: calls.length,
      finalRevision: revision,
      finalValue: value,
      cacheCleared: true,
    }
  } finally {
    crypto.subtle.digest = originalDigest
    releaseFirst?.()
    await Promise.allSettled([first, second, clearing].filter(Boolean))
  }
}
