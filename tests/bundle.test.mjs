import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { loadArtifact, parseBundle, readPackageFile } from '../src/bundle.ts'
import {
  parseEngineBytes,
  parseIwadBytes,
  validateGame,
} from '../src/runtime.ts'
import { SourceExport } from '../src/source-export.ts'
import { createWasiHost } from '../src/wasi.ts'
import {
  artifacts,
  bundleMetadata,
  packageBase,
  packageFetch,
} from './fixtures/artifacts.mjs'

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const signal = () => new AbortController().signal

test('bounded installed chunks reconstruct code and source without requesting game data', async () => {
  const bundle = await bundleMetadata()
  const requests = []
  const read = async (url, options) => {
    requests.push(String(url))
    return packageFetch(url, options)
  }
  const engine = await loadArtifact(bundle.engine, packageBase, signal(), read)
  const { iwad } = await artifacts()
  await validateGame(engine, iwad)
  const source = await loadArtifact(bundle.source, packageBase, signal(), read)
  assert.equal(digest(source), bundle.source.sha256)
  assert.equal(source[0], 31)
  assert.equal(source[1], 139)
  assert.equal(
    requests.length,
    bundle.engine.chunks.length + bundle.source.chunks.length,
  )
  assert(
    requests.every((url) => url.startsWith(new URL('.', packageBase).href)),
  )
  assert.equal(
    requests.some((url) => url.includes('/iwad/')),
    false,
  )
  assert.equal(Object.hasOwn(bundle.iwad, 'chunks'), false)
})

test('metadata rejects unknown schema, unsafe paths, extra fields, and inconsistent extents', async () => {
  const input = await bundleMetadata()
  for (const change of [
    { schema: 3 },
    { network: true },
    { engine: { ...input.engine, extra: true } },
    { source: { ...input.source, bytes: 16777217 } },
    { iwad: { ...input.iwad, sha256: 'not-a-digest' } },
    {
      engine: {
        ...input.engine,
        chunks: [
          { ...input.engine.chunks[0], path: 'https://example.com/runtime' },
        ],
      },
    },
    {
      engine: {
        ...input.engine,
        chunks: [
          { ...input.engine.chunks[0], path: 'assets/engine/../000.json' },
        ],
      },
    },
    {
      engine: {
        ...input.engine,
        chunks: [{ ...input.engine.chunks[0], decodedBytes: 3145729 }],
      },
    },
    { engine: { ...input.engine, bytes: input.engine.bytes - 1 } },
    {
      engine: {
        ...input.engine,
        chunks: [...input.engine.chunks, input.engine.chunks[0]],
      },
    },
  ])
    assert.throws(() => parseBundle({ ...input, ...change }))
})

test('missing, oversize, truncated, noncanonical, and corrupt parts fail before startup', async () => {
  const bundle = await bundleMetadata()
  const chunk = bundle.engine.chunks[0]
  const actual = await (
    await packageFetch(new URL(chunk.path, packageBase))
  ).text()
  const valid = JSON.parse(actual)
  const altered = JSON.stringify({
    base64: (valid.base64[0] === 'A' ? 'B' : 'A') + valid.base64.slice(1),
  })
  const fixtures = [
    new Response(null, { status: 404 }),
    new Response(actual, {
      headers: { 'content-length': String(chunk.jsonBytes + 1) },
    }),
    new Response(`${actual} `),
    new Response(actual.slice(0, -1)),
    new Response(altered),
    new Response(JSON.stringify({ base64: `${valid.base64.slice(0, -1)}_` })),
    new Response(' '.repeat(chunk.jsonBytes)),
  ]
  for (const response of fixtures)
    await assert.rejects(
      loadArtifact(bundle.engine, packageBase, signal(), async () => response),
    )
  await assert.rejects(
    loadArtifact(
      { ...bundle.engine, sha256: '0'.repeat(64) },
      packageBase,
      signal(),
      packageFetch,
    ),
    /artifact digest/,
  )
  await assert.rejects(
    readPackageFile(
      'https://example.com/000.json',
      1,
      packageBase,
      signal(),
      packageFetch,
    ),
    /outside/,
  )
})

