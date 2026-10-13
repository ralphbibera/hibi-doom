import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import pins from '../engine/pins.json' with { type: 'json' }
import { fixtureDirectory, fixtureFeed } from '../scripts/download-iwad.mjs'
import { downloadIwad, IwadCache, parseIwadManifest } from '../src/iwad.ts'
import { cacheWriteRace } from './fixtures/cache-race.mjs'

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const tick = () => new Promise((resolve) => setImmediate(resolve))
const signal = () => new AbortController().signal
const feed = await fixtureFeed()

function response(url, files = feed.files) {
  const path = new URL(url).pathname.split('/').at(-1)
  return { ok: true, value: { url, status: 200, text: files.get(path) } }
}

function network(transform = (_, result) => result) {
  const requests = []
  return {
    requests,
    async getText(request) {
      assert.deepEqual(Object.keys(request), ['url'])
      requests.push(request.url)
      return transform(request.url, response(request.url))
    },
  }
}

function storage(
  initial = { status: 'missing', revision: 0 },
  saveStatus = 'saved',
) {
  const writes = []
  let snapshot = initial
  const handle = {
    snapshot: () => snapshot,
    async set(value) {
      writes.push(value)
      if (saveStatus !== 'saved')
        return { status: saveStatus, current: snapshot }
      snapshot = { status: 'ready', revision: snapshot.revision + 1, value }
      return { status: 'saved', revision: snapshot.revision, value }
    },
  }
  return {
    writes,
    handle,
    async global(key, version) {
      assert.equal(key, 'iwad-cache')
      assert.equal(version, 1)
      return handle
    },
  }
}

const context = (store, net) => ({ storage: store, host: { network: net } })
const cacheValue = () => ({
  schema: 1,
  bytes: pins.iwad.bytes,
  sha256: pins.iwad.sha256,
  base64: feed.bytes.toString('base64'),
})

test('first Play downloads exact bounded parts serially, verifies them, and commits only one complete cache', async () => {
  const net = network()
  const store = storage()
  const progress = []
  const data = await new IwadCache(context(store, net)).load(
    signal(),
    (value) => progress.push(value),
  )
  assert.equal(data.source, 'download')
  assert.equal(data.persistent, true)
  assert.deepEqual(data.bytes, Uint8Array.from(feed.bytes))
  assert.equal(digest(data.bytes), pins.iwad.sha256)
  assert.deepEqual(
    net.requests.map((url) => new URL(url).pathname.split('/').at(-1)),
    ['manifest.json', ...feed.parts.map((part) => part.path)],
  )
  assert.deepEqual(store.writes, [cacheValue()])
  assert.deepEqual(
    progress
      .filter((value) => value.kind === 'downloading')
      .map((value) => value.completedBytes),
    [
      0, 516096, 1032192, 1548288, 2064384, 2580480, 3096576, 3612672, 4128768,
      4196020,
    ],
  )
  assert.equal(progress.at(-1).kind, 'verifying')
})

test('a new cache owner revalidates persistent bytes and plays offline without any host request or write', async () => {
  const store = storage({ status: 'ready', revision: 7, value: cacheValue() })
  const net = network(() => {
    throw new Error('Offline network must not be called.')
  })
  for (let index = 0; index < 2; index++) {
    const result = await new IwadCache(context(store, net)).load(
      signal(),
      () => {},
    )
    assert.equal(result.source, 'cache')
    assert.equal(result.persistent, true)
    assert.equal(digest(result.bytes), pins.iwad.sha256)
    result.bytes[100] ^= 1
  }
  assert.equal(net.requests.length, 0)
  assert.equal(store.writes.length, 0)
})

test('corrupt cached bytes, malformed metadata, and noncanonical encoding require a verified replacement download', async () => {
  const valid = cacheValue()
  for (const value of [
    {
      ...valid,
      base64: `${valid.base64[0] === 'A' ? 'B' : 'A'}${valid.base64.slice(1)}`,
    },
    { ...valid, base64: `${valid.base64.slice(0, -1)}_` },
    { ...valid, bytes: valid.bytes - 1 },
    { ...valid, extra: true },
    { base64: 'truncated' },
  ]) {
    const store = storage({ status: 'ready', revision: 4, value })
    const net = network()
    const result = await new IwadCache(context(store, net)).load(
      signal(),
      () => {},
    )
    assert.equal(result.source, 'download')
    assert.equal(digest(result.bytes), pins.iwad.sha256)
    assert.equal(net.requests.length, 10)
    assert.deepEqual(store.writes, [valid])
  }
})