test('abort cancels a stalled stream and discards a response arriving after close', async () => {
  const bundle = await bundleMetadata()
  const abort = new AbortController()
  let canceled = false
  const stalled = new Response(
    new ReadableStream({
      cancel() {
        canceled = true
      },
    }),
  )
  const loading = loadArtifact(
    bundle.engine,
    packageBase,
    abort.signal,
    async () => stalled,
  )
  await new Promise((resolve) => setImmediate(resolve))
  abort.abort()
  await assert.rejects(loading, { name: 'AbortError' })
  assert.equal(canceled, true)
  const lateAbort = new AbortController()
  let release
  const late = loadArtifact(
    bundle.engine,
    packageBase,
    lateAbort.signal,
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  lateAbort.abort()
  release(
    await packageFetch(new URL(bundle.engine.chunks[0].path, packageBase)),
  )
  await assert.rejects(late, { name: 'AbortError' })
})

test('engine and IWAD boundaries reject malformed bytes and unchanged-size corruption', async () => {
  const { engine, iwad } = await artifacts()
  assert.throws(() => parseEngineBytes(engine.buffer))
  assert.throws(() => parseEngineBytes(engine.subarray(1)))
  const badEngine = engine.slice()
  badEngine[0] = 255
  assert.throws(() => parseEngineBytes(badEngine))
  const changed = iwad.slice()
  changed[100] ^= 1
  await assert.rejects(validateGame(engine, changed), /artifacts do not match/)
  const badDirectory = iwad.slice()
  new DataView(badDirectory.buffer).setInt32(8, iwad.length, true)
  assert.throws(() => parseIwadBytes(badDirectory), /directory/)
  const badLump = iwad.slice()
  const directory = new DataView(badLump.buffer).getInt32(8, true)
  new DataView(badLump.buffer).setInt32(directory, iwad.length + 1, true)
  assert.throws(() => parseIwadBytes(badLump), /lump/)
})

test('source export validates before choosing and cancels busy, conflict, and late grants', async () => {
  const bundle = await bundleMetadata()
  for (const outcome of ['busy', 'conflict', 'success', 'cancel', 'late']) {
    const events = []
    const states = []
    let exporter
    const io = {
      async selectExport(choice) {
        events.push(['choose', choice])
        if (outcome === 'cancel') return { ok: true, value: null }
        if (outcome === 'late') exporter.dispose()
        return {
          ok: true,
          value: { handle: 'source-grant', name: choice.suggestedName },
        }
      },
      async writeExport(handle, bytes) {
        events.push(['write', handle, digest(bytes)])
        return outcome === 'busy' || outcome === 'conflict'
          ? { ok: false, code: outcome }
          : { ok: true, value: { bytes: bytes.length } }
      },
      async cancel(handle) {
        events.push(['cancel', handle])
        return { ok: true, value: null }
      },
    }
    let readBytes = 0
    exporter = new SourceExport(
      io,
      bundle.source,
      packageBase,
      (state) => states.push(state),
      async (url, options) => {
        const response = await packageFetch(url, options)
        readBytes += Number(response.headers.get('content-length'))
        return response
      },
    )
    await exporter.save()
    assert(readBytes > bundle.source.bytes)
    assert.equal(events[0][0], 'choose')
    if (outcome === 'cancel') assert.equal(events.length, 1)
    else assert.deepEqual(events.at(-1), ['cancel', 'source-grant'])
    if (outcome === 'late')
      assert.equal(
        events.some(([kind]) => kind === 'write'),
        false,
      )
    else if (outcome !== 'cancel')
      assert.equal(
        events.find(([kind]) => kind === 'write')[2],
        bundle.source.sha256,
      )
    if (outcome === 'busy' || outcome === 'conflict')
      assert.equal(states.at(-1).kind, 'failed')
    if (outcome === 'success') assert.equal(states.at(-1).kind, 'saved')
    exporter.dispose()
  }
  let chose = false
  const failed = new SourceExport(
    {
      async selectExport() {
        chose = true
      },
    },
    bundle.source,
    packageBase,
    () => {},
    async () => new Response(null, { status: 404 }),
  )
  await failed.save()
  assert.equal(chose, false)
  failed.dispose()
})

test('WASI permits only bounded reads of doom1.wad and sleep does not advance the clock', async () => {
  const { iwad } = await artifacts()
  const original = digest(iwad)
  const memory = new ArrayBuffer(1024)
  const bytes = new Uint8Array(memory)
  const view = new DataView(memory)
  let time = 10
  const host = createWasiHost(
    iwad,
    () => memory,
    () => time,
  )
  const wasi = host.imports.wasi_snapshot_preview1
  host.imports.hibi.sleep_ms(100)
  assert.equal(host.imports.hibi.clock_ms(), 10)
  time = 20
  assert.equal(host.imports.hibi.clock_ms(), 20)
  function open(name, rights = 2n) {
    bytes.set(new TextEncoder().encode(name), 0)
    return wasi.path_open(3, 0, 0, name.length, 0, rights, 0n, 0, 128)
  }
  for (const path of [
    '../doom1.wad',
    '/doom1.wad',
    'savegame.dsg',
    'config.cfg',
  ])
    assert.equal(open(path), 44)
  assert.equal(open('doom1.wad', 1n << 6n), 76)
  assert.equal(open('doom1.wad'), 0)
  const fd = view.getUint32(128, true)
  view.setUint32(200, 300, true)
  view.setUint32(204, 12, true)
  assert.equal(wasi.fd_read(fd, 200, 1, 208), 0)
  assert.equal(view.getUint32(208, true), 12)
  assert.equal(new TextDecoder().decode(bytes.subarray(300, 304)), 'IWAD')
  assert.equal(wasi.fd_seek(fd, -1n, 0, 208), 28)
  assert.equal(wasi.fd_seek(fd, BigInt(iwad.length) + 1n, 0, 208), 28)
  assert.equal(wasi.fd_write(fd, 200, 1, 208), 76)
  for (const mutate of [
    wasi.path_create_directory,
    wasi.path_remove_directory,
    wasi.path_rename,
    wasi.path_unlink_file,
  ])
    assert.equal(mutate(), 76)
  assert.throws(() => wasi.proc_exit(0), /exited/)
  assert.throws(() => wasi.fd_read(fd, 1000, 64, 208), /extent/)
  assert.equal(wasi.fd_close(fd), 0)
  assert.equal(wasi.fd_read(fd, 200, 1, 208), 8)
  assert.equal(digest(iwad), original)
})

test('a busy source write remains busy until delayed grant cancellation finishes', async () => {
  const bundle = await bundleMetadata()
  let reads = 0
  let choices = 0
  let writes = 0
  let releaseCancel
  const states = []
  const io = {
    async selectExport() {
      choices++
      return { ok: true, value: { handle: 'delayed-grant', name: 'source.gz' } }
    },
    async writeExport() {
      writes++
      return { ok: false, code: 'busy' }
    },
    cancel() {
      return new Promise((resolve) => {
        releaseCancel = () => resolve({ ok: true, value: null })
      })
    },
  }
  const exporter = new SourceExport(
    io,
    bundle.source,
    packageBase,
    (state) => states.push(state),
    async (url) => {
      reads++
      return packageFetch(url)
    },
  )
  const first = exporter.save()
  while (!releaseCancel) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(states.at(-1).kind, 'cleanup')
  const initialReads = reads
  await exporter.save()
  assert.equal(reads, initialReads)
  assert.equal(choices, 1)
  assert.equal(writes, 1)
  releaseCancel()
  await first
  assert.equal(states.at(-1).kind, 'failed')
  assert.match(states.at(-1).message, /Finish the current file operation/)
  exporter.dispose()
})

test('disposing source loading aborts its stream before requesting a destination', async () => {
  const bundle = await bundleMetadata()
  let canceled = false
  let chose = false
  const states = []
  const exporter = new SourceExport(
    {
      async selectExport() {
        chose = true
      },
    },
    bundle.source,
    packageBase,
    (state) => states.push(state),
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            canceled = true
          },
        }),
      ),
  )
  const loading = exporter.save()
  await new Promise((resolve) => setImmediate(resolve))
  exporter.dispose()
  await loading
  assert.equal(canceled, true)
  assert.equal(chose, false)
  assert.deepEqual(
    states.map((state) => state.kind),
    ['loading'],
  )
})