test('manifest validation rejects path escapes, extra fields, wrong counts, bounds, pins, encoding, and terms', () => {
  const valid = JSON.parse(feed.files.get('manifest.json'))
  for (const change of [
    { schema: 2 },
    { extra: true },
    { bytes: valid.bytes + 1 },
    { sha256: '0'.repeat(64) },
    { encoding: 'binary' },
    { license: 'GPL-3.0-only' },
    { terms: [] },
    { terms: [valid.terms.join(',')] },
    { parts: valid.parts.slice(1) },
    {
      parts: [
        { ...valid.parts[0], path: '../doom1-part-00.json' },
        ...valid.parts.slice(1),
      ],
    },
    {
      parts: [
        { ...valid.parts[0], path: 'https://example.com/data.json' },
        ...valid.parts.slice(1),
      ],
    },
    { parts: [{ ...valid.parts[0], bytes: 1048577 }, ...valid.parts.slice(1)] },
    {
      parts: [
        { ...valid.parts[0], sha256: 'not-a-digest' },
        ...valid.parts.slice(1),
      ],
    },
  ])
    assert.throws(() => parseIwadManifest({ ...valid, ...change }))
})

test('failed, redirected, oversized, truncated, noncanonical, and corrupted responses never save partial data', async () => {
  const part = feed.files.get('doom1-part-00.json')
  const encoded = JSON.parse(part).base64
  const broken = [
    (_, result) => ({ ...result, value: { ...result.value, status: 206 } }),
    (_, result) => ({
      ...result,
      value: {
        ...result.value,
        url: result.value.url.replace(
          'gist.githubusercontent.com',
          'example.com',
        ),
      },
    }),
    (_, result) => ({
      ...result,
      value: { ...result.value, text: `${result.value.text} ` },
    }),
    (_, result) => ({
      ...result,
      value: { ...result.value, text: result.value.text.slice(0, -1) },
    }),
    (_, result) => ({
      ...result,
      value: {
        ...result.value,
        text: `${JSON.stringify({ base64: `${encoded[0] === 'A' ? 'B' : 'A'}${encoded.slice(1)}` })}\n`,
      },
    }),
    (_, result) => ({
      ...result,
      value: {
        ...result.value,
        text: `${JSON.stringify({ base64: `${encoded.slice(0, -1)}_` })}\n`,
      },
    }),
    (_, result) => ({
      ...result,
      value: { ...result.value, text: ' '.repeat(1048577) },
    }),
    () => ({ ok: false, code: 'http-status', status: 404 }),
  ]
  for (const transform of broken) {
    const store = storage()
    const net = network((url, result) =>
      url.endsWith('/manifest.json') ? result : transform(url, result),
    )
    await assert.rejects(
      new IwadCache(context(store, net)).load(signal(), () => {}),
    )
    assert.equal(net.requests.length, 2)
    assert.equal(store.writes.length, 0)
  }
  for (const transform of [
    (_, result) => ({
      ...result,
      value: {
        ...result.value,
        text: result.value.text.replace('shareware', 'sharEware'),
      },
    }),
    () => ({ ok: false, code: 'timeout' }),
  ]) {
    const store = storage()
    const net = network(transform)
    await assert.rejects(
      new IwadCache(context(store, net)).load(signal(), () => {}),
    )
    assert.equal(net.requests.length, 1)
    assert.equal(store.writes.length, 0)
  }
})

test('a pinned manifest and IWAD digest allow legitimate same-origin revision redirects', async () => {
  const net = network((_, result) => ({
    ...result,
    value: {
      ...result.value,
      url: result.value.url.replace(
        '/8a5669e288bfa19ba9d08aaa0ba8be34f02113ef/',
        `/${'a'.repeat(40)}/`,
      ),
    },
  }))
  const result = await downloadIwad({ network: net, signal: signal() })
  assert.equal(digest(result.bytes), pins.iwad.sha256)
  assert.equal(net.requests.length, 10)
})

test('unavailable storage and compare-and-set failures permit verified play without claiming an offline cache', async () => {
  for (const store of [
    storage({ status: 'unavailable', reason: 'corrupt' }),
    storage({
      status: 'version-mismatch',
      revision: 4,
      storedVersion: 2,
      value: {},
    }),
    storage(undefined, 'conflict'),
    {
      async global() {
        throw new Error('Storage unavailable.')
      },
    },
  ]) {
    const result = await new IwadCache(context(store, network())).load(
      signal(),
      () => {},
    )
    assert.equal(result.persistent, false)
    assert.equal(result.source, 'download')
    assert.equal(digest(result.bytes), pins.iwad.sha256)
  }
  const store = storage(undefined, 'conflict')
  await assert.rejects(
    new IwadCache(context(store, network())).clear(),
    /could not clear/,
  )
})

test('Close and disable ignore late host responses, schedule no subsequent chunks, and perform no cache write', async () => {
  for (const disabled of [false, true]) {
    let release
    const store = storage()
    const net = network((url, result) =>
      url.endsWith('/doom1-part-00.json')
        ? new Promise((resolve) => {
            release = () =>
              resolve(disabled ? { ok: false, code: 'stale' } : result)
          })
        : result,
    )
    const abort = new AbortController()
    const progress = []
    const loading = new IwadCache(context(store, net)).load(
      abort.signal,
      (value) => progress.push(value),
    )
    while (!release) await tick()
    const published = progress.length
    abort.abort()
    release()
    await assert.rejects(loading, { name: 'AbortError' })
    assert.equal(progress.length, published)
    assert.equal(net.requests.length, 2)
    assert.equal(store.writes.length, 0)
  }
})

test('clearing data invalidates a pending chunk and waits for an already-started save before clearing the cache', async () => {
  let release
  const store = storage()
  const net = network((url, result) =>
    url.endsWith('/doom1-part-00.json')
      ? new Promise((resolve) => {
          release = () => resolve(result)
        })
      : result,
  )
  const cache = new IwadCache(context(store, net))
  const loading = cache.load(signal(), () => {})
  while (!release) await tick()
  await cache.clear()
  release()
  await assert.rejects(loading, /was cleared/)
  assert.equal(net.requests.length, 2)
  assert.deepEqual(store.writes, [null])

  const pending = storage()
  const write = pending.handle.set
  let finishSave
  pending.handle.set = (value) =>
    value === null
      ? write(value)
      : new Promise((resolve) => {
          finishSave = async () => resolve(await write(value))
        })
  const saving = new IwadCache(context(pending, network()))
  const game = saving.load(signal(), () => {})
  while (!finishSave) await tick()
  const clearing = saving.clear()
  await tick()
  assert.equal(pending.writes.length, 0)
  await finishSave()
  await assert.rejects(game, /was cleared/)
  await clearing
  assert.deepEqual(pending.writes, [cacheValue(), null])
  assert.equal(pending.handle.snapshot().value, null)
})

test('Close, reopen, and Clear serialize pending cache writes with the SDK compare-and-set revision contract', async () => {
  assert.deepEqual(await cacheWriteRace(IwadCache), {
    writes: 2,
    finalRevision: 2,
    finalValue: null,
    cacheCleared: true,
  })
})

test('developer fixture paths reject checkout descendants, misleading parent prefixes, and symlink aliases before data writes', async () => {
  const directory = await fixtureDirectory(
    process.env.HIBI_DOOM_FIXTURE_DIR ??
      join(tmpdir(), 'hibi-doom-shareware-cache'),
  )
  const scratch = await mkdtemp(join(directory, 'boundary-'))
  try {
    const checkout = join(scratch, 'checkout')
    const outside = join(scratch, 'outside')
    await mkdir(checkout)
    for (const destination of [
      checkout,
      join(checkout, 'fixtures'),
      join(checkout, '..fixtures'),
    ])
      await assert.rejects(
        fixtureDirectory(destination, checkout),
        /outside the source checkout/,
      )
    const alias = join(scratch, 'alias')
    await symlink(checkout, alias, 'dir')
    await assert.rejects(
      fixtureDirectory(alias, checkout),
      /outside the source checkout/,
    )
    assert.equal(
      await fixtureDirectory(outside, checkout),
      await realpath(outside),
    )
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})
